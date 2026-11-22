import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { renderCard, blankCard, cleanCard, editionLabel, THEMES, RARITIES } from './card.js';
import { parseExport, sources, computeStats, suggest } from './export.js';

const live = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const { api } = live ? await import('./api-supabase.js') : await import('./api-local.js');

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const state = { me: null, players: [], cardsById: new Map(), playersById: new Map() };

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
}

async function attempt(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message || String(e), true); throw e; }
}

function openModal(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').replaceChildren(body);
  $('#modal').hidden = false;
  setTimeout(() => $('#modalClose').focus(), 0);
}
function closeModal() { $('#modal').hidden = true; $('#modalBody').replaceChildren(); }
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

const playerName = (id) => (state.playersById.get(id) || {}).username || 'Someone';
const cardName = (cardId) => { const c = state.cardsById.get(cardId); return c ? cleanCard(c.data).name : 'a card'; };
const isLocked = (i) => i.edition === 'original' && i.serial === 1;
const nextEdition = (card) => (card.original2_given ? 'Copy #' + (card.copies_minted + 1) : 'Original 2/2');

async function refreshPlayers() {
  state.players = await api.players();
  state.playersById = new Map(state.players.map((p) => [p.id, p]));
  state.cardsById = new Map(state.players.filter((p) => p.card).map((p) => [p.card.id, p.card]));
}

async function refreshBadge() {
  if (!state.me) return;
  const trades = await api.trades();
  const n = trades.filter((t) => t.status === 'pending' && t.to_user === state.me.id).length;
  const b = $('#tradeBadge');
  b.hidden = n === 0;
  b.textContent = n;
}

// ---------------------------------------------------------------- header

async function renderHeader() {
  const who = $('#who');
  who.replaceChildren();
  $('#tabs').hidden = !state.me;
  $('#demoBanner').hidden = live;
  if (!state.me) return;
  if (live) {
    if (state.me.avatar_url) who.append(h('img', { src: state.me.avatar_url, alt: '' }));
    who.append(h('span', { text: state.me.username }));
    who.append(h('button', { class: 'btn', type: 'button', onclick: () => api.signOut() }, 'Sign out'));
  } else {
    const users = await api.demoUsers();
    const sel = h('select', { id: 'demoUser', 'aria-label': 'Acting as' },
      users.map((u) => h('option', { value: u.id, selected: u.id === state.me.id }, u.username)));
    sel.addEventListener('change', () => api.switchUser(sel.value));
    who.append(h('span', { class: 'muted small', text: 'Acting as' }), sel,
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { if (window.confirm('Reset all demo data?')) api.resetDemo(); } }, 'Reset demo'));
  }
}

// ---------------------------------------------------------------- sign in (live only)

function renderSignIn() {
  const sample = blankCard('your name');
  Object.assign(sample, {
    aka: 'your old username', since: 'Mar 2022', className: 'Bard · Producer', tags: ['Night owl', 'Server founder'],
    traits: [{ name: 'Loyalty', value: 9 }, { name: 'Heart', value: 8 }, { name: 'Hustle', value: 9 }, { name: 'Chaos', value: 7 }, { name: 'Tech', value: 6 }, { name: 'Patience', value: 3 }],
    quote: 'your most you message goes here', quoteSource: 'you, 2026', portraitLabels: ['online at 4am', '😭 ×9,999', ''],
    footer: ['100,000 msgs', '97% days online', "'22–'26"],
  });
  view.replaceChildren(h('section', { class: 'hero' },
    h('div', {},
      h('h1', {}, 'Player Cards'),
      h('p', { class: 'lead' }, 'Turn your Discord history into a player card, then trade cards with your friends.'),
      h('ul', { class: 'rules' },
        h('li', {}, 'Your messages are read in your browser. Only the finished card is saved.'),
        h('li', {}, 'Every card has two originals. You keep Original 1/2 forever.'),
        h('li', {}, 'Your first trade hands out Original 2/2. After that, numbered copies.')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => attempt(() => api.signIn()) }, 'Sign in with Discord')),
    renderCard(sample)));
}

// ---------------------------------------------------------------- my card

let draft = null;
let parsedExport = null;
let excluded = new Set();
let lastStats = null;
let quoteSeed = 1;

