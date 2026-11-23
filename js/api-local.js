// Demo backend: same interface as api-supabase.js, but everything lives in this browser's
// localStorage. Used automatically when config.js has no Supabase keys, so the whole app
// (cards, versions, originals/copies, trades, moderation) can be tried locally.
// The rules here mirror supabase/*.sql.

import { blankCard } from './card.js?v12';

const KEY = 'player-cards-demo-v2';
let memory = null;
const listeners = new Set();
const tradeListeners = new Set();

function uid() { return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2); }

function sampleCard(name, theme, cls, emblem) {
  const c = blankCard(name);
  return Object.assign(c, {
    theme, className: cls, emblem, msgCount: 12000, since: 'Jan 2024',
    tags: ['Sample card'], quote: 'this is a sample card for trying out trades',
    quoteSource: 'demo mode', portraitLabels: ['demo', '', ''], footer: ['sample', 'not a real person', ''],
    abilities: [{ name: 'Demo Mode', kind: 'Passive', desc: 'Exists so you can test trading before going live.' }],
  });
}

function newCard(s, userId, data) {
  const c = { id: uid(), creator_id: userId, data, current_version: 1, hidden: false };
  const v = { id: uid(), card_id: c.id, version: 1, data, original2_given: false, copies_minted: 0, created_at: new Date().toISOString() };
  s.cards.push(c);
  s.versions.push(v);
  s.items.push({ id: uid(), card_id: c.id, version_id: v.id, owner_id: userId, edition: 'original', serial: 1 });
  return c;
}

function seed() {
  const s = { users: [], cards: [], versions: [], items: [], trades: [], reports: [], current: null };
  const add = (username, card, admin = false) => {
    const u = { id: uid(), username, avatar_url: null, is_admin: admin };
    s.users.push(u);
    if (card) newCard(s, u.id, card);
    return u;
  };
  const me = add('you (demo)', null, true);
  add('Sample Player A', sampleCard('sample a', 'lilac', 'Grinder · Gamer', '🎮'));
  add('Sample Player B', sampleCard('sample b', 'mono', 'Artificer · Dev', '⌨️'));
  s.current = me.id;
  return s;
}

function load() {
  if (memory) return memory;
  try { const raw = localStorage.getItem(KEY); if (raw) memory = JSON.parse(raw); } catch { /* storage blocked */ }
  if (!memory) { memory = seed(); save(); }
  memory.wishlist = memory.wishlist || [];
  return memory;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* keep in memory */ } }
function fail(msg) { throw new Error(msg); }
const clone = (x) => JSON.parse(JSON.stringify(x));
const curVersion = (s, c) => s.versions.find((v) => v.card_id === c.id && v.version === c.current_version);
const withCur = (s, c) => c && { ...clone(c), cur: clone(curVersion(s, c)), versionCount: s.versions.filter((v) => v.card_id === c.id).length };
const me = (s) => s.users.find((u) => u.id === s.current);

function mint(s, card, ownerId) {
  const v = curVersion(s, card);
  if (!v.original2_given) {
    v.original2_given = true;
    s.items.push({ id: uid(), card_id: card.id, version_id: v.id, owner_id: ownerId, edition: 'original', serial: 2 });
  } else {
    v.copies_minted += 1;
    s.items.push({ id: uid(), card_id: card.id, version_id: v.id, owner_id: ownerId, edition: 'copy', serial: v.copies_minted });
  }
  return s.items[s.items.length - 1].id;
}
function checkItems(s, ids, owner) {
  if (new Set(ids).size !== ids.length) fail('A card is listed twice');
  const ok = s.items.filter((i) => ids.includes(i.id) && i.owner_id === owner && !(i.edition === 'original' && i.serial === 1));
  if (ok.length !== ids.length) fail('One of those cards is not available to trade anymore');
}
function requireAdmin(s) { if (!me(s).is_admin) fail('Only moderators can do that'); }
function tradeEvent(t, type) { tradeListeners.forEach((cb) => cb(clone(t), type)); }

