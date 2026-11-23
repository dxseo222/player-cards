-- Trading through the Discord bot: /trade, /trades and the offer buttons.
-- Run after 009_card_images.sql. Safe to run again.
--
-- The bot signs in as itself (service role). These functions let it act for the Discord user
-- who pressed a button, by calling the very same trade functions the site uses. So every rule
-- (who owns what, Original 1/2 never trades, hidden cards, 20 cards per side) is checked in one
-- place, and a trade made in Discord is the same as one made on the site.

-- ---------- offers being put together in Discord ----------
-- Discord menus send one choice at a time, so the unfinished offer is kept here until it's sent.
create table if not exists public.bot_trade_drafts (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  to_discord_id text not null,
  to_user uuid not null references public.profiles(id) on delete cascade,
  counter_of uuid references public.trades(id) on delete cascade,
  offer_items uuid[] not null default '{}',
  offer_mint boolean not null default false,
  request_items uuid[] not null default '{}',
  request_mint boolean not null default false,
  message text check (char_length(message) <= 280),
  created_at timestamptz not null default now()
);
alter table public.bot_trade_drafts enable row level security;
revoke all on public.bot_trade_drafts from public, anon, authenticated;
grant select, insert, update, delete on public.bot_trade_drafts to service_role;

-- ---------- helpers ----------

-- The player behind a Discord account, or null if they've never signed in to the site.
create or replace function public._discord_user(p_discord_id text)
returns uuid language sql stable security definer set search_path = public as $$
  select ai.user_id from auth.identities ai
  where ai.provider = 'discord' and ai.provider_id = p_discord_id
  limit 1;
$$;

-- Makes auth.uid() return this player until the end of the current request, so the site's
-- trade functions run exactly as if they had pressed the button on the site.
create or replace function public._act_as(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- Cards as the bot lists them.
create or replace function public._bot_items(p_ids uuid[])
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'card_id', i.card_id, 'name', c.data ->> 'name', 'maker', mk.username,
           'edition', i.edition, 'serial', i.serial, 'version', v.version)
         order by lower(c.data ->> 'name'), v.version, i.edition desc, i.serial), '[]'::jsonb)
  from public.items i
  join public.cards c on c.id = i.card_id
  join public.card_versions v on v.id = i.version_id
  join public.profiles mk on mk.id = c.creator_id
  where i.id = any(p_ids);
$$;