async function renderMyCard() {
  const mine = await api.myCard();
  draft = mine ? cleanCard(mine.data) : Object.assign(blankCard(state.me.username), { name: (state.me.username || 'player').toLowerCase().slice(0, 24) });

  const preview = h('div', { class: 'preview' });
  const paint = () => {
    const myItem = mine ? { edition: 'original', serial: 1 } : null;
    preview.replaceChildren(renderCard(draft, { item: myItem }), h('div', { class: 'hint', text: 'Click the card to flip it' }));
  };
  let t;
  const repaint = () => { clearTimeout(t); t = setTimeout(paint, 60); };

  const form = h('div', { class: 'stack' });
  const rebuild = () => form.replaceChildren(exportPanel(rebuild, repaint), cardForm(repaint), saveBar(mine));
  rebuild();
  paint();

  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {},
      h('h1', {}, mine ? 'Your card' : 'Make your card'),
      h('p', { class: 'lead' }, mine
        ? 'Edit anything and save. Every copy out there updates too.'
        : 'Fill it in from your Discord export, or by hand. Saving gives you Original 1/2.'))),
    h('div', { class: 'builder' }, form, preview));
}

function saveBar(mine) {
  return h('div', { class: 'row' },
    h('button', {
      class: 'btn primary', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await attempt(() => api.saveCard(cleanCard(draft)), mine ? 'Card saved' : 'Card created. Original 1/2 is in your collection.');
          await refreshPlayers();
          if (!mine) renderMyCard();
        } finally { e.target.disabled = false; }
      },
    }, mine ? 'Save card' : 'Create card'),
    h('span', { class: 'muted small', text: 'Card text is visible to everyone signed in.' }));
}

function exportPanel(rebuild, repaint) {
  const panel = h('section', { class: 'panel stack' },
    h('div', {}, h('h3', {}, 'Fill from your Discord export'),
      h('p', { class: 'muted small' }, 'Discord → Settings → Data & Privacy → Request all of my data. Unzip it and pick the Messages folder inside. Messages are read in this browser and never uploaded.')));

  const input = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true, id: 'exportDir' });
  const bar = h('div', { class: 'progress', hidden: true }, h('i'));
  const status = h('div', { class: 'small muted' });
  input.addEventListener('change', async () => {
    const files = [...input.files].filter((f) => /\.json$/i.test(f.name));
    if (!files.length) return;
    bar.hidden = false;
    status.textContent = 'Reading ' + files.length.toLocaleString() + ' files…';
    try {
      parsedExport = await parseExport(files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })), (p) => { bar.firstChild.style.width = Math.round(p * 100) + '%'; });
      excluded = new Set();
      lastStats = null;
      rebuild();
    } catch (e) {
      bar.hidden = true;
      status.textContent = e.message;
    }
  });
  panel.append(h('div', { class: 'drop' },
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, parsedExport ? 'Pick a different folder' : 'Choose Messages folder'),
      parsedExport ? h('span', { class: 'small muted', text: parsedExport.channels.length.toLocaleString() + ' channels loaded' }) : null),
    input, bar, status));

  if (!parsedExport) return panel;

  // exclude list
  const groups = sources(parsedExport);
  const list = h('div', { class: 'sources' });
  for (const g of groups) {
    const groupBox = h('input', { type: 'checkbox', checked: g.channels.every((c) => !excluded.has(c.id)), 'aria-label': 'Include ' + g.guild });
    const chBoxes = g.channels.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: !excluded.has(c.id) });
      cb.addEventListener('change', () => { cb.checked ? excluded.delete(c.id) : excluded.add(c.id); groupBox.checked = g.channels.every((x) => !excluded.has(x.id)); });
      return h('label', { class: 'ch' }, cb, h('span', { class: 'name', text: g.kind === 'server' ? '#' + c.name : c.name }), h('span', { class: 'count', text: c.count.toLocaleString() }));
    });
    groupBox.addEventListener('click', (e) => e.stopPropagation());
    groupBox.addEventListener('change', () => {
      g.channels.forEach((c) => (groupBox.checked ? excluded.delete(c.id) : excluded.add(c.id)));
      chBoxes.forEach((l) => { l.querySelector('input').checked = groupBox.checked; });
    });
    list.append(h('details', {},
      h('summary', {}, groupBox, h('span', { text: g.guild }), h('span', { class: 'count', text: g.count.toLocaleString() + ' · ' + g.channels.length + ' ch' })),
      chBoxes));
  }
  panel.append(h('div', { class: 'stack' },
    h('div', {}, h('h3', {}, 'Leave anything out?'),
      h('p', { class: 'muted small' }, 'Untick servers or open them to untick single channels. Unticked messages are skipped completely: not counted, not quoted.')),
    list,
    h('div', { class: 'row' }, h('button', {
      class: 'btn primary', type: 'button', onclick: () => {
        lastStats = computeStats(parsedExport, excluded);
        if (!lastStats) { toast('Nothing left to count. Tick at least one channel.', true); return; }
        const s = suggest(lastStats, quoteSeed);
        Object.assign(draft, {
          since: s.since, className: s.className, tags: s.tags, traits: s.traits,
          quote: s.quote || draft.quote, quoteSource: s.quote ? s.quoteSource : draft.quoteSource,
          emblem: s.emblem, portraitLabels: s.portraitLabels, weaknesses: s.weaknesses,
          catchphrases: s.catchphrases, footer: s.footer,
        });
        if (!draft.abilities.some((a) => a.name)) draft.abilities = s.abilities;
        draft = cleanCard(draft);
        rebuild();
        repaint();
        toast('Card filled in. Edit anything below.');
      },
    }, lastStats ? 'Count again' : 'Count and fill in my card'))));

  if (lastStats) {
    const pick = () => {
      const s = suggest(lastStats, quoteSeed);
      const box = h('div', { class: 'quotes', role: 'radiogroup', 'aria-label': 'Quote' });
      s.quoteCandidates.forEach((q) => {
        const r = h('input', { type: 'radio', name: 'quotePick', checked: q === draft.quote });
        r.addEventListener('change', () => { draft.quote = q.slice(0, 120); rebuild(); repaint(); });
        box.append(h('label', {}, r, h('span', { text: q })));
      });
      return box;
    };
    panel.append(h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('h3', {}, 'Pick a quote'),
        h('button', { class: 'btn', type: 'button', onclick: () => { quoteSeed++; rebuild(); } }, 'Shuffle')),
      h('p', { class: 'muted small' }, 'Lines you actually sent. Only the one you pick goes on the card.'),
      pick()));
  }
  return panel;
}

