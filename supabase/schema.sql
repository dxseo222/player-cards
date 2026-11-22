-- Player Cards database
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run.
--
-- Rules it enforces:
--   * Everyone makes one card. Making it gives the creator Original 1/2, which can never be traded.
--   * The creator's first trade of their own card hands out Original 2/2. Every trade after that mints a numbered copy.
--   * Anyone holding Original 2/2 or a copy can trade it on.
--   * All writes go through the functions below, so nobody can edit ownership directly.

create extension if not exists pgcrypto;

-- ---------- tables ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null default 'player',
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null unique references public.profiles(id) on delete cascade,
  data jsonb not null,
  original2_given boolean not null default false,
  copies_minted integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  edition text not null check (edition in ('original', 'copy')),
  serial integer not null,
  created_at timestamptz not null default now(),
  unique (card_id, edition, serial)
);
create index if not exists items_owner_idx on public.items(owner_id);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  offer_items uuid[] not null default '{}',
  offer_mint boolean not null default false,
  request_items uuid[] not null default '{}',
  request_mint boolean not null default false,
  message text check (char_length(message) <= 280),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'failed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists trades_from_idx on public.trades(from_user);
create index if not exists trades_to_idx on public.trades(to_user);

-- ---------- row level security: read-only from the site ----------

alter table public.profiles enable row level security;
alter table public.cards enable row level security;
alter table public.items enable row level security;
alter table public.trades enable row level security;

drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select to authenticated using (true);

drop policy if exists "cards readable" on public.cards;
create policy "cards readable" on public.cards for select to authenticated using (true);

drop policy if exists "items readable" on public.items;
create policy "items readable" on public.items for select to authenticated using (true);

drop policy if exists "own trades readable" on public.trades;
create policy "own trades readable" on public.trades for select to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

