-- Card pictures, so the Discord bot can show the card itself instead of text.
-- Run after 008_bot_schedule.sql. Safe to run again.
--
-- The site draws the front of your card in your browser (the same way "Download PNG" does) and
-- uploads it to the public "card-images" bucket, in your own folder. It does this right after
-- you save, and when you open the site and your picture is missing or out of date.
-- Each card version keeps its own picture. Editing a version that hasn't been traded yet clears
-- its picture, and your browser draws a new one.

-- ---------- storage ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-images', 'card-images', true, 2097152, array['image/webp', 'image/png'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/webp', 'image/png'];

drop policy if exists "card images read" on storage.objects;
create policy "card images read" on storage.objects for select to authenticated
  using (bucket_id = 'card-images');

drop policy if exists "card images upload own" on storage.objects;
create policy "card images upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "card images update own" on storage.objects;
create policy "card images update own" on storage.objects for update to authenticated
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "card images delete own" on storage.objects;
create policy "card images delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'card-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- moderators may clear anyone's pictures (removing a portrait makes the picture wrong anyway)
drop policy if exists "card images delete admin" on storage.objects;
create policy "card images delete admin" on storage.objects for delete to authenticated
  using (bucket_id = 'card-images' and public.is_admin());

-- ---------- which picture belongs to which version ----------

alter table public.card_versions add column if not exists image_url text;

-- Any change to a version's card text (an edit before it's traded, or a moderator removing the
-- portrait) makes its picture wrong, so the picture is cleared until a new one is drawn.
create or replace function public._card_image_stale()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.data is distinct from old.data and new.image_url is not distinct from old.image_url then
    new.image_url := null;
  end if;
  return new;
end $$;

drop trigger if exists card_image_stale on public.card_versions;
create trigger card_image_stale before update on public.card_versions
  for each row execute function public._card_image_stale();

-- Your browser calls this after uploading a picture of one of your own card's versions.
create or replace function public.set_card_image(p_version integer, p_url text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_card uuid;
begin
  if me is null then raise exception 'Sign in first'; end if;
  select id into v_card from public.cards where creator_id = me;
  if v_card is null then raise exception 'Make your card first'; end if;
  if p_url is not null and p_url !~ ('^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/card-images/'
                                     || me::text || '/[A-Za-z0-9_.-]+\.(webp|png)$') then
    raise exception 'That picture link isn''t allowed';
  end if;
  update public.card_versions set image_url = p_url where card_id = v_card and version = p_version;
  if not found then raise exception 'That version doesn''t exist'; end if;
end $$;

revoke all on function public._card_image_stale() from public, anon, authenticated;
revoke all on function public.set_card_image(integer, text) from public, anon;
grant execute on function public.set_card_image(integer, text) to authenticated;

-- ---------- the bot gets the picture too ----------

-- Same as in 007_bot.sql, plus each version's picture (imageUrl).
create or replace function public.bot_claim_feed(p_key text, p_limit integer default 30, p_settle interval default interval '5 seconds')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  st public.bot_state;
  v_cutoff timestamptz;
  v_events jsonb;
begin
  select * into st from public.bot_state where id for update;
  if st.id is null or p_key is null or p_key <> st.feed_key then
    raise exception 'Wrong feed key';
  end if;

  select max(e.happened_at) into v_cutoff from (
    select a.happened_at from public._activity_events(st.feed_after, now() - p_settle, null) a
    order by a.happened_at
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) e;
  if v_cutoff is null then
    return jsonb_build_object('events', '[]'::jsonb, 'players', '{}'::jsonb, 'cards', '{}'::jsonb,
      'versions', '{}'::jsonb, 'commands_version', st.commands_version);
  end if;

  select jsonb_agg(to_jsonb(a) order by a.happened_at, a.kind) into v_events
  from public._activity_events(st.feed_after, null, null) a
  where a.happened_at <= v_cutoff;

  update public.bot_state set feed_after = v_cutoff where id;

  return jsonb_build_object(
    'events', v_events,
    'players', (select coalesce(jsonb_object_agg(p.id, p.username), '{}'::jsonb) from public.profiles p
      where p.id in (select (x ->> 'actor')::uuid from jsonb_array_elements(v_events) x
                     union select (x ->> 'other')::uuid from jsonb_array_elements(v_events) x)),
    'cards', (select coalesce(jsonb_object_agg(c.id, jsonb_build_object('name', c.data ->> 'name', 'creator_id', c.creator_id)), '{}'::jsonb)
      from public.cards c
      where c.id in (select (x ->> 'card_id')::uuid from jsonb_array_elements(v_events) x
                     union select (m ->> 'card_id')::uuid from jsonb_array_elements(v_events) x,
                       jsonb_array_elements((x -> 'to_other') || (x -> 'to_actor')) m)),
    'versions', (select coalesce(jsonb_object_agg(v.card_id || ':' || v.version,
                   public._bot_card_data(v.data) || jsonb_build_object('imageUrl', v.image_url)), '{}'::jsonb)
      from public.card_versions v
      join jsonb_array_elements(v_events) x on (x ->> 'card_id')::uuid = v.card_id and (x ->> 'version')::int = v.version),
    'commands_version', st.commands_version);
end $$;

-- Same as in 007_bot.sql, plus the current version's picture (image_url).
create or replace function public.bot_player(p_discord_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'player', jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url, 'created_at', p.created_at),
    'card', case when c.id is null then null else jsonb_build_object(
      'id', c.id,
      'hidden', c.hidden,
      'version', c.current_version,
      'data', case when c.hidden then null else public._bot_card_data(c.data) end,
      'image_url', case when c.hidden then null else
        (select v.image_url from public.card_versions v where v.card_id = c.id and v.version = c.current_version) end,
      'traded_out', (select coalesce(sum(v.original2_given::int + v.copies_minted), 0) from public.card_versions v where v.card_id = c.id),
      'owners', (select count(distinct i.owner_id) from public.items i where i.card_id = c.id and i.owner_id <> p.id)) end,
    'held', (select count(*) from public.items i join public.cards ic on ic.id = i.card_id where i.owner_id = p.id and not ic.hidden),
    'collected', (select count(distinct i.card_id) from public.items i join public.cards ic on ic.id = i.card_id
                  where i.owner_id = p.id and not ic.hidden and ic.creator_id <> p.id),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'card_id', x.card_id, 'name', x.name, 'maker', x.maker, 'own', x.own, 'edition', x.edition,
                'serial', x.serial, 'version', x.version, 'msgCount', x.msg_count)
              order by x.own, x.edition desc, lower(x.name), x.version, x.serial), '[]'::jsonb)
              from (select i.card_id, ic.data ->> 'name' as name, mk.username as maker, ic.creator_id = p.id as own,
                           i.edition, i.serial, v.version, v.data -> 'msgCount' as msg_count
                    from public.items i
                    join public.cards ic on ic.id = i.card_id
                    join public.card_versions v on v.id = i.version_id
                    join public.profiles mk on mk.id = ic.creator_id
                    where i.owner_id = p.id and not ic.hidden) x))
  from auth.identities ai
  join public.profiles p on p.id = ai.user_id
  left join public.cards c on c.creator_id = p.id
  where ai.provider = 'discord' and ai.provider_id = p_discord_id
  limit 1;
$$;

revoke all on function public.bot_claim_feed(text, integer, interval) from public, anon, authenticated;
revoke all on function public.bot_player(text) from public, anon, authenticated;
grant execute on function public.bot_claim_feed(text, integer, interval) to service_role;
grant execute on function public.bot_player(text) to service_role;
