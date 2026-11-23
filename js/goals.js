// Badges and leaderboard, worked out from data everyone signed in can already read:
// who owns which item, each card's versions, and wishlists. Nothing here is stored.

import { rarityFor } from './card.js?v11';

const RARITY_WEIGHT = { Common: 1, Rare: 1.5, Epic: 2, Legendary: 3, Mythic: 4 };

// world = { players, items, versions, wishlist }
//   players: [{ id, username, card: { id, current_version, hidden } | null }]
//   items: every item; versions: every card version (with msgCount); wishlist: every wish
export function buildWorld({ players, items, versions, wishlist }) {
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const cardById = new Map(players.filter((p) => p.card).map((p) => [p.card.id, { ...p.card, creator_id: p.id }]));
  const versionsByCard = new Map();
  versions.forEach((v) => { if (!versionsByCard.has(v.card_id)) versionsByCard.set(v.card_id, []); versionsByCard.get(v.card_id).push(v); });
  const tradedOut = (cardId) => (versionsByCard.get(cardId) || []).reduce((n, v) => n + (v.original2_given ? 1 : 0) + (v.copies_minted || 0), 0);
  const rarityOf = (item) => rarityFor((versionById.get(item.version_id) || {}).msgCount);
  return { players, items, versions, wishlist, versionById, cardById, versionsByCard, tradedOut, rarityOf };
}

// Everything the badges and leaderboard need about one player.
export function playerStats(world, player) {
  const own = world.items.filter((i) => i.owner_id === player.id);
  const fromOthers = own.filter((i) => { const c = world.cardById.get(i.card_id); return c && c.creator_id !== player.id; });
  const collected = new Set(fromOthers.map((i) => world.cardById.get(i.card_id).creator_id));
  const othersWithCards = world.players.filter((p) => p.id !== player.id && p.card && !p.card.hidden);
  const vintage = fromOthers.filter((i) => {
    const v = world.versionById.get(i.version_id);
    const c = world.cardById.get(i.card_id);
    return v && c && v.version < c.current_version;
  });
  const rarities = new Set(own.map((i) => world.rarityOf(i)));
  const score = Math.round(fromOthers.reduce((sum, i) => {
    const base = i.edition === 'original' ? 10 : 2;
    return sum + base * (RARITY_WEIGHT[world.rarityOf(i)] || 1);
  }, 0) + vintage.length * 5);
  return {
    cards: own.length,
    fromOthers: fromOthers.length,
    collected: collected.size,
    othersWithCards: othersWithCards.length,
    hasAllOthers: othersWithCards.length > 0 && othersWithCards.every((p) => collected.has(p.id)),
    originals2: fromOthers.filter((i) => i.edition === 'original' && i.serial === 2).length,
    vintage: vintage.length,
    mythic: fromOthers.filter((i) => world.rarityOf(i) === 'Mythic').length,
    rarities: rarities.size,
    tradedOut: player.card ? world.tradedOut(player.card.id) : 0,
    versions: player.card ? (world.versionsByCard.get(player.card.id) || []).length : 0,
    wantedBy: player.card ? world.wishlist.filter((w) => w.card_id === player.card.id).length : 0,
    hasCard: !!player.card,
    score,
  };
}

// Each badge: how far along you are and what "done" means.
export const BADGES = [
  { id: 'maker', icon: '✦', name: 'Card Maker', desc: 'Make your card', goal: 1, progress: (s) => (s.hasCard ? 1 : 0) },
  { id: 'first-trade', icon: '⇄', name: 'First Trade', desc: 'Get a card from another player', goal: 1, progress: (s) => Math.min(1, s.fromOthers) },
  { id: 'collector', icon: '◈', name: 'Collector', desc: 'Cards from 3 different players', goal: 3, progress: (s) => s.collected },
  { id: 'archivist', icon: '◆', name: 'Archivist', desc: 'Cards from 10 different players', goal: 10, progress: (s) => s.collected },
  { id: 'curator', icon: '✶', name: 'Curator', desc: 'Cards from 25 different players', goal: 25, progress: (s) => s.collected },
  { id: 'complete', icon: '✠', name: 'Complete Set', desc: 'A card from every other player (at least 2)', goal: 1, progress: (s) => (s.othersWithCards >= 2 && s.hasAllOthers ? 1 : 0), detail: (s) => s.collected + '/' + s.othersWithCards + ' players' },
  { id: 'originals', icon: '♛', name: 'Original Hunter', desc: 'Hold 3 Original 2/2s', goal: 3, progress: (s) => s.originals2 },
  { id: 'vintage', icon: '⌛', name: 'Vintage', desc: 'Hold an old version of a card that has since changed', goal: 1, progress: (s) => Math.min(1, s.vintage) },
  { id: 'mythic', icon: '☾', name: 'Mythic Holder', desc: 'Hold a Mythic card from someone else', goal: 1, progress: (s) => Math.min(1, s.mythic) },
  { id: 'rainbow', icon: '✺', name: 'Rainbow', desc: 'Cards of 4 different rarities', goal: 4, progress: (s) => s.rarities },
  { id: 'in-demand', icon: '❖', name: 'In Demand', desc: 'Your card traded out 5 times', goal: 5, progress: (s) => s.tradedOut },
  { id: 'icon', icon: '✧', name: 'Icon', desc: 'Your card traded out 20 times', goal: 20, progress: (s) => s.tradedOut },
  { id: 'evolving', icon: '⟳', name: 'Evolving', desc: 'Reach version 3 of your card', goal: 3, progress: (s) => s.versions },
  { id: 'wanted', icon: '♥', name: 'Wanted', desc: '3 players have your card on their wishlist', goal: 3, progress: (s) => s.wantedBy },
];

export function badgesFor(stats) {
  return BADGES.map((b) => {
    const p = Math.min(b.goal, b.progress(stats));
    return { ...b, have: p, earned: p >= b.goal, label: b.detail ? b.detail(stats) : p + '/' + b.goal };
  });
}

// Rows for each leaderboard, best first (ties keep alphabetical order).
export function leaderboards(world) {
  const rows = world.players.map((p) => {
    const s = playerStats(world, p);
    return { player: p, stats: s, badges: badgesFor(s).filter((b) => b.earned).length };
  }).sort((a, b) => a.player.username.localeCompare(b.player.username));
  const top = (key, fn) => rows.map((r) => ({ ...r, value: fn(r) })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
  const cards = [...world.cardById.values()].filter((c) => !c.hidden)
    .map((c) => ({ card: c, value: world.tradedOut(c.id), wanted: world.wishlist.filter((w) => w.card_id === c.id).length }))
    .filter((c) => c.value > 0 || c.wanted > 0)
    .sort((a, b) => b.value - a.value || b.wanted - a.wanted).slice(0, 10);
  return {
    score: top('score', (r) => r.stats.score),
    cards: top('cards', (r) => r.stats.fromOthers),
    set: top('set', (r) => r.stats.collected),
    badges: top('badges', (r) => r.badges),
    traded: cards,
  };
}
