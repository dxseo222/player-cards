// Demo backend: same interface as api-supabase.js, but everything lives in this browser's
// localStorage. Used automatically when config.js has no Supabase keys, so the whole app
// (cards, originals/copies, trades) can be tried locally before setting anything up.

import { blankCard } from './card.js?v5';

const KEY = 'player-cards-demo-v1';
let memory = null;
const listeners = new Set();

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

function seed() {
  const s = { users: [], cards: [], items: [], trades: [], current: null };
  const add = (username, card) => {
    const u = { id: uid(), username, avatar_url: null };
    s.users.push(u);
    if (card) {
      const c = { id: uid(), creator_id: u.id, data: card, original2_given: false, copies_minted: 0 };
      s.cards.push(c);
      s.items.push({ id: uid(), card_id: c.id, owner_id: u.id, edition: 'original', serial: 1 });
    }
    return u;
  };
  const me = add('you (demo)', null);
  add('Sample Player A', sampleCard('sample a', 'lilac', 'Grinder · Gamer', '🎮'));
  add('Sample Player B', sampleCard('sample b', 'mono', 'Artificer · Dev', '⌨️'));
  s.current = me.id;
  return s;
}

function load() {
  if (memory) return memory;
  try { const raw = localStorage.getItem(KEY); if (raw) memory = JSON.parse(raw); } catch { /* storage blocked */ }
  if (!memory) { memory = seed(); save(); }
  return memory;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* keep in memory */ } }
function fail(msg) { throw new Error(msg); }
const clone = (x) => JSON.parse(JSON.stringify(x));

function mint(s, cardId, ownerId) {
  const c = s.cards.find((x) => x.id === cardId);
  if (!c.original2_given) {
    c.original2_given = true;
    s.items.push({ id: uid(), card_id: c.id, owner_id: ownerId, edition: 'original', serial: 2 });
  } else {
    c.copies_minted += 1;
    s.items.push({ id: uid(), card_id: c.id, owner_id: ownerId, edition: 'copy', serial: c.copies_minted });
  }
}
function checkItems(s, ids, owner) {
  if (new Set(ids).size !== ids.length) fail('A card is listed twice');
  const ok = s.items.filter((i) => ids.includes(i.id) && i.owner_id === owner && !(i.edition === 'original' && i.serial === 1));
  if (ok.length !== ids.length) fail('One of those cards is not available to trade anymore');
}

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

  async me() { const s = load(); return clone(s.users.find((u) => u.id === s.current)); },
  async players() {
    const s = load();
    return s.users.map((u) => ({ ...clone(u), card: clone(s.cards.find((c) => c.creator_id === u.id) || null) }));
  },
  async myCard() { const s = load(); return clone(s.cards.find((c) => c.creator_id === s.current) || null); },
  async saveCard(data) {
    const s = load();
    let c = s.cards.find((x) => x.creator_id === s.current);
    if (!c) {
      c = { id: uid(), creator_id: s.current, data, original2_given: false, copies_minted: 0 };
      s.cards.push(c);
      s.items.push({ id: uid(), card_id: c.id, owner_id: s.current, edition: 'original', serial: 1 });
    } else c.data = data;
    save();
    return c.id;
  },
  async items(ownerId) { return clone(load().items.filter((i) => i.owner_id === ownerId)); },
  async itemsByIds(ids) { return clone(load().items.filter((i) => ids.includes(i.id))); },
  async trades() {
    const s = load();
    return clone(s.trades.filter((t) => t.from_user === s.current || t.to_user === s.current))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  async propose({ to, offerItems = [], offerMint = false, requestItems = [], requestMint = false, message = '' }) {
    const s = load();
    const me = s.current;
    if (to === me) fail('You cannot trade with yourself');
    if (!offerItems.length && !requestItems.length && !offerMint && !requestMint) fail('Add at least one card to the trade');
    checkItems(s, offerItems, me);
    checkItems(s, requestItems, to);
    if (offerMint && !s.cards.some((c) => c.creator_id === me)) fail('Make your card before trading it');
    if (requestMint && !s.cards.some((c) => c.creator_id === to)) fail('That player has not made a card yet');
    s.trades.push({
      id: uid(), from_user: me, to_user: to, offer_items: offerItems, offer_mint: offerMint,
      request_items: requestItems, request_mint: requestMint, message: message.slice(0, 280) || null,
      status: 'pending', created_at: new Date().toISOString(), resolved_at: null,
    });
    save();
  },
  async respond(id, accept) {
    const s = load();
    const t = s.trades.find((x) => x.id === id);
    if (!t || t.to_user !== s.current) fail('Trade not found');
    if (t.status !== 'pending') fail('This trade is already ' + t.status);
    t.resolved_at = new Date().toISOString();
    if (!accept) { t.status = 'declined'; save(); return 'declined'; }
    try { checkItems(s, t.offer_items, t.from_user); checkItems(s, t.request_items, t.to_user); } catch { t.status = 'failed'; save(); return 'failed'; }
    s.items.forEach((i) => {
      if (t.offer_items.includes(i.id)) i.owner_id = t.to_user;
      else if (t.request_items.includes(i.id)) i.owner_id = t.from_user;
    });
    if (t.offer_mint) mint(s, s.cards.find((c) => c.creator_id === t.from_user).id, t.to_user);
    if (t.request_mint) mint(s, s.cards.find((c) => c.creator_id === t.to_user).id, t.from_user);
    t.status = 'accepted';
    save();
    return 'accepted';
  },
  async cancel(id) {
    const s = load();
    const t = s.trades.find((x) => x.id === id && x.from_user === s.current && x.status === 'pending');
    if (!t) fail('Trade not found or already answered');
    t.status = 'cancelled';
    t.resolved_at = new Date().toISOString();
    save();
  },
};