export const api = {
  mode: 'demo',
  async init() { load(); return this.me(); },
  onChange(cb) { listeners.add(cb); },
  emit() { listeners.forEach((cb) => cb()); },
  async signIn() { },
  async signOut() { },

  async demoUsers() { return clone(load().users); },
  async switchUser(id) { const s = load(); s.current = id; save(); this.emit(); },
  async resetDemo() { memory = seed(); save(); this.emit(); },

  async me() { return clone(me(load())); },
  async players() {
    const s = load();
    return s.users.map((u) => ({ ...clone(u), card: withCur(s, s.cards.find((c) => c.creator_id === u.id)) || null }));
  },
  async myCard() { const s = load(); return withCur(s, s.cards.find((c) => c.creator_id === s.current)) || null; },
  async saveCard(data) {
    const s = load();
    let c = s.cards.find((x) => x.creator_id === s.current);
    if (!c) { c = newCard(s, s.current, data); save(); return c.id; }
    const v = curVersion(s, c);
    if (JSON.stringify(v.data) === JSON.stringify(data)) return c.id;
    if (v.original2_given || v.copies_minted > 0) {
      const next = Math.max(...s.versions.filter((x) => x.card_id === c.id).map((x) => x.version)) + 1;
      const nv = { id: uid(), card_id: c.id, version: next, data, original2_given: false, copies_minted: 0, created_at: new Date().toISOString() };
      s.versions.push(nv);
      s.items.push({ id: uid(), card_id: c.id, version_id: nv.id, owner_id: s.current, edition: 'original', serial: 1 });
      c.current_version = next;
    } else { v.data = data; delete v.image_url; }
    c.data = data;
    save();
    return c.id;
  },
  async cardVersions(cardId) { return clone(load().versions.filter((v) => v.card_id === cardId).sort((a, b) => a.version - b.version)); },
  async versions(ids) { return clone(load().versions.filter((v) => ids.includes(v.id))); },
  async publicCard(cardId, version) {
    const s = load();
    const c = s.cards.find((x) => x.id === cardId);
    if (!c || c.hidden) return null;
    const v = s.versions.find((x) => x.card_id === c.id && x.version === (version || c.current_version));
    return v ? { card: clone(c), version: clone(v) } : null;
  },
  // Demo mode keeps the (already shrunk) picture inside the card as a data URL.
  async uploadPortrait(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read that picture'));
      r.readAsDataURL(blob);
    });
  },
  async removePortrait() { },
  // Demo mode has no storage: card pictures are drawn but only their name is kept.
  async uploadCardImage(blob, name) { return 'demo://card-images/' + load().current + '/' + name; },
  async setCardImage(version, url) {
    const s = load();
    const c = s.cards.find((x) => x.creator_id === s.current);
    const v = c && s.versions.find((x) => x.card_id === c.id && x.version === version);
    if (!v) throw new Error('That version doesn’t exist');
    v.image_url = url;
    save();
  },
  async pruneCardImages() { },
  async items(ownerId) { return clone(load().items.filter((i) => i.owner_id === ownerId)); },
  async itemsByIds(ids) { return clone(load().items.filter((i) => ids.includes(i.id))); },
  async trades() {
    const s = load();
    return clone(s.trades.filter((t) => t.from_user === s.current || t.to_user === s.current))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async propose({ to, offerItems = [], offerMint = false, requestItems = [], requestMint = false, message = '' }) {
    const s = load();
    const meId = s.current;
    if (to === meId) fail('You cannot trade with yourself');
    if (!offerItems.length && !requestItems.length && !offerMint && !requestMint) fail('Add at least one card to the trade');
    checkItems(s, offerItems, meId);
    checkItems(s, requestItems, to);
    if (offerMint && !s.cards.some((c) => c.creator_id === meId && !c.hidden)) fail('Make your card before trading it (or it is hidden by a moderator)');
    if (requestMint && !s.cards.some((c) => c.creator_id === to && !c.hidden)) fail('That player has no card to trade yet');
    const t = {
      id: uid(), from_user: meId, to_user: to, offer_items: offerItems, offer_mint: offerMint,
      request_items: requestItems, request_mint: requestMint, message: message.slice(0, 280) || null,
      status: 'pending', created_at: new Date().toISOString(), resolved_at: null,
    };
    s.trades.push(t);
    save();
    tradeEvent(t, 'INSERT');
  },
  async respond(id, accept) {
    const s = load();
    const t = s.trades.find((x) => x.id === id);
    if (!t || t.to_user !== s.current) fail('Trade not found');
    if (t.status !== 'pending') fail('This trade is already ' + t.status);
    t.resolved_at = new Date().toISOString();
    if (!accept) { t.status = 'declined'; save(); tradeEvent(t, 'UPDATE'); return 'declined'; }
    try { checkItems(s, t.offer_items, t.from_user); checkItems(s, t.request_items, t.to_user); } catch { t.status = 'failed'; save(); tradeEvent(t, 'UPDATE'); return 'failed'; }
    s.items.forEach((i) => {
      if (t.offer_items.includes(i.id)) i.owner_id = t.to_user;
      else if (t.request_items.includes(i.id)) i.owner_id = t.from_user;
    });
    // The demo remembers which editions a trade minted, for the activity feed.
    t.minted_to = t.offer_mint ? mint(s, s.cards.find((c) => c.creator_id === t.from_user), t.to_user) : null;
    t.minted_from = t.request_mint ? mint(s, s.cards.find((c) => c.creator_id === t.to_user), t.from_user) : null;
    t.status = 'accepted';
    save();
    tradeEvent(t, 'UPDATE');
    return 'accepted';
  },
  async cancel(id) {
    const s = load();
    const t = s.trades.find((x) => x.id === id && x.from_user === s.current && x.status === 'pending');
    if (!t) fail('Trade not found or already answered');
    t.status = 'cancelled';
    t.resolved_at = new Date().toISOString();
    save();
    tradeEvent(t, 'UPDATE');
  },
  async counter(tradeId, payload) {
    const s = load();
    const t = s.trades.find((x) => x.id === tradeId);
    if (!t || t.to_user !== s.current) fail('Trade not found');
    if (t.status !== 'pending') fail('This trade is already ' + t.status);
    await this.propose({ ...payload, to: t.from_user });
    s.trades[s.trades.length - 1].counter_of = t.id;
    t.status = 'countered';
    t.resolved_at = new Date().toISOString();
    save();
    tradeEvent(t, 'UPDATE');
  },
  async wishlist() { return clone(load().wishlist); },
  async setWish(cardId, on) {
    const s = load();
    const c = s.cards.find((x) => x.id === cardId);
    if (c && c.creator_id === s.current) fail('You can’t wish for your own card');
    s.wishlist = s.wishlist.filter((w) => !(w.user_id === s.current && w.card_id === cardId));
    if (on) s.wishlist.push({ user_id: s.current, card_id: cardId, created_at: new Date().toISOString() });
    save();
  },
  async allItems() { return clone(load().items); },
  async allVersions() {
    return load().versions.map((v) => ({ id: v.id, card_id: v.card_id, version: v.version, original2_given: v.original2_given, copies_minted: v.copies_minted, msgCount: v.data.msgCount || 0 }));
  },
  // Mirrors supabase/006_activity.sql: hidden cards are left out, messages never included.
  async activity({ before = null, player = null, limit = 40 } = {}) {
    const s = load();
    const hidden = new Set(s.cards.filter((c) => c.hidden).map((c) => c.id));
    const moved = (ids) => s.items.filter((i) => ids.includes(i.id) && !hidden.has(i.card_id))
      .map((i) => ({ card_id: i.card_id, version: (s.versions.find((v) => v.id === i.version_id) || {}).version || 1, edition: i.edition, serial: i.serial }))
      .sort((a, b) => b.edition.localeCompare(a.edition) || a.serial - b.serial);
    const events = [
      ...s.versions.filter((v) => !hidden.has(v.card_id)).map((v) => {
        const c = s.cards.find((x) => x.id === v.card_id);
        return { kind: v.version === 1 ? 'card' : 'version', happened_at: v.created_at, actor: c.creator_id, other: null, card_id: c.id, version: v.version, to_other: [], to_actor: [] };
      }),
      ...s.trades.filter((t) => t.status === 'accepted').map((t) => ({
        kind: 'trade', happened_at: t.resolved_at, actor: t.from_user, other: t.to_user, card_id: null, version: null,
        to_other: moved([...t.offer_items, t.minted_to].filter(Boolean)), to_actor: moved([...t.request_items, t.minted_from].filter(Boolean)),
      })).filter((e) => e.to_other.length || e.to_actor.length),
    ];
    return events
      .filter((e) => (!before || e.happened_at < before) && (!player || e.actor === player || e.other === player))
      .sort((a, b) => b.happened_at.localeCompare(a.happened_at))
      .slice(0, limit);
  },
  // In demo mode every "player" is in this browser, so events are delivered directly.
  onTrades(cb) { tradeListeners.clear(); tradeListeners.add(cb); },

  // ---------- moderation (the demo player is a moderator) ----------
  async report(cardId, reason) {
    const s = load();
    if (s.reports.some((r) => r.card_id === cardId && r.reporter === s.current && r.status === 'open')) return;
    s.reports.push({ id: uid(), card_id: cardId, reporter: s.current, reason: (reason || '').slice(0, 280) || null, status: 'open', created_at: new Date().toISOString() });
    save();
  },
  async reports() { const s = load(); requireAdmin(s); return clone(s.reports).reverse(); },
  async adminSetHidden(cardId, hidden) { const s = load(); requireAdmin(s); s.cards.find((c) => c.id === cardId).hidden = hidden; save(); },
  async adminRemovePortrait(card) {
    const s = load(); requireAdmin(s);
    const c = s.cards.find((x) => x.id === card.id);
    delete c.data.portraitUrl;
    s.versions.filter((v) => v.card_id === c.id).forEach((v) => { delete v.data.portraitUrl; delete v.image_url; });
    save();
  },
  async adminResolve(reportId) { const s = load(); requireAdmin(s); s.reports.find((r) => r.id === reportId).status = 'resolved'; save(); },
};
