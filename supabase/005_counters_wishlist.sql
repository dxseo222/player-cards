-- 005: counter-offers and wishlists.
-- Run once in Supabase → SQL Editor after 004.

-- ---------- counter-offers ----------
-- Answering an offer with a counter closes it as "countered" and sends a new offer back,
-- linked to the one it answers.
alter table public.trades add column if not exists counter_of uuid references public.trades(id) on delete set null;
alter table public.trades drop constraint if exists trades_status_check;
alter table public.trades add constraint trades_status_check
  check (status in ('pending', 'accepted', 'declined', 'cancelled', 'failed', 'countered'));

create or replace function public.counter_trade(
  p_trade uuid, p_offer_items uuid[], p_offer_mint boolean,
  p_request_items uuid[], p_request_mint boolean, p_message text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  t public.trades;
  v_id uuid;
begin
  select * into t from public.trades where id = p_trade for update;
  if t.id is null or t.to_user <> me then raise exception 'Trade not found'; end if;
  if t.status <> 'pending' then raise exception 'This trade is already %', t.status; end if;
  -- same checks as any new offer (ownership, locked originals, hidden cards)
  v_id := public.propose_trade(t.from_user, p_offer_items, p_offer_mint, p_request_items, p_request_mint, p_message);
  update public.trades set counter_of = p_trade where id = v_id;
  update public.trades set status = 'countered', resolved_at = now() where id = p_trade;
  return v_id;
end $$;

revoke all on function public.counter_trade(uuid, uuid[], boolean, uuid[], boolean, text) from public, anon;
grant execute on function public.counter_trade(uuid, uuid[], boolean, uuid[], boolean, text) to authenticated;

-- ---------- wishlists ----------
-- Everyone signed in can see who wants which card; you can only add or remove your own
-- wishes, and not for your own card.
create table if not exists public.wishlist (
  user_id uuid not null references public.profiles(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, card_id)
);
alter table public.wishlist enable row level security;

drop policy if exists "wishlist readable" on public.wishlist;
create policy "wishlist readable" on public.wishlist for select to authenticated using (true);
drop policy if exists "wishlist add own" on public.wishlist;
create policy "wishlist add own" on public.wishlist for insert to authenticated
  with check (user_id = auth.uid()
    and not exists (select 1 from public.cards c where c.id = card_id and c.creator_id = auth.uid()));
drop policy if exists "wishlist remove own" on public.wishlist;
create policy "wishlist remove own" on public.wishlist for delete to authenticated using (user_id = auth.uid());

revoke all on public.wishlist from anon;
grant select, insert, delete on public.wishlist to authenticated;
