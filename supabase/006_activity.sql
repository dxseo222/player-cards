-- Activity feed: new cards, new versions and finished trades, newest first.
-- Run after 005_counters_wishlist.sql. Safe to run again.
--
-- Trades are private rows (only the two players can read them), so this function shares only
-- what changed hands in accepted trades: never messages, open offers or declined ones.
-- Hidden cards are left out everywhere.
--
-- Which edition a trade minted isn't stored on the trade, but it doesn't need to be: the mint
-- and the trade's resolved_at happen in one transaction, and now() is the same for the whole
-- transaction, so the minted item's created_at equals the trade's resolved_at exactly.

create index if not exists items_created_idx on public.items(created_at);
create index if not exists trades_resolved_idx on public.trades(resolved_at) where status = 'accepted';

create or replace function public._moved_items(p_items uuid[], p_mint boolean, p_creator uuid, p_at timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'card_id', i.card_id, 'version', v.version, 'edition', i.edition, 'serial', i.serial)
         order by i.edition desc, i.serial), '[]'::jsonb)
  from public.items i
  join public.cards c on c.id = i.card_id
  join public.card_versions v on v.id = i.version_id
  where not c.hidden
    and (i.id = any(p_items)
         or (p_mint and i.created_at = p_at and c.creator_id = p_creator
             and not (i.edition = 'original' and i.serial = 1)));
$$;

-- p_before: only events older than this (for "Load more"). p_player: only events involving them.
create or replace function public.activity_feed(p_before timestamptz default null, p_limit integer default 40, p_player uuid default null)
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
      and (p_before is null or t.resolved_at < p_before)
      and (p_player is null or p_player in (t.from_user, t.to_user))
  )
  select * from ev
  where auth.uid() is not null
    and (p_before is null or ev.happened_at < p_before)
    and (p_player is null or p_player in (ev.actor, ev.other))
    and (ev.kind <> 'trade' or ev.to_other <> '[]'::jsonb or ev.to_actor <> '[]'::jsonb)
  order by ev.happened_at desc
  limit least(greatest(coalesce(p_limit, 40), 1), 100);
$$;

revoke all on function public._moved_items(uuid[], boolean, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.activity_feed(timestamptz, integer, uuid) from public, anon;
grant execute on function public.activity_feed(timestamptz, integer, uuid) to authenticated;
