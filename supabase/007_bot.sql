-- Player Cards Discord bot: what the bot reads from the database.
-- Run after 006_activity.sql. Safe to run again. (008_bot_schedule.sql comes after the bot is deployed.)
--
-- The bot is a Supabase Edge Function (supabase/functions/discord-bot) that signs in with the
-- service role. Everything below is closed to the site: players can't read the bot's tables or
-- call these functions. The bot only ever posts what the Activity tab already shows everyone:
-- new cards, new versions and what changed hands in finished trades. Never trade messages,
-- open offers or hidden cards.

-- ---------- activity events, shared by the site's feed and the bot ----------

-- Same events as before, now also filterable by "after", so the bot can pick up where it left off.
create or replace function public._activity_events(p_after timestamptz, p_before timestamptz, p_player uuid)
returns table (kind text, happened_at timestamptz, actor uuid, other uuid, card_id uuid, version integer, to_other jsonb, to_actor jsonb)
language sql stable security definer set search_path = public as $$
  with ev as (
    select case when v.version = 1 then 'card' else 'version' end as kind, v.created_at as happened_at,
           c.creator_id as actor, null::uuid as other, c.id as card_id, v.version,
           '[]'::jsonb as to_other, '[]'::jsonb as to_actor
    from public.card_versions v
    join public.cards c on c.id = v.card_id
    where not c.hidden
    union all
    select 'trade', t.resolved_at, t.from_user, t.to_user, null, null,
           public._moved_items(t.offer_items, t.offer_mint, t.from_user, t.resolved_at),
           public._moved_items(t.request_items, t.request_mint, t.to_user, t.resolved_at)
    from public.trades t
    where t.status = 'accepted' and t.resolved_at is not null
      and (p_after is null or t.resolved_at > p_after)
      and (p_before is null or t.resolved_at < p_before)
      and (p_player is null or p_player in (t.from_user, t.to_user))
  )
  select * from ev
  where (p_after is null or ev.happened_at > p_after)
    and (p_before is null or ev.happened_at < p_before)
    and (p_player is null or p_player in (ev.actor, ev.other))
    and (ev.kind <> 'trade' or ev.to_other <> '[]'::jsonb or ev.to_actor <> '[]'::jsonb);
$$;

-- The site's feed, unchanged from the outside.
create or replace function public.activity_feed(p_before timestamptz default null, p_limit integer default 40, p_player uuid default null)
returns table (kind text, happened_at timestamptz, actor uuid, other uuid, card_id uuid, version integer, to_other jsonb, to_actor jsonb)
language sql stable security definer set search_path = public as $$
  select e.* from public._activity_events(null, p_before, p_player) e
  where auth.uid() is not null
  order by e.happened_at desc
  limit least(greatest(coalesce(p_limit, 40), 1), 100);
$$;

-- ---------- the bot's own tables ----------

-- One row. feed_after: everything up to here has been posted (starts at install time, so old
-- history isn't dumped into Discord). feed_key: a random password made here, which the
-- once-a-minute job (008) sends to the bot, so nobody else can make it post.
create table if not exists public.bot_state (
  id boolean primary key default true check (id),
  feed_after timestamptz not null default now(),
  feed_key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  commands_version integer not null default 0
);
insert into public.bot_state (id) values (true) on conflict (id) do nothing;

-- Where to post, one channel per Discord server. The webhook is made by the bot in /feed here.
create table if not exists public.bot_channels (
  guild_id text primary key,
  channel_id text not null,
  webhook_id text not null,
  webhook_token text not null,
  added_by text,
  created_at timestamptz not null default now()
);

alter table public.bot_state enable row level security;
alter table public.bot_channels enable row level security;
-- no policies: only the bot (service role, which skips row security) can touch these
revoke all on public.bot_state, public.bot_channels from public, anon, authenticated;
grant select, update on public.bot_state to service_role;
grant select, insert, update, delete on public.bot_channels to service_role;

-- ---------- what the bot can ask for ----------

-- Card data for Discord: no picture unless it's a stored portrait link, no colour settings.
create or replace function public._bot_card_data(d jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select (d - 'portraitUrl' - 'portraitLabels' - 'colors')
    || jsonb_build_object('portraitUrl', case
         when d ->> 'portraitUrl' ~ '^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/portraits/[A-Za-z0-9_./-]+$'
         then d ->> 'portraitUrl' end);
$$;

-- Hands the bot everything new since last time and moves the bookmark past it.
-- Events from the last few seconds wait for the next run, so a trade still being saved is never skipped.
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

  -- the newest event among the next p_limit, then everything up to and including that moment
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
    'versions', (select coalesce(jsonb_object_agg(v.card_id || ':' || v.version, public._bot_card_data(v.data)), '{}'::jsonb)
      from public.card_versions v
      join jsonb_array_elements(v_events) x on (x ->> 'card_id')::uuid = v.card_id and (x ->> 'version')::int = v.version),
    'commands_version', st.commands_version);
end $$;

-- A player found by their Discord account: their card (current version), counts, and what they hold.
-- Returns null when that Discord account has never signed in to Player Cards.
create or replace function public.bot_player(p_discord_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'player', jsonb_build_object('id', p.id, 'username', p.username, 'avatar_url', p.avatar_url, 'created_at', p.created_at),
    'card', case when c.id is null then null else jsonb_build_object(
      'id', c.id,
      'hidden', c.hidden,
      'version', c.current_version,
      'data', case when c.hidden then null else public._bot_card_data(c.data) end,
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

revoke all on function public._activity_events(timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public._bot_card_data(jsonb) from public, anon, authenticated;
revoke all on function public.bot_claim_feed(text, integer, interval) from public, anon, authenticated;
revoke all on function public.bot_player(text) from public, anon, authenticated;
grant execute on function public.bot_claim_feed(text, integer, interval) to service_role;
grant execute on function public.bot_player(text) to service_role;
revoke all on function public.activity_feed(timestamptz, integer, uuid) from public, anon;
grant execute on function public.activity_feed(timestamptz, integer, uuid) to authenticated;