-- A player's own card as something to trade: a new edition of it, and which one that would be.
create or replace function public._bot_mint_option(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('card_id', c.id, 'name', c.data ->> 'name',
    'next', case when c.current_version > 1 then 'v' || c.current_version || ' · ' else '' end
            || case when v.original2_given then 'Copy #' || (v.copies_minted + 1) else 'Original 2/2' end)
  from public.cards c
  join public.card_versions v on v.card_id = c.id and v.version = c.current_version
  where c.creator_id = p_user and not c.hidden;
$$;

create or replace function public._bot_tradeable(p_user uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(i.id), '{}')
  from public.items i
  join public.cards c on c.id = i.card_id
  where i.owner_id = p_user and not c.hidden and not (i.edition = 'original' and i.serial = 1);
$$;

-- ---------- what the bot can ask for ----------

-- Everything needed to build an offer between two Discord users.
create or replace function public.bot_trade_options(p_discord_id text, p_to_discord_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := public._discord_user(p_discord_id);
  them uuid := public._discord_user(p_to_discord_id);
begin
  if me is null then raise exception 'Sign in on the Player Cards site with this Discord account first'; end if;
  if them is null then raise exception 'That player isn''t on Player Cards yet'; end if;
  if me = them then raise exception 'You cannot trade with yourself'; end if;
  return jsonb_build_object(
    'me', (select jsonb_build_object('id', p.id, 'username', p.username) from public.profiles p where p.id = me),
    'them', (select jsonb_build_object('id', p.id, 'username', p.username) from public.profiles p where p.id = them),
    'my_mint', public._bot_mint_option(me),
    'their_mint', public._bot_mint_option(them),
    'mine', public._bot_items(public._bot_tradeable(me)),
    'theirs', public._bot_items(public._bot_tradeable(them)));
end $$;

-- One trade, only for the two players in it (null for anyone else).
create or replace function public.bot_trade_view(p_discord_id text, p_trade uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := public._discord_user(p_discord_id);
  t public.trades;
begin
  select * into t from public.trades where id = p_trade;
  if t.id is null or me is null or me not in (t.from_user, t.to_user) then return null; end if;
  return jsonb_build_object(
    'id', t.id, 'status', t.status, 'message', t.message, 'created_at', t.created_at, 'counter_of', t.counter_of,
    'viewer', case when me = t.from_user then 'from' else 'to' end,
    'from', (select jsonb_build_object('id', p.id, 'username', p.username, 'discord', (select ai.provider_id from auth.identities ai where ai.user_id = p.id and ai.provider = 'discord' limit 1))
             from public.profiles p where p.id = t.from_user),
    'to', (select jsonb_build_object('id', p.id, 'username', p.username, 'discord', (select ai.provider_id from auth.identities ai where ai.user_id = p.id and ai.provider = 'discord' limit 1))
           from public.profiles p where p.id = t.to_user),
    'offer_items', public._bot_items(t.offer_items),
    'request_items', public._bot_items(t.request_items),
    'offer_mint', case when t.offer_mint then public._bot_mint_option(t.from_user) end,
    'request_mint', case when t.request_mint then public._bot_mint_option(t.to_user) end);
end $$;

-- Your offers that are still waiting for an answer, newest first.
create or replace function public.bot_open_trades(p_discord_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'incoming', t.to_user = me.id, 'created_at', t.created_at,
           'other', case when t.to_user = me.id then f.username else r.username end,
           'gives', cardinality(t.offer_items) + t.offer_mint::int,
           'gets', cardinality(t.request_items) + t.request_mint::int)
         order by t.created_at desc), '[]'::jsonb)
  from (select public._discord_user(p_discord_id) as id) me
  join public.trades t on me.id in (t.from_user, t.to_user) and t.status = 'pending'
  join public.profiles f on f.id = t.from_user
  join public.profiles r on r.id = t.to_user;
$$;

-- Sends a finished draft, or answers an offer, as the Discord user who pressed the button.
-- p_action: 'send' (with p_draft), 'accept', 'decline' or 'cancel' (with p_trade).
create or replace function public.bot_trade(p_discord_id text, p_action text, p_trade uuid default null, p_draft uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := public._discord_user(p_discord_id);
  d public.bot_trade_drafts;
  v_id uuid;
begin
  if me is null then raise exception 'Sign in on the Player Cards site with this Discord account first'; end if;
  perform public._act_as(me);

  if p_action = 'send' then
    select * into d from public.bot_trade_drafts where id = p_draft and discord_id = p_discord_id;
    if d.id is null then raise exception 'This offer was already sent or cancelled'; end if;
    if d.counter_of is not null then
      v_id := public.counter_trade(d.counter_of, d.offer_items, d.offer_mint, d.request_items, d.request_mint, d.message);
    else
      v_id := public.propose_trade(d.to_user, d.offer_items, d.offer_mint, d.request_items, d.request_mint, d.message);
    end if;
    delete from public.bot_trade_drafts where id = d.id;
    return jsonb_build_object('trade_id', v_id, 'counter', d.counter_of is not null);
  elsif p_action in ('accept', 'decline') then
    return jsonb_build_object('result', public.respond_trade(p_trade, p_action = 'accept'));
  elsif p_action = 'cancel' then
    perform public.cancel_trade(p_trade);
    return jsonb_build_object('result', 'cancelled');
  end if;
  raise exception 'Unknown action';
end $$;

revoke all on function public._discord_user(text) from public, anon, authenticated;
revoke all on function public._act_as(uuid) from public, anon, authenticated;
revoke all on function public._bot_items(uuid[]) from public, anon, authenticated;
revoke all on function public._bot_mint_option(uuid) from public, anon, authenticated;
revoke all on function public._bot_tradeable(uuid) from public, anon, authenticated;
revoke all on function public.bot_trade_options(text, text) from public, anon, authenticated;
revoke all on function public.bot_trade_view(text, uuid) from public, anon, authenticated;
revoke all on function public.bot_open_trades(text) from public, anon, authenticated;
revoke all on function public.bot_trade(text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.bot_trade_options(text, text) to service_role;
grant execute on function public.bot_trade_view(text, uuid) to service_role;
grant execute on function public.bot_open_trades(text) to service_role;
grant execute on function public.bot_trade(text, text, uuid, uuid) to service_role;
