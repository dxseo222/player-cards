// Renders a player card (front + back) from plain card data. All text goes through
// textContent, never innerHTML, because cards are made by other people.

export const THEMES = {
  requiem: { label: 'Requiem (black + blood red)', heading: (t) => '༒✞' + t + '✞༒', mark: '✞', bullet: '♱' },
  lilac: { label: 'Lilac (holo night)', heading: (t) => t.toUpperCase(), mark: '✦', bullet: '✦' },
  mono: { label: 'Mono (black + white)', heading: (t) => '// ' + t, mark: '+', bullet: '—' },
};

export const RARITIES = ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'];

// Rarity comes from how many messages the export counted; it can't be picked by hand.
// Cards made without an export stay Common.
export const RARITY_TIERS = [
  { name: 'Mythic', min: 150000 },
  { name: 'Legendary', min: 75000 },
  { name: 'Epic', min: 25000 },
  { name: 'Rare', min: 5000 },
  { name: 'Common', min: 0 },
];
export function rarityFor(count) {
  const n = Number(count) || 0;
  return RARITY_TIERS.find((t) => n >= t.min).name;
}
export function nextTier(count) {
  const n = Number(count) || 0;
  const higher = RARITY_TIERS.filter((t) => t.min > n);
  return higher.length ? higher[higher.length - 1] : null;
}

export function blankCard(name = '') {
  return {
    v: 1,
    name: name || 'player',
    aka: '',
    since: '',
    msgCount: 0,
    rarity: 'Common',
    className: 'Wanderer',
    tags: [],
    traits: [
      { name: 'Loyalty', value: 5 }, { name: 'Heart', value: 5 }, { name: 'Hustle', value: 5 },
      { name: 'Chaos', value: 5 }, { name: 'Tech', value: 5 }, { name: 'Patience', value: 5 },
    ],
    quote: '',
    quoteSource: '',
    emblem: 'moon',
    portraitLabels: ['', '', ''],
    abilities: [{ name: '', kind: '', desc: '' }],
    weaknesses: [],
    lore: '',
    catchphrases: [],
    footer: ['', '', ''],
    theme: 'requiem',
    accent: '',
  };
}

// Keeps whatever shape arrives (from the database or a form) within sane limits.
export function cleanCard(c) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const b = blankCard();
  return {
    v: 1,
    name: s(c.name, 24) || 'player',
    aka: s(c.aka, 40),
    since: s(c.since, 24),
    msgCount: Math.max(0, Math.min(10_000_000, Math.round(Number(c.msgCount) || 0))),
    rarity: rarityFor(c.msgCount),
    className: s(c.className, 32),
    tags: arr(c.tags).map((t) => s(t, 24)).filter(Boolean).slice(0, 4),
    traits: arr(c.traits).slice(0, 6).map((t) => ({ name: s(t.name, 12), value: Math.max(0, Math.min(10, Math.round(+t.value || 0))) })),
    quote: s(c.quote, 120),
    quoteSource: s(c.quoteSource, 40),
    emblem: s(c.emblem, 8) || 'moon',
    portraitLabels: [0, 1, 2].map((i) => s(arr(c.portraitLabels)[i], 26)),
    abilities: arr(c.abilities).slice(0, 4).map((a) => ({ name: s(a.name, 32), kind: s(a.kind, 12), desc: s(a.desc, 140) })),
    weaknesses: arr(c.weaknesses).map((w) => s(w, 90)).filter(Boolean).slice(0, 3),
    lore: s(c.lore, 320),
    catchphrases: arr(c.catchphrases).map((w) => s(w, 16)).filter(Boolean).slice(0, 6),
    footer: [0, 1, 2].map((i) => s(arr(c.footer)[i], 22)),
    theme: THEMES[c.theme] ? c.theme : 'requiem',
    accent: /^#[0-9a-f]{6}$/i.test(c.accent || '') ? c.accent : '',
  };
}

