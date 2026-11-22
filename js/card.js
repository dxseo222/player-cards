// Renders a player card (front + back) from plain card data. All text goes through
// textContent, never innerHTML, because cards are made by other people.

export const THEMES = {
  requiem: { label: 'Requiem (black + blood red)', heading: (t) => '༒✞' + t + '✞༒', mark: '✞', bullet: '♱' },
  lilac: { label: 'Lilac (holo night)', heading: (t) => t.toUpperCase(), mark: '✦', bullet: '✦' },
  mono: { label: 'Mono (black + white)', heading: (t) => '// ' + t, mark: '+', bullet: '—' },
  vapor: { label: 'Vapor (pink + cyan)', heading: (t) => '✧ ' + t + ' ✧', mark: '✧', bullet: '✧' },
  toxic: { label: 'Toxic (acid green)', heading: (t) => '[' + t + ']', mark: '✕', bullet: '▸' },
  gold: { label: 'Gold (black + gold)', heading: (t) => '— ' + t + ' —', mark: '◆', bullet: '◆' },
  ice: { label: 'Ice (frost blue)', heading: (t) => '✻ ' + t, mark: '✻', bullet: '✻' },
};

// Each option is applied as a data attribute on the card; css/card.css does the rest.
export const NAME_FONTS = {
  theme: 'Theme default', gothic: 'Gothic', grotesk: 'Grotesk', mono: 'Mono', serif: 'Serif',
  marker: 'Marker', pixel: 'Pixel', block: 'Block', script: 'Script',
};
export const FRAMES = { theme: 'Theme default', double: 'Double', holo: 'Holo foil', glitch: 'Glitch', thin: 'Thin' };
export const FINISHES = { none: 'None', shimmer: 'Shimmer', grain: 'Grain', glow: 'Glow' };
export const COLOR_KEYS = { frame: 'Frame', bg: 'Background', text: 'Text', accent: 'Accent' };
// Each theme's own colors, shown in the color pickers until someone picks their own.
export const THEME_COLORS = {
  requiem: { frame: '#8e111b', bg: '#110c0c', text: '#ece3da', accent: '#b3202b' },
  lilac: { frame: '#b8a2ff', bg: '#181425', text: '#f3effc', accent: '#b8a2ff' },
  mono: { frame: '#e9e9e6', bg: '#0c0c0c', text: '#f2f2ef', accent: '#f2f2ef' },
  vapor: { frame: '#b967ff', bg: '#1a1033', text: '#fdf3ff', accent: '#ff71ce' },
  toxic: { frame: '#39ff14', bg: '#090d09', text: '#e6ffe0', accent: '#39ff14' },
  gold: { frame: '#d4a72c', bg: '#0d0b07', text: '#f7eed6', accent: '#e0b84a' },
  ice: { frame: '#8fd3ff', bg: '#0b1626', text: '#eef8ff', accent: '#8fd3ff' },
};

// Portraits are either a Supabase Storage public URL or (demo mode only) a small data URL.
const PORTRAIT_URL = /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/portraits\/[\w\-/.]+$/;
const PORTRAIT_DATA = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const isColor = (v) => /^#[0-9a-f]{6}$/i.test(v || '');

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
    record: [],
    catchphrases: [],
    footer: ['', '', ''],
    theme: 'requiem',
    nameFont: 'theme',
    frame: 'theme',
    finish: 'none',
    colors: { frame: '', bg: '', text: '', accent: '' },
    portraitUrl: '',
  };
}