function cardForm(repaint) {
  const set = (fn) => (e) => { fn(e.target.value, e); repaint(); };
  const text = (label, value, fn, attrs = {}) => h('label', { class: 'f' }, label, h('input', { type: 'text', value: value || '', oninput: set(fn), ...attrs }));
  const area = (label, value, fn, attrs = {}) => h('label', { class: 'f' }, label, h('textarea', { oninput: set(fn), ...attrs }, value || ''));
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);

  const identity = h('fieldset', {}, h('legend', {}, 'Identity'),
    h('div', { class: 'grid2' },
      text('Name on the card', draft.name, (v) => { draft.name = v; }, { maxlength: 24 }),
      text('Also known as', draft.aka, (v) => { draft.aka = v; }, { maxlength: 40 })),
    h('div', { class: 'grid2' },
      text('Since', draft.since, (v) => { draft.since = v; }, { maxlength: 24, placeholder: 'Mar 2022' }),
      h('label', { class: 'f' }, 'Rarity', h('select', { onchange: set((v) => { draft.rarity = v; }) },
        RARITIES.map((r) => h('option', { value: r, selected: r === draft.rarity }, r))))),
    h('div', { class: 'grid2' },
      text('Class', draft.className, (v) => { draft.className = v; }, { maxlength: 32 }),
      text('Tags (comma separated, up to 4)', draft.tags.join(', '), (v) => { draft.tags = list(v).slice(0, 4); })));

  const look = h('fieldset', {}, h('legend', {}, 'Look'),
    h('div', { class: 'grid2' },
      h('label', { class: 'f' }, 'Theme', h('select', { onchange: set((v) => { draft.theme = v; }) },
        Object.entries(THEMES).map(([k, t]) => h('option', { value: k, selected: k === draft.theme }, t.label)))),
      text('Portrait (an emoji, or "moon")', draft.emblem, (v) => { draft.emblem = v.trim() || 'moon'; }, { maxlength: 8 })),
    h('div', { class: 'row' },
      h('label', { class: 'f' }, 'Accent color', h('input', { type: 'color', value: draft.accent || '#b3202b', oninput: set((v) => { draft.accent = v; }) })),
      h('button', { class: 'btn ghost small', type: 'button', onclick: (e) => { draft.accent = ''; repaint(); toast('Using the theme’s own color'); } }, 'Use theme color')),
    h('div', { class: 'grid3' }, [0, 1, 2].map((i) =>
      text(['Portrait label, top right', 'Portrait label, bottom left', 'Portrait label, bottom right'][i], draft.portraitLabels[i], (v) => { draft.portraitLabels[i] = v; }, { maxlength: 26 }))));

  const traits = h('fieldset', {}, h('legend', {}, 'Traits'),
    draft.traits.map((t, i) => {
      const out = h('output', { text: t.value });
      return h('div', { class: 'trait-row' },
        h('input', { type: 'text', value: t.name, maxlength: 12, 'aria-label': 'Trait ' + (i + 1) + ' name', oninput: set((v) => { draft.traits[i].name = v; }) }),
        h('input', { type: 'range', min: 0, max: 10, value: t.value, 'aria-label': (t.name || 'Trait') + ' rating', oninput: set((v) => { draft.traits[i].value = +v; out.textContent = v; }) }),
        out);
    }));

  const words = h('fieldset', {}, h('legend', {}, 'Quote and catchphrases'),
    area('Quote', draft.quote, (v) => { draft.quote = v; }, { maxlength: 120, rows: 2 }),
    h('div', { class: 'grid2' },
      text('Quote source', draft.quoteSource, (v) => { draft.quoteSource = v; }, { maxlength: 40 }),
      text('Catchphrases (comma separated)', draft.catchphrases.join(', '), (v) => { draft.catchphrases = list(v).slice(0, 6); })));

  while (draft.abilities.length < 4) draft.abilities.push({ name: '', kind: '', desc: '' });
  const abilities = h('fieldset', {}, h('legend', {}, 'Abilities'),
    draft.abilities.map((a, i) => h('div', { class: 'ability-box' },
      h('div', { class: 'grid2' },
        text('Ability ' + (i + 1), a.name, (v) => { draft.abilities[i].name = v; }, { maxlength: 32 }),
        text('Type (Passive, Active…)', a.kind, (v) => { draft.abilities[i].kind = v; }, { maxlength: 12 })),
      text('What it does', a.desc, (v) => { draft.abilities[i].desc = v; }, { maxlength: 140 }))));

  while (draft.weaknesses.length < 3) draft.weaknesses.push('');
  const back = h('fieldset', {}, h('legend', {}, 'Weaknesses and lore'),
    draft.weaknesses.map((w, i) => text('Weakness ' + (i + 1), w, (v) => { draft.weaknesses[i] = v; }, { maxlength: 90 })),
    area('Lore', draft.lore, (v) => { draft.lore = v; }, { maxlength: 320, rows: 3 }),
    h('div', { class: 'grid3' }, [0, 1, 2].map((i) =>
      text('Footer ' + (i + 1), draft.footer[i], (v) => { draft.footer[i] = v; }, { maxlength: 22 }))));

  return h('section', { class: 'panel stack' }, identity, look, traits, words, abilities, back);
}