export function editionLabel(item) {
  if (!item) return '';
  return item.edition === 'original' ? 'Original ' + item.serial + '/2' : 'Copy #' + item.serial;
}

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// opts: { item, flippable (default true), size: 'full' | 'thumb' }
export function renderCard(raw, opts = {}) {
  const c = cleanCard(raw);
  const theme = THEMES[c.theme];
  const flippable = opts.flippable !== false;

  const card = h('div', 'pc' + (opts.size === 'thumb' ? ' pc-thumb' : ''));
  card.dataset.theme = c.theme;
  if (c.accent) card.style.setProperty('--pc-accent', c.accent);
  if (flippable) {
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', 'false');
    card.setAttribute('aria-label', c.name + ' card. Press to flip.');
    const flip = () => {
      const on = card.classList.toggle('flipped');
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    card.addEventListener('click', flip);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  }
  card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width;
    if (card.classList.contains('flipped')) x = 1 - x;
    card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
    card.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 100).toFixed(1) + '%');
  });

  const inner = h('div', 'pc-inner');
  card.append(inner);

  // ---------- front ----------
  const front = h('section', 'pc-face pc-front');
  const fb = h('div', 'pc-body');
  front.append(fb);
  fb.append(h('span', 'pc-corner tl', theme.mark), h('span', 'pc-corner tr', theme.mark));

  const top = h('div', 'pc-top');
  const who = h('div');
  who.append(h('div', 'pc-name', c.name));
  const aka = [c.aka ? 'aka ' + c.aka : '', c.since ? 'since ' + c.since : ''].filter(Boolean).join(' · ');
  if (aka) who.append(h('div', 'pc-aka', aka));
  const rarity = h('div', 'pc-rarity', c.rarity);
  rarity.dataset.rarity = c.rarity.toLowerCase();
  rarity.title = c.msgCount ? c.msgCount.toLocaleString('en-US') + ' messages' : 'Made without a Discord export';
  top.append(who, rarity);
  fb.append(top);

  const portrait = h('div', 'pc-portrait');
  portrait.setAttribute('aria-hidden', 'true');
  ['c1', 'c2', 'c3'].forEach((k) => portrait.append(h('span', 'pc-cross ' + k, theme.mark)));
  if (c.emblem === 'moon') portrait.append(h('span', 'pc-moon'));
  else portrait.append(h('span', 'pc-emblem', c.emblem));
  ['tr', 'bl', 'br'].forEach((pos, i) => { if (c.portraitLabels[i]) portrait.append(h('span', 'pc-lbl ' + pos, c.portraitLabels[i])); });
  fb.append(portrait);

  const tags = h('div', 'pc-tags');
  if (c.className) tags.append(h('span', 'pc-tag main', c.className));
  c.tags.forEach((t) => tags.append(h('span', 'pc-tag', t)));
  fb.append(tags);

  if (c.traits.length) {
    const traits = h('div', 'pc-traits');
    c.traits.forEach((t) => {
      if (!t.name) return;
      const row = h('div', 'pc-trait');
      const pips = h('div', 'pc-pips');
      pips.setAttribute('role', 'img');
      pips.setAttribute('aria-label', t.name + ' ' + t.value + ' out of 10');
      for (let i = 0; i < 10; i++) pips.append(h('i', i < t.value ? 'on' : ''));
      row.append(h('span', null, t.name), pips);
      traits.append(row);
    });
    fb.append(traits);
  }

  if (c.quote) {
    const q = h('blockquote', 'pc-quote', '“' + c.quote + '”');
    if (c.quoteSource) q.append(h('small', null, c.quoteSource));
    fb.append(q);
  }

  const foot = h('div', 'pc-foot');
  c.footer.forEach((f) => foot.append(h('span', null, f)));
  fb.append(foot);
  if (opts.item) fb.append(h('div', 'pc-edition' + (opts.item.edition === 'original' ? ' orig' : ''), editionLabel(opts.item)));

  // ---------- back ----------
  const back = h('section', 'pc-face pc-back');
  const bb = h('div', 'pc-body');
  back.append(bb);
  bb.append(h('span', 'pc-corner tl', theme.mark), h('span', 'pc-corner tr', theme.mark));

  const section = (title) => { const s = h('div', 'pc-sec'); s.append(h('h4', 'pc-chan', theme.heading(title))); return s; };

  const abilities = c.abilities.filter((a) => a.name || a.desc);
  if (abilities.length) {
    const s = section('abilities');
    abilities.forEach((a) => {
      const row = h('div', 'pc-ability');
      const txt = h('div');
      const name = h('b', null, a.name);
      if (a.kind) name.append(h('span', 'pc-kind', a.kind));
      txt.append(name);
      if (a.desc) txt.append(h('p', null, a.desc));
      row.append(h('span', 'pc-ic', theme.bullet), txt);
      s.append(row);
    });
    bb.append(s);
  }
  if (c.weaknesses.length) {
    const s = section('weaknesses');
    const ul = h('ul', 'pc-weak');
    c.weaknesses.forEach((w) => { const li = h('li'); li.append(h('span', 'pc-wb', theme.mark), document.createTextNode(w)); ul.append(li); });
    s.append(ul);
    bb.append(s);
  }
  if (c.lore) { const s = section('lore'); s.append(h('p', 'pc-lore', c.lore)); bb.append(s); }
  if (c.catchphrases.length) {
    const s = section('catchphrases');
    const m = h('div', 'pc-moves');
    c.catchphrases.forEach((w) => m.append(h('span', 'pc-move', w)));
    s.append(m);
    bb.append(s);
  }
  const bfoot = h('div', 'pc-foot');
  bfoot.append(h('span', null, c.name), h('span', null, opts.item ? editionLabel(opts.item) : c.rarity));
  bb.append(bfoot);

  inner.append(front, back);
  return card;
}
