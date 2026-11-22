-- 003: frozen card versions, moderation, public card links, live trade updates.
-- Run once in Supabase → SQL Editor after schema.sql and 002_portraits.sql.
--
-- Versions: a card's current version can be edited freely until any edition of it has been
-- traded out. After that it's frozen, and the creator's next save starts a new version with
-- its own Original 1/2 (kept by the creator) and Original 2/2 (their next trade), then copies.
-- Every item points at the exact version it was minted from, so traded cards never change.

-- ---------- columns ----------
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.cards add column if not exists hidden boolean not null default false;
alter table public.cards add column if not exists current_version integer not null default 1;

-- ---------- versions ----------
create table if not exists public.card_versions (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  version integer not null,
  data jsonb not null,
  original2_given boolean not null default false,
  copies_minted integer not null default 0,
  created_at timestamptz not null default now(),
  unique (card_id, version)
);

-- every existing card becomes version 1, keeping its trade counters
insert into public.card_versions (card_id, version, data, original2_given, copies_minted, created_at)
select c.id, 1, c.data, c.original2_given, c.copies_minted, c.created_at
from public.cards c
where not exists (select 1 from public.card_versions v where v.card_id = c.id);

alter table public.items add column if not exists version_id uuid references public.card_versions(id) on delete cascade;
update public.items i set version_id = v.id
from public.card_versions v
where v.card_id = i.card_id and v.version = 1 and i.version_id is null;
alter table public.items alter column version_id set not null;
alter table public.items drop constraint if exists items_card_id_edition_serial_key;
create unique index if not exists items_version_edition_serial on public.items(version_id, edition, serial);

-- ---------- reports ----------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  reporter uuid not null references public.profiles(id) on delete cascade,
  reason text check (char_length(reason) <= 280),
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now()
);
create unique index if not exists reports_one_open on public.reports(card_id, reporter) where status = 'open';

-- ---------- helpers ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- ---------- read access ----------
alter table public.card_versions enable row level security;
alter table public.reports enable row level security;

drop policy if exists "versions readable" on public.card_versions;
create policy "versions readable" on public.card_versions for select to authenticated using (true);

-- signed-out visitors can open shared card links, except hidden cards
drop policy if exists "public cards readable" on public.cards;
create policy "public cards readable" on public.cards for select to anon using (not hidden);
drop policy if exists "public versions readable" on public.card_versions;
create policy "public versions readable" on public.card_versions for select to anon
  using (exists (select 1 from public.cards c where c.id = card_id and not c.hidden));

drop policy if exists "admins read reports" on public.reports;
create policy "admins read reports" on public.reports for select to authenticated using (public.is_admin());

grant usage on schema public to anon, authenticated;
grant select on public.card_versions, public.reports to authenticated;
grant select on public.cards, public.card_versions to anon;
revoke insert, update, delete, truncate on public.card_versions, public.reports from anon, authenticated;