// ---------------------------------------------------------------- collection

async function renderCollection() {
  const items = await api.items(state.me.id);
  items.sort((a, b) => cardName(a.card_id).localeCompare(cardName(b.card_id)) || (a.edition === b.edition ? a.serial - b.serial : a.edition === 'original' ? -1 : 1));
  const grid = h('div', { class: 'cards' });
  for (const it of items) {
    const card = state.cardsById.get(it.card_id);
    if (!card) continue;
    grid.append(h('div', { class: 'slot' },
      renderCard(card.data, { item: it, size: 'thumb' }),
      h('div', { class: 'meta' }, h('b', { text: editionLabel(it) }), ' · made by ', playerName(card.creator_id),
        isLocked(it) ? h('div', { class: 'muted', text: 'Yours forever, can’t be traded' }) : null)));
  }
  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Collection'),
      h('p', { class: 'lead' }, items.length + (items.length === 1 ? ' card' : ' cards') + '. Click one to flip it.'))),
    items.length ? grid : h('div', { class: 'empty' }, h('h3', {}, 'No cards yet'),
      h('p', {}, 'Make your card to get Original 1/2, then trade with players to collect theirs.'),
      h('a', { class: 'btn primary', href: '#card' }, 'Make your card')));
}

// ---------------------------------------------------------------- players