-- ---------- profile row for every new sign-in (Discord name + avatar) ----------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, avatar_url)
  values (
    new.id,
    left(coalesce(
      new.raw_user_meta_data -> 'custom_claims' ->> 'global_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      'player'), 40),
    new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- internal helpers (not callable from the site) ----------

-- Gives p_owner the next edition of a card: Original 2/2 the first time, then Copy #1, #2, ...
create or replace function public._mint(p_card uuid, p_owner uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c public.cards;
  v_id uuid;
begin
  select * into c from public.cards where id = p_card for update;
  if c.id is null then raise exception 'That card no longer exists'; end if;
  if not c.original2_given then
    update public.cards set original2_given = true where id = p_card;
    insert into public.items (card_id, owner_id, edition, serial)
      values (p_card, p_owner, 'original', 2) returning id into v_id;
  else
    update public.cards set copies_minted = copies_minted + 1
      where id = p_card returning copies_minted into c.copies_minted;
    insert into public.items (card_id, owner_id, edition, serial)
      values (p_card, p_owner, 'copy', c.copies_minted) returning id into v_id;
  end if;
  return v_id;
end $$;

-- Fails unless every item is owned by p_owner and none of them is a locked Original 1/2.
create or replace function public._check_items(p_items uuid[], p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  want integer;
  n integer;
begin
  select count(distinct x) into want from unnest(p_items) as x;
  if want <> cardinality(p_items) then raise exception 'A card is listed twice'; end if;
  select count(*) into n from public.items i
    where i.id = any(p_items) and i.owner_id = p_owner
      and not (i.edition = 'original' and i.serial = 1);
  if n <> want then raise exception 'One of those cards is not available to trade anymore'; end if;
end $$;

-- ---------- functions the site calls ----------

-- Create or update your card. Creating it gives you Original 1/2.
create or replace function public.save_card(p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_id uuid;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 20000 then
    raise exception 'Card data is invalid or too large';
  end if;
  insert into public.profiles (id) values (me) on conflict (id) do nothing;
  select id into v_id from public.cards where creator_id = me;
  if v_id is null then
    insert into public.cards (creator_id, data) values (me, p_data) returning id into v_id;
    insert into public.items (card_id, owner_id, edition, serial) values (v_id, me, 'original', 1);
  else
    update public.cards set data = p_data, updated_at = now() where id = v_id;
  end if;
  return v_id;
end $$;

-- Offer a trade. p_offer_mint = "I give you a new edition of my own card";
-- p_request_mint = "you give me a new edition of your own card".
create or replace function public.propose_trade(
  p_to uuid,
  p_offer_items uuid[],
  p_offer_mint boolean,
  p_request_items uuid[],
  p_request_mint boolean,
  p_message text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_id uuid;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if p_to = me then raise exception 'You cannot trade with yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_to) then
    raise exception 'That player does not exist';
  end if;
  p_offer_items := coalesce(p_offer_items, '{}');
  p_request_items := coalesce(p_request_items, '{}');
  p_offer_mint := coalesce(p_offer_mint, false);
  p_request_mint := coalesce(p_request_mint, false);
  if cardinality(p_offer_items) + cardinality(p_request_items) = 0
     and not p_offer_mint and not p_request_mint then
    raise exception 'Add at least one card to the trade';
  end if;
  if cardinality(p_offer_items) > 20 or cardinality(p_request_items) > 20 then
    raise exception 'Too many cards in one trade (20 per side)';
  end if;
  perform public._check_items(p_offer_items, me);
  perform public._check_items(p_request_items, p_to);
  if p_offer_mint and not exists (select 1 from public.cards where creator_id = me) then
    raise exception 'Make your card before trading it';
  end if;
  if p_request_mint and not exists (select 1 from public.cards where creator_id = p_to) then
    raise exception 'That player has not made a card yet';
  end if;
  insert into public.trades (from_user, to_user, offer_items, offer_mint, request_items, request_mint, message)
    values (me, p_to, p_offer_items, p_offer_mint, p_request_items, p_request_mint,
            nullif(left(coalesce(p_message, ''), 280), ''))
    returning id into v_id;
  return v_id;
end $$;

-- Accept or decline a trade sent to you. Returns 'accepted', 'declined' or 'failed'
-- ('failed' = one of the cards changed hands since the offer was made).
create or replace function public.respond_trade(p_trade uuid, p_accept boolean)
returns text language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  t public.trades;
  v_card uuid;
begin
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or t.to_user <> me then raise exception 'Trade not found'; end if;
  if t.status <> 'pending' then raise exception 'This trade is already %', t.status; end if;

  if not p_accept then
    update public.trades set status = 'declined', resolved_at = now() where id = p_trade;
    return 'declined';
  end if;

  perform 1 from public.items where id = any(t.offer_items || t.request_items) for update;
  begin
    perform public._check_items(t.offer_items, t.from_user);
    perform public._check_items(t.request_items, t.to_user);
  exception when others then
    update public.trades set status = 'failed', resolved_at = now() where id = p_trade;
    return 'failed';
  end;

  update public.items set owner_id = t.to_user where id = any(t.offer_items);
  update public.items set owner_id = t.from_user where id = any(t.request_items);

  if t.offer_mint then
    select id into v_card from public.cards where creator_id = t.from_user;
    perform public._mint(v_card, t.to_user);
  end if;
  if t.request_mint then
    select id into v_card from public.cards where creator_id = t.to_user;
    perform public._mint(v_card, t.from_user);
  end if;

  update public.trades set status = 'accepted', resolved_at = now() where id = p_trade;
  return 'accepted';
end $$;

-- Take back an offer you sent that has not been answered yet.
create or replace function public.cancel_trade(p_trade uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.trades set status = 'cancelled', resolved_at = now()
    where id = p_trade and from_user = auth.uid() and status = 'pending';
  if not found then raise exception 'Trade not found or already answered'; end if;
end $$;

-- ---------- who may read what ----------
-- Granted explicitly so it works whether or not the project exposes new tables automatically.
-- Signed-in players can read (rows are still filtered by the policies above); nobody writes
-- to the tables directly, only through the functions below.

grant usage on schema public to authenticated;
revoke all on public.profiles, public.cards, public.items, public.trades from anon;
revoke insert, update, delete, truncate on public.profiles, public.cards, public.items, public.trades from authenticated;
grant select on public.profiles, public.cards, public.items, public.trades to authenticated;

-- ---------- who may call what ----------

revoke all on function public._mint(uuid, uuid) from public, anon, authenticated;
revoke all on function public._check_items(uuid[], uuid) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

revoke all on function public.save_card(jsonb) from public, anon;
revoke all on function public.propose_trade(uuid, uuid[], boolean, uuid[], boolean, text) from public, anon;
revoke all on function public.respond_trade(uuid, boolean) from public, anon;
revoke all on function public.cancel_trade(uuid) from public, anon;

grant execute on function public.save_card(jsonb) to authenticated;
grant execute on function public.propose_trade(uuid, uuid[], boolean, uuid[], boolean, text) to authenticated;
grant execute on function public.respond_trade(uuid, boolean) to authenticated;
grant execute on function public.cancel_trade(uuid) to authenticated;