// Shortens text to at most n UTF-16 units without cutting a character in half. Fancy
// letters (𝕷𝖔𝖛𝖊) and emoji take two or more units; a half character makes the database
// reject the whole card ("Empty or invalid json").
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function clip(value, n) {
  const str = String(value ?? '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
  if (str.length <= n) return str;
  let out = '';
  const parts = segmenter ? Array.from(segmenter.segment(str), (x) => x.segment) : Array.from(str);
  for (const p of parts) {
    if (out.length + p.length > n) break;
    out += p;
  }
  return out;
}

// Keeps whatever shape arrives (from the database or a form) within sane limits.
export function cleanCard(c) {
  const s = (v, n) => clip(v, n);
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
    record: arr(c.record).slice(0, 6).map((r) => ({ label: s(r && r.label, 16), value: s(r && r.value, 32) })).filter((r) => r.label || r.value),
    catchphrases: arr(c.catchphrases).map((w) => s(w, 16)).filter(Boolean).slice(0, 6),
    footer: [0, 1, 2].map((i) => s(arr(c.footer)[i], 22)),
    theme: THEMES[c.theme] ? c.theme : 'requiem',
    nameFont: NAME_FONTS[c.nameFont] ? c.nameFont : 'theme',
    frame: FRAMES[c.frame] ? c.frame : 'theme',
    finish: FINISHES[c.finish] ? c.finish : 'none',
    // older cards kept a single `accent`; it now lives in colors.accent
    colors: Object.fromEntries(Object.keys(COLOR_KEYS).map((k) => {
      const v = (c.colors && c.colors[k]) || (k === 'accent' ? c.accent : '');
      return [k, isColor(v) ? v.toLowerCase() : ''];
    })),
    portraitUrl: typeof c.portraitUrl === 'string' && (PORTRAIT_URL.test(c.portraitUrl) || (PORTRAIT_DATA.test(c.portraitUrl) && c.portraitUrl.length < 400000)) ? c.portraitUrl : '',
  };
}

// Custom colors become CSS variables; the in-between shades are mixed from them.
function applyColors(card, colors) {
  const set = (k, v) => card.style.setProperty(k, v);
  if (colors.frame) set('--pc-frame', colors.frame);
  if (colors.bg) {
    set('--pc-card', colors.bg);
    set('--pc-card-2', 'color-mix(in srgb, ' + colors.bg + ' 88%, white)');
    set('--pc-portrait', 'color-mix(in srgb, ' + colors.bg + ' 80%, black)');
  }
  if (colors.text) {
    set('--pc-fg', colors.text);
    set('--pc-fg-2', 'color-mix(in srgb, ' + colors.text + ' 75%, var(--pc-card))');
    set('--pc-muted', 'color-mix(in srgb, ' + colors.text + ' 52%, var(--pc-card))');
  }
  if (colors.bg || colors.text) {
    set('--pc-line', 'color-mix(in srgb, var(--pc-card) 78%, var(--pc-fg))');
    set('--pc-pip-off', 'color-mix(in srgb, var(--pc-card) 86%, var(--pc-fg))');
  }
  if (colors.accent) {
    set('--pc-accent', colors.accent);
    set('--pc-accent-2', 'color-mix(in srgb, ' + colors.accent + ' 60%, white)');
    set('--pc-strong', 'color-mix(in srgb, ' + colors.accent + ' 78%, black)');
    set('--pc-glow', 'color-mix(in srgb, ' + colors.accent + ' 16%, transparent)');
    card.dataset.customAccent = '';
  }
}

// "Original 1/2", "Copy #3", and from version 2 on "v2 · Original 1/2".
export function editionLabel(item) {
  if (!item) return '';
  const ed = item.edition === 'original' ? 'Original ' + item.serial + '/2' : 'Copy #' + item.serial;
  return item.version > 1 ? 'v' + item.version + ' · ' + ed : ed;
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
  card.dataset.nameFont = c.nameFont;
  card.dataset.frame = c.frame;
  card.dataset.finish = c.finish;
  applyColors(card, c.colors);
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
  if (c.portraitUrl) {
    const img = document.createElement('img');
    img.className = 'pc-photo';
    img.src = c.portraitUrl;
    img.alt = '';
    // not lazy: lazy loading never fires inside the card's 3D flip layer
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    portrait.classList.add('has-photo');
    portrait.append(img);
  } else {
    ['c1', 'c2', 'c3'].forEach((k) => portrait.append(h('span', 'pc-cross ' + k, theme.mark)));
    if (c.emblem === 'moon') portrait.append(h('span', 'pc-moon'));
    else portrait.append(h('span', 'pc-emblem', c.emblem));
  }
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

  if (c.record.length) {
    const s = section('record');
    const grid = h('div', 'pc-record');
    c.record.forEach((r) => {
      const cell = h('div', 'pc-stat');
      cell.append(h('b', null, r.value), h('span', null, r.label));
      grid.append(cell);
    });
    s.append(grid);
    bb.append(s);
  }

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