async function renderPlayers() {
  await refreshPlayers();
  const grid = h('div', { class: 'cards' });
  const others = state.players.filter((p) => p.id !== state.me.id);
  for (const p of others) {
    const out = p.card ? (p.card.original2_given ? 1 : 0) + p.card.copies_minted : 0;
    grid.append(h('div', { class: 'slot' },
      p.card ? renderCard(p.card.data, { size: 'thumb' }) : h('div', { class: 'empty', style: 'width:100%' }, 'No card yet'),
      h('div', { class: 'meta' }, h('b', { text: p.username }),
        p.card ? h('div', { class: 'muted', text: out ? out + ' traded out so far · next is ' + nextEdition(p.card) : 'Original 2/2 still available' }) : null),
      h('button', { class: 'btn', type: 'button', onclick: () => openTrade(p) }, 'Propose a trade')));
  }
  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Players'),
      h('p', { class: 'lead' }, live ? 'Everyone who has signed in. Invite friends by sending them this site’s link.' : 'Sample players for demo mode.'))),
    others.length ? grid : h('div', { class: 'empty' }, h('h3', {}, 'Nobody else is here yet'), h('p', {}, 'Send your friends the link so they can sign in and make cards.')));
}

async function openTrade(other) {
  await refreshPlayers();
  const mine = (await api.items(state.me.id)).filter((i) => !isLocked(i));
  const theirs = (await api.items(other.id)).filter((i) => !isLocked(i));
  const myCard = state.players.find((p) => p.id === state.me.id)?.card || null;
  const theirCard = state.players.find((p) => p.id === other.id)?.card || null;
  const pick = { offer: new Set(), request: new Set(), offerMint: false, requestMint: false };

  const side = (title, items, key, mintCard, mintKey, mintLabel) => {
    const box = h('div', { class: 'pick' });
    if (mintCard) {
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => { pick[mintKey] = cb.checked; });
      box.append(h('label', { class: 'mint' }, cb, h('span', {}, mintLabel, ' ', h('span', { class: 'muted', text: '(' + nextEdition(mintCard) + ')' }))));
    }
    items.forEach((it) => {
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => { cb.checked ? pick[key].add(it.id) : pick[key].delete(it.id); });
      box.append(h('label', {}, cb, h('span', { text: cardName(it.card_id) + ' · ' + editionLabel(it) })));
    });
    if (!mintCard && !items.length) box.append(h('p', { class: 'muted small', text: 'Nothing to trade here yet.' }));
    return h('div', {}, h('h4', {}, title), box);
  };

  const msg = h('input', { type: 'text', maxlength: 280, placeholder: 'Add a message (optional)', 'aria-label': 'Message' });
  const send = h('button', {
    class: 'btn primary', type: 'button', onclick: async () => {
      send.disabled = true;
      try {
        await attempt(() => api.propose({
          to: other.id, offerItems: [...pick.offer], offerMint: pick.offerMint,
          requestItems: [...pick.request], requestMint: pick.requestMint, message: msg.value.trim(),
        }), 'Offer sent to ' + other.username);
        closeModal();
      } catch { send.disabled = false; }
    },
  }, 'Send offer');

  openModal('Trade with ' + other.username, h('div', { class: 'stack' },
    h('div', { class: 'trade-sides' },
      side('You give', mine, 'offer', myCard, 'offerMint', 'A new edition of your card'),
      side('You get', theirs, 'request', theirCard, 'requestMint', 'A new edition of ' + other.username + '’s card')),
    h('p', { class: 'muted small' }, 'Original 1/2 cards stay with their creators and never show up here. Nothing moves until they accept.'),
    msg,
    h('div', { class: 'row' }, send, h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'))));
}

// ---------------------------------------------------------------- trades

async function renderTrades() {
  await refreshPlayers();
  const trades = await api.trades();
  const ids = [...new Set(trades.flatMap((t) => [...t.offer_items, ...t.request_items]))];
  const items = new Map((await api.itemsByIds(ids)).map((i) => [i.id, i]));

  const chipsFor = (itemIds, mint, creatorId) => {
    const c = h('div', { class: 'chips' });
    if (mint) c.append(h('span', { class: 'chip orig', text: 'New edition of ' + playerName(creatorId) + '’s card' }));
    itemIds.forEach((id) => {
      const it = items.get(id);
      c.append(h('span', { class: 'chip' + (it && it.edition === 'original' ? ' orig' : ''), text: it ? cardName(it.card_id) + ' · ' + editionLabel(it) : 'a card' }));
    });
    if (!mint && !itemIds.length) c.append(h('span', { class: 'muted small', text: 'nothing' }));
    return c;
  };

  const tradeEl = (t) => {
    const incoming = t.to_user === state.me.id;
    const other = incoming ? t.from_user : t.to_user;
    const give = incoming ? chipsFor(t.request_items, t.request_mint, t.to_user) : chipsFor(t.offer_items, t.offer_mint, t.from_user);
    const get = incoming ? chipsFor(t.offer_items, t.offer_mint, t.from_user) : chipsFor(t.request_items, t.request_mint, t.to_user);
    const actions = h('div', { class: 'row' });
    if (t.status === 'pending' && incoming) {
      actions.append(
        h('button', { class: 'btn ok', type: 'button', onclick: async () => {
          const r = await attempt(() => api.respond(t.id, true));
          toast(r === 'accepted' ? 'Trade done. Check your collection.' : 'That trade can’t go through anymore: one of the cards changed hands.', r !== 'accepted');
          renderTrades(); refreshBadge();
        } }, 'Accept'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { await attempt(() => api.respond(t.id, false), 'Declined'); renderTrades(); refreshBadge(); } }, 'Decline'));
    } else if (t.status === 'pending') {
      actions.append(h('button', { class: 'btn', type: 'button', onclick: async () => { await attempt(() => api.cancel(t.id), 'Offer cancelled'); renderTrades(); } }, 'Cancel offer'));
    }
    return h('div', { class: 'panel trade' },
      h('div', { class: 'row' },
        h('b', { text: incoming ? playerName(other) + ' wants to trade' : 'You offered ' + playerName(other) }),
        h('span', { class: 'status ' + t.status, text: t.status }),
        h('span', { class: 'muted small', text: new Date(t.created_at).toLocaleString() })),
      t.message ? h('p', { class: 'muted', style: 'margin:0', text: '“' + t.message + '”' }) : null,
      h('div', { class: 'trade-sides' }, h('div', {}, h('h4', {}, 'You give'), give), h('div', {}, h('h4', {}, 'You get'), get)),
      actions);
  };

  const incoming = trades.filter((t) => t.status === 'pending' && t.to_user === state.me.id);
  const outgoing = trades.filter((t) => t.status === 'pending' && t.from_user === state.me.id);
  const past = trades.filter((t) => t.status !== 'pending').slice(0, 30);
  const section = (title, list, empty) => h('section', { class: 'stack' }, h('h2', {}, title),
    list.length ? list.map(tradeEl) : h('p', { class: 'muted', text: empty }));

  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Trades'),
      h('p', { class: 'lead' }, 'Offers people sent you, offers you sent, and what already happened.')),
      h('a', { class: 'btn primary', href: '#players' }, 'New trade')),
    h('div', { class: 'stack', style: 'gap:34px' },
      section('Waiting on you', incoming, 'No offers waiting on you.'),
      section('Waiting on them', outgoing, 'You have no open offers.'),
      section('History', past, 'No finished trades yet.')));
}

// ---------------------------------------------------------------- routing

const routes = { card: renderMyCard, collection: renderCollection, players: renderPlayers, trades: renderTrades };

async function route() {
  if (!state.me) { renderSignIn(); return; }
  const tab = (location.hash || '#card').slice(1);
  const fn = routes[tab] || renderMyCard;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (routes[tab] ? tab : 'card')));
  view.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  try { await fn(); } catch (e) { view.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Something went wrong'), h('p', { text: e.message || String(e) }))); }
  refreshBadge().catch(() => {});
}

async function boot() {
  try {
    state.me = await api.init();
    if (state.me) await refreshPlayers();
  } catch (e) {
    view.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Could not reach the server'), h('p', { text: e.message })));
    return;
  }
  await renderHeader();
  route();
}

api.onChange(async () => {
  state.me = await api.me();
  parsedExport = null; lastStats = null; excluded = new Set();
  if (state.me) await refreshPlayers();
  await renderHeader();
  route();
});
window.addEventListener('hashchange', route);
boot();