-- ---------- minting from the current version ----------
create or replace function public._mint(p_card uuid, p_owner uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c public.cards;
  v public.card_versions;
  n integer;
  v_id uuid;
begin
  select * into c from public.cards where id = p_card;
  if c.id is null then raise exception 'That card no longer exists'; end if;
  select * into v from public.card_versions where card_id = p_card and version = c.current_version for update;
  if not v.original2_given then
    update public.card_versions set original2_given = true where id = v.id;
    insert into public.items (card_id, version_id, owner_id, edition, serial)
      values (p_card, v.id, p_owner, 'original', 2) returning id into v_id;
  else
    update public.card_versions set copies_minted = copies_minted + 1 where id = v.id returning copies_minted into n;
    insert into public.items (card_id, version_id, owner_id, edition, serial)
      values (p_card, v.id, p_owner, 'copy', n) returning id into v_id;
  end if;
  return v_id;
end $$;

-- ---------- saving: edit in place until traded, then start a new version ----------
create or replace function public.save_card(p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  c public.cards;
  v public.card_versions;
  next_v integer;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 20000 then
    raise exception 'Card data is invalid or too large';
  end if;
  insert into public.profiles (id) values (me) on conflict (id) do nothing;

  select * into c from public.cards where creator_id = me for update;
  if c.id is null then
    insert into public.cards (creator_id, data, current_version) values (me, p_data, 1) returning * into c;
    insert into public.card_versions (card_id, version, data) values (c.id, 1, p_data) returning * into v;
    insert into public.items (card_id, version_id, owner_id, edition, serial) values (c.id, v.id, me, 'original', 1);
    return c.id;
  end if;

  select * into v from public.card_versions where card_id = c.id and version = c.current_version for update;
  if v.id is not null and v.data = p_data then return c.id; end if;

  if v.id is null or v.original2_given or v.copies_minted > 0 then
    select coalesce(max(version), 0) + 1 into next_v from public.card_versions where card_id = c.id;
    insert into public.card_versions (card_id, version, data) values (c.id, next_v, p_data) returning * into v;
    insert into public.items (card_id, version_id, owner_id, edition, serial) values (c.id, v.id, me, 'original', 1);
    update public.cards set data = p_data, current_version = next_v, updated_at = now() where id = c.id;
  else
    update public.card_versions set data = p_data where id = v.id;
    update public.cards set data = p_data, updated_at = now() where id = c.id;
  end if;
  return c.id;
end $$;

-- hidden cards can't hand out new editions
create or replace function public.propose_trade(
  p_to uuid, p_offer_items uuid[], p_offer_mint boolean,
  p_request_items uuid[], p_request_mint boolean, p_message text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_id uuid;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if p_to = me then raise exception 'You cannot trade with yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_to) then raise exception 'That player does not exist'; end if;
  p_offer_items := coalesce(p_offer_items, '{}');
  p_request_items := coalesce(p_request_items, '{}');
  p_offer_mint := coalesce(p_offer_mint, false);
  p_request_mint := coalesce(p_request_mint, false);
  if cardinality(p_offer_items) + cardinality(p_request_items) = 0 and not p_offer_mint and not p_request_mint then
    raise exception 'Add at least one card to the trade';
  end if;
  if cardinality(p_offer_items) > 20 or cardinality(p_request_items) > 20 then
    raise exception 'Too many cards in one trade (20 per side)';
  end if;
  perform public._check_items(p_offer_items, me);
  perform public._check_items(p_request_items, p_to);
  if p_offer_mint and not exists (select 1 from public.cards where creator_id = me and not hidden) then
    raise exception 'Make your card before trading it (or it is hidden by a moderator)';
  end if;
  if p_request_mint and not exists (select 1 from public.cards where creator_id = p_to and not hidden) then
    raise exception 'That player has no card to trade yet';
  end if;
  insert into public.trades (from_user, to_user, offer_items, offer_mint, request_items, request_mint, message)
    values (me, p_to, p_offer_items, p_offer_mint, p_request_items, p_request_mint, nullif(left(coalesce(p_message, ''), 280), ''))
    returning id into v_id;
  return v_id;
end $$;

-- ---------- moderation ----------
create or replace function public.report_card(p_card uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.cards where id = p_card) then raise exception 'Card not found'; end if;
  insert into public.reports (card_id, reporter, reason)
    values (p_card, auth.uid(), nullif(left(coalesce(p_reason, ''), 280), ''))
    on conflict do nothing;
end $$;

create or replace function public.admin_set_hidden(p_card uuid, p_hidden boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only moderators can do that'; end if;
  update public.cards set hidden = p_hidden where id = p_card;
end $$;

-- removes the picture from every version; the site also deletes the files from storage
create or replace function public.admin_remove_portrait(p_card uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only moderators can do that'; end if;
  update public.cards set data = data - 'portraitUrl' where id = p_card;
  update public.card_versions set data = data - 'portraitUrl' where card_id = p_card;
end $$;

create or replace function public.admin_resolve_report(p_report uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only moderators can do that'; end if;
  update public.reports set status = 'resolved' where id = p_report;
end $$;

-- moderators may delete anyone's portrait files
drop policy if exists "portraits delete admin" on storage.objects;
create policy "portraits delete admin" on storage.objects for delete to authenticated
  using (bucket_id = 'portraits' and public.is_admin());

-- ---------- live trade updates ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trades') then
    alter publication supabase_realtime add table public.trades;
  end if;
end $$;

-- ---------- who may call what ----------
revoke all on function public._mint(uuid, uuid) from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.save_card(jsonb) from public, anon;
revoke all on function public.propose_trade(uuid, uuid[], boolean, uuid[], boolean, text) from public, anon;
revoke all on function public.report_card(uuid, text) from public, anon;
revoke all on function public.admin_set_hidden(uuid, boolean) from public, anon;
revoke all on function public.admin_remove_portrait(uuid) from public, anon;
revoke all on function public.admin_resolve_report(uuid) from public, anon;
grant execute on function public.save_card(jsonb) to authenticated;
grant execute on function public.propose_trade(uuid, uuid[], boolean, uuid[], boolean, text) to authenticated;
grant execute on function public.report_card(uuid, text) to authenticated;
grant execute on function public.admin_set_hidden(uuid, boolean) to authenticated;
grant execute on function public.admin_remove_portrait(uuid) to authenticated;
grant execute on function public.admin_resolve_report(uuid) to authenticated;
