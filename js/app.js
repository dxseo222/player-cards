import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js?v10';
import { renderCard, blankCard, cleanCard, editionLabel, THEMES, NAME_FONTS, FRAMES, FINISHES, COLOR_KEYS, THEME_COLORS, nextTier, clip } from './card.js?v10';
import { parseExport, sources, computeStats, suggest } from './export.js?v10';
import { buildWorld, playerStats, badgesFor, leaderboards, BADGES } from './goals.js?v10';

const live = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const { api } = live ? await import('./api-supabase.js?v10') : await import('./api-local.js?v10');

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const state = { me: null, players: [], cardsById: new Map(), playersById: new Map(), versionsById: new Map() };

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
// The edition someone gets next from this card's current version.
const nextEdition = (card) => {
  const v = card.cur || {};
  const ed = v.original2_given ? 'Copy #' + ((v.copies_minted || 0) + 1) : 'Original 2/2';
  return card.current_version > 1 ? 'v' + card.current_version + ' ' + ed : ed;
};
// Items show the exact version they were minted from, not the card's latest look.
async function loadVersions(items) {
  const missing = [...new Set(items.map((i) => i.version_id).filter((id) => id && !state.versionsById.has(id)))];
  if (missing.length) (await api.versions(missing)).forEach((v) => state.versionsById.set(v.id, v));
  items.forEach((i) => { const v = state.versionsById.get(i.version_id); i.version = v ? v.version : 1; });
}
const itemData = (it) => (state.versionsById.get(it.version_id) || {}).data || (state.cardsById.get(it.card_id) || {}).data;
const itemLabel = (it) => cardName(it.card_id) + ' · ' + editionLabel(it);
const canSeeHidden = (card) => state.me && (state.me.is_admin || card.creator_id === state.me.id);
function hiddenPlaceholder() {
  return h('div', { class: 'hidden-card' }, h('b', {}, 'Hidden'), h('span', {}, 'A moderator hid this card.'));
}
// A card (or a hidden-card placeholder) for grids.
function cardThumb(card, data, item) {
  if (card && card.hidden && !canSeeHidden(card)) return hiddenPlaceholder();
  return renderCard(data, { item, size: 'thumb' });
}
// Links always name a version, so a shared v1 card keeps showing v1 after the creator moves on.
const shareHash = (cardId, version) => '#view-' + cardId + (version ? '-v' + version : '');

async function refreshPlayers() {
  state.players = await api.players();
  state.playersById = new Map(state.players.map((p) => [p.id, p]));
  state.cardsById = new Map(state.players.filter((p) => p.card).map((p) => [p.card.id, p.card]));
}

async function refreshBadge() { return checkTrades(); }

// ---------------------------------------------------------------- header

async function renderHeader() {
  const who = $('#who');
  who.replaceChildren();
  $('#tabs').hidden = !state.me;
  $('#adminTab').hidden = !(state.me && state.me.is_admin);
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
    aka: 'your old username', since: 'Mar 2022', msgCount: 100000, className: 'Nocturnal Bard', tags: ['Night owl', 'Server founder'],
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
        h('li', {}, 'Your first trade hands out Original 2/2. After that, numbered copies.'),
        h('li', {}, 'Change your card after trading it and you get a new version with its own originals.')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => attempt(() => api.signIn()) }, 'Sign in with Discord')),
    renderCard(sample)));
}

// ---------------------------------------------------------------- my card

let draft = null;
let parsedExport = null;
let excluded = new Set();
let lastStats = null;
let lastSuggest = null;
let quoteSeed = 1;

async function renderMyCard() {
  const mine = await api.myCard();
  draft = mine ? cleanCard(mine.data) : Object.assign(blankCard(state.me.username), { name: clip((state.me.username || 'player').toLowerCase(), 24) });

  // Once any edition of the current version has been traded, saving starts a new version.
  const traded = !!(mine && mine.cur && (mine.cur.original2_given || mine.cur.copies_minted > 0));
  const version = mine ? (traded ? mine.current_version + 1 : mine.current_version) : 1;

  const preview = h('div', { class: 'preview' });
  const paint = () => {
    const myItem = mine ? { edition: 'original', serial: 1, version } : null;
    preview.replaceChildren(renderCard(draft, { item: myItem }), h('div', { class: 'hint', text: 'Click the card to flip it' }),
      mine ? h('div', { class: 'row' },
        h('a', { class: 'btn', href: shareHash(mine.id, mine.current_version) }, 'Share or download'),
        mine.hidden ? h('span', { class: 'status declined', text: 'Hidden by a moderator' }) : null) : null);
  };
  let t;
  const repaint = () => { clearTimeout(t); t = setTimeout(paint, 60); };

  const form = h('div', { class: 'stack' });
  const rebuild = () => form.replaceChildren(exportPanel(rebuild, repaint), cardForm(repaint, rebuild), saveBar(mine, traded, version));
  rebuild();
  paint();

  const lead = !mine
    ? 'Fill it in from your Discord export, or by hand. Saving gives you Original 1/2.'
    : traded
      ? 'Version ' + mine.current_version + ' has been traded, so it’s frozen: everyone keeps the card they got. Saving changes starts Version ' + version + ', with its own Original 1/2 for you and Original 2/2 for your next trade.'
      : 'Version ' + mine.current_version + ' hasn’t been traded yet, so you can keep editing it. Once you trade it, it freezes and your next save starts a new version.';
  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {},
      h('h1', {}, mine ? 'Your card' : 'Make your card'),
      h('p', { class: 'lead' }, lead))),
    h('div', { class: 'builder' }, form, preview));
}

function saveBar(mine, traded, version) {
  const label = !mine ? 'Create card' : traded ? 'Save as Version ' + version : 'Save card';
  const done = !mine ? 'Card created. Original 1/2 is in your collection.'
    : traded ? 'Version ' + version + ' saved. Its Original 1/2 is in your collection.' : 'Card saved';
  return h('div', { class: 'row' },
    h('button', {
      class: 'btn primary', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await attempt(() => api.saveCard(cleanCard(draft)), done);
          await refreshPlayers();
          if (!mine || traded) renderMyCard();
        } finally { e.target.disabled = false; }
      },
    }, label),
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
      lastSuggest = null;
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
        lastSuggest = s;
        Object.assign(draft, {
          since: s.since, msgCount: s.msgCount, className: s.className, tags: s.tags, traits: s.traits,
          record: s.record, lore: s.lore,
          quote: s.quote || draft.quote, quoteSource: s.quote ? s.quoteSource : draft.quoteSource,
          emblem: s.emblem, portraitLabels: s.portraitLabels, weaknesses: s.weaknesses,
          catchphrases: s.catchphrases, footer: s.footer, abilities: s.abilities,
          theme: s.theme, colors: { ...draft.colors, accent: s.accent },
        });
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
        const r = h('input', { type: 'radio', name: 'quotePick', checked: q.text === draft.quote });
        r.addEventListener('change', () => { draft.quote = clip(q.text, 120); draft.quoteSource = q.date; rebuild(); repaint(); });
        box.append(h('label', {}, r, h('span', {}, h('span', { text: q.text }), h('span', { class: 'qdate', text: q.date }))));
      });
      return box;
    };
    panel.append(h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('h3', {}, 'Pick a quote'),
        h('button', { class: 'btn', type: 'button', onclick: () => { quoteSeed++; rebuild(); } }, 'Shuffle')),
      h('p', { class: 'muted small' }, 'Lines you actually sent, with the date you sent them. Only the one you pick goes on the card.'),
      pick()));
  }
  return panel;
}

function cardForm(repaint, rebuild) {
  const s = lastSuggest;
  const set = (fn) => (e) => { fn(e.target.value, e); repaint(); };
  const text = (label, value, fn, attrs = {}) => h('label', { class: 'f' }, label, h('input', { type: 'text', value: value || '', oninput: set(fn), ...attrs }));
  const area = (label, value, fn, attrs = {}) => h('label', { class: 'f' }, label, h('textarea', { oninput: set(fn), ...attrs }, value || ''));
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  // Dropdown suggestions from the export; the field still takes anything typed.
  const datalist = (id, options) => h('datalist', { id }, (options || []).map((o) => h('option', { value: o })));
  const from = s ? 'From your messages' : null;

  // Rarity is set by message count, so it's shown, not picked.
  const tier = draft.msgCount ? nextTier(draft.msgCount) : nextTier(0);
  const rarityNote = draft.msgCount
    ? draft.msgCount.toLocaleString('en-US') + ' messages' + (tier ? ' · ' + tier.name + ' at ' + tier.min.toLocaleString('en-US') : ' · top tier')
    : 'Fill from your Discord export to rank up';
  const rarityBox = h('div', { class: 'f' }, 'Rarity',
    h('div', { class: 'rarity-read' }, h('b', { text: cleanCard(draft).rarity }), h('span', { class: 'muted small', text: rarityNote })));

  // Tag chips: click to add or remove a suggested tag.
  const tagInput = h('input', { type: 'text', value: draft.tags.join(', '), oninput: set((v) => { draft.tags = list(v).slice(0, 4); }) });
  const tagChips = s ? h('div', { class: 'suggest' }, h('span', { class: 'muted small', text: from + ':' }),
    s.tagOptions.slice(0, 12).map((t) => h('button', {
      type: 'button', class: 'chip-btn' + (draft.tags.includes(t) ? ' on' : ''), onclick: () => {
        draft.tags = draft.tags.includes(t) ? draft.tags.filter((x) => x !== t) : [...draft.tags, t].slice(0, 4);
        rebuild(); repaint();
      },
    }, t))) : null;

  const identity = h('fieldset', {}, h('legend', {}, 'Identity'),
    h('div', { class: 'grid2' },
      text('Name on the card', draft.name, (v) => { draft.name = v; }, { maxlength: 24 }),
      text('Also known as', draft.aka, (v) => { draft.aka = v; }, { maxlength: 40 })),
    h('div', { class: 'grid2' },
      text('Since', draft.since, (v) => { draft.since = v; }, { maxlength: 24, placeholder: 'Mar 2022' }),
      rarityBox),
    h('div', { class: 'grid2' },
      text('Class', draft.className, (v) => { draft.className = v; }, { maxlength: 32, list: 'dlClass' }),
      h('label', { class: 'f' }, 'Tags (comma separated, up to 4)', tagInput)),
    tagChips,
    datalist('dlClass', s && s.classOptions));

  const emblemChips = s ? h('div', { class: 'suggest' }, h('span', { class: 'muted small', text: 'Your top emojis:' }),
    s.emblemOptions.map((e) => h('button', {
      type: 'button', class: 'chip-btn' + (draft.emblem === e ? ' on' : ''), onclick: () => { draft.emblem = e; rebuild(); repaint(); },
    }, e === 'moon' ? '🌕 moon' : e))) : null;

  const pick = (label, options, value, fn) => h('label', { class: 'f' }, label,
    h('select', { onchange: (e) => { fn(e.target.value); rebuild(); repaint(); } },
      Object.entries(options).map(([k, v]) => h('option', { value: k, selected: k === value }, typeof v === 'string' ? v : v.label))));

  // Colors: each picker starts on the theme's color; changing it makes it custom.
  const themeColors = THEME_COLORS[draft.theme] || THEME_COLORS.requiem;
  const colorRows = Object.entries(COLOR_KEYS).map(([k, label]) => {
    const custom = draft.colors[k];
    return h('div', { class: 'color-row' },
      h('label', { class: 'f' }, label + (custom ? '' : ' (theme)'),
        h('input', { type: 'color', value: custom || themeColors[k], oninput: (e) => { draft.colors[k] = e.target.value; repaint(); }, onchange: () => rebuild() })),
      custom ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => { draft.colors[k] = ''; rebuild(); repaint(); } }, 'Reset') : null);
  });

  const look = h('fieldset', {}, h('legend', {}, 'Look'),
    h('div', { class: 'grid2' },
      h('label', { class: 'f' }, 'Theme', h('select', { onchange: (e) => { draft.theme = e.target.value; rebuild(); repaint(); } },
        Object.entries(THEMES).map(([k, t]) => h('option', { value: k, selected: k === draft.theme }, t.label + (s && s.theme === k ? ' · matches your messages' : ''))))),
      pick('Name font', NAME_FONTS, draft.nameFont, (v) => { draft.nameFont = v; })),
    h('div', { class: 'grid2' },
      pick('Frame', FRAMES, draft.frame, (v) => { draft.frame = v; }),
      pick('Finish', FINISHES, draft.finish, (v) => { draft.finish = v; })),
    h('div', { class: 'colors' }, colorRows),
    s && s.accent ? h('p', { class: 'muted small', style: 'margin:0', text: 'The accent was suggested from the color you mention most.' }) : null);

  // Portrait: an uploaded picture wins over the emoji / moon.
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, id: 'portraitFile' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      toast('Uploading picture…');
      const blob = await shrinkImage(file);
      const old = draft.portraitUrl;
      draft.portraitUrl = await api.uploadPortrait(blob);
      if (old) api.removePortrait(old).catch(() => {});
      rebuild(); repaint();
      toast('Picture added. Save the card to keep it.');
    } catch (e) { toast(e.message || 'Upload failed', true); }
  });
  const portrait = h('fieldset', {}, h('legend', {}, 'Portrait'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, draft.portraitUrl ? 'Change picture' : 'Upload a picture'),
      draft.portraitUrl ? h('button', {
        class: 'btn ghost', type: 'button', onclick: () => {
          const old = draft.portraitUrl;
          draft.portraitUrl = '';
          api.removePortrait(old).catch(() => {});
          rebuild(); repaint();
        },
      }, 'Remove picture') : null,
      h('span', { class: 'muted small', text: 'PNG, JPG, WebP or GIF. Cropped to fit and shrunk before upload. Everyone signed in can see it.' })),
    fileInput,
    draft.portraitUrl ? null : text('Or an emoji (or "moon")', draft.emblem, (v) => { draft.emblem = v.trim() || 'moon'; }, { maxlength: 8 }),
    draft.portraitUrl ? null : emblemChips,
    h('div', { class: 'grid3' }, [0, 1, 2].map((i) =>
      text(['Label, top right', 'Label, bottom left', 'Label, bottom right'][i], draft.portraitLabels[i], (v) => { draft.portraitLabels[i] = v; }, { maxlength: 26, list: 'dlStats' }))),
    datalist('dlStats', s && s.statOptions),
    s ? h('p', { class: 'muted small', style: 'margin:0', text: 'Click a label or footer field to pick from your stats, or type your own.' }) : null);

  const traitNames = s ? s.traitOptions.map((t) => t.name) : [];
  const traits = h('fieldset', {}, h('legend', {}, 'Traits'),
    s ? h('p', { class: 'muted small', style: 'margin:0', text: 'Rated from your messages. Pick another trait name from the list to load its rating.' }) : null,
    draft.traits.map((t, i) => {
      const out = h('output', { text: t.value });
      const range = h('input', { type: 'range', min: 0, max: 10, value: t.value, 'aria-label': (t.name || 'Trait') + ' rating', oninput: set((v) => { draft.traits[i].value = +v; out.textContent = v; }) });
      const name = h('input', {
        type: 'text', value: t.name, maxlength: 12, list: 'dlTraits', 'aria-label': 'Trait ' + (i + 1) + ' name', oninput: set((v) => {
          draft.traits[i].name = v;
          const known = s && s.traitOptions.find((x) => x.name.toLowerCase() === v.trim().toLowerCase());
          if (known) { draft.traits[i].value = known.value; range.value = known.value; out.textContent = known.value; }
        }),
      });
      return h('div', { class: 'trait-row' }, name, range, out);
    }),
    datalist('dlTraits', traitNames));

  const words = h('fieldset', {}, h('legend', {}, 'Quote and catchphrases'),
    area('Quote', draft.quote, (v) => { draft.quote = v; }, { maxlength: 120, rows: 2 }),
    h('div', { class: 'grid2' },
      text('Quote date or source', draft.quoteSource, (v) => { draft.quoteSource = v; }, { maxlength: 40 }),
      text('Catchphrases (comma separated)', draft.catchphrases.join(', '), (v) => { draft.catchphrases = list(v).slice(0, 6); })));

  while (draft.abilities.length < 4) draft.abilities.push({ name: '', kind: '', desc: '' });
  const abilityOpts = s ? s.abilityOptions : [];
  const abilities = h('fieldset', {}, h('legend', {}, 'Abilities'),
    s ? h('p', { class: 'muted small', style: 'margin:0', text: 'Earned from your habits. Pick one from the list to fill it in, or write your own.' }) : null,
    draft.abilities.map((a, i) => {
      const kind = h('input', { type: 'text', value: a.kind, maxlength: 12, oninput: set((v) => { draft.abilities[i].kind = v; }) });
      const desc = h('input', { type: 'text', value: a.desc, maxlength: 140, oninput: set((v) => { draft.abilities[i].desc = v; }) });
      const name = h('input', {
        type: 'text', value: a.name, maxlength: 32, list: 'dlAbilities', oninput: set((v) => {
          draft.abilities[i].name = v;
          const known = abilityOpts.find((x) => x.name === v);
          if (known) { Object.assign(draft.abilities[i], known); kind.value = known.kind; desc.value = known.desc; }
        }),
      });
      return h('div', { class: 'ability-box' },
        h('div', { class: 'grid2' },
          h('label', { class: 'f' }, 'Ability ' + (i + 1), name),
          h('label', { class: 'f' }, 'Type (Passive, Active…)', kind)),
        h('label', { class: 'f' }, 'What it does', desc));
    }),
    datalist('dlAbilities', abilityOpts.map((x) => x.name)));

  while (draft.record.length < 6) draft.record.push({ label: '', value: '' });
  const record = h('fieldset', {}, h('legend', {}, 'Record (back of the card)'),
    s ? h('p', { class: 'muted small', style: 'margin:0', text: 'Your real numbers. Rename or swap any of them.' }) : null,
    h('div', { class: 'record-grid' }, draft.record.map((r, i) => h('div', { class: 'record-row' },
      h('input', { type: 'text', value: r.value, maxlength: 32, placeholder: 'Value', 'aria-label': 'Record ' + (i + 1) + ' value', list: 'dlStats', oninput: set((v) => { draft.record[i].value = v; }) }),
      h('input', { type: 'text', value: r.label, maxlength: 16, placeholder: 'Label', 'aria-label': 'Record ' + (i + 1) + ' label', oninput: set((v) => { draft.record[i].label = v; }) })))));

  while (draft.weaknesses.length < 3) draft.weaknesses.push('');
  const back = h('fieldset', {}, h('legend', {}, 'Weaknesses and lore'),
    draft.weaknesses.map((w, i) => text('Weakness ' + (i + 1), w, (v) => { draft.weaknesses[i] = v; }, { maxlength: 90, list: 'dlWeak' })),
    datalist('dlWeak', s && s.weaknessOptions),
    area('Lore', draft.lore, (v) => { draft.lore = v; }, { maxlength: 320, rows: 3 }),
    h('div', { class: 'grid3' }, [0, 1, 2].map((i) =>
      text('Footer ' + (i + 1), draft.footer[i], (v) => { draft.footer[i] = v; }, { maxlength: 22, list: 'dlStats' }))));

  return h('section', { class: 'panel stack' }, identity, look, portrait, traits, words, abilities, record, back);
}

// Crops a picture to the portrait's 4:3 shape and shrinks it to 720×540 before upload,
// so it stays small (usually under 100 KB). Animated GIFs become a still frame.
async function shrinkImage(file) {
  if (!/^image\//.test(file.type)) throw new Error('That file isn’t a picture');
  if (file.size > 15 * 1024 * 1024) throw new Error('That picture is over 15 MB');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Couldn’t open that picture'));
      i.src = url;
    });
    const W = 720, H = 540;
    const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const sw = W / scale, sh = H / scale;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, W, H);
    const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
    let blob = await toBlob('image/webp', 0.82);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.85);
    if (!blob) throw new Error('Couldn’t process that picture');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- collection

// Everything needed for badges, wishlists and the leaderboard, in one go.
async function loadWorld() {
  const [items, versions, wishlist] = await Promise.all([
    api.allItems(), api.allVersions(), api.wishlist().catch(() => []),
  ]);
  state.wishlist = wishlist;
  return buildWorld({
    players: state.players.map((p) => ({ id: p.id, username: p.username || 'Someone', card: p.card && { id: p.card.id, current_version: p.card.current_version, hidden: p.card.hidden } })),
    items, versions, wishlist,
  });
}
const worldPlayer = (world, id) => world.players.find((p) => p.id === id) || { id, username: state.me.username, card: null };

function badgeGrid(badges) {
  return h('div', { class: 'goals' }, badges.map((b) => h('div', { class: 'goal' + (b.earned ? ' earned' : ''), title: b.desc },
    h('span', { class: 'b-icon', text: b.icon }),
    h('div', { class: 'b-text' }, h('b', { text: b.name }), h('span', { text: b.desc })),
    b.earned ? h('span', { class: 'b-state', text: 'Earned' })
      : h('div', { class: 'b-progress' },
        h('div', { class: 'b-bar' }, h('i', { style: 'width:' + Math.round((b.have / b.goal) * 100) + '%' })),
        h('span', { text: b.label })))));
}

async function renderCollection() {
  await refreshPlayers();
  const items = await api.items(state.me.id);
  await loadVersions(items);
  const world = await loadWorld();
  const stats = playerStats(world, worldPlayer(world, state.me.id));
  const badges = badgesFor(stats);
  const earned = badges.filter((b) => b.earned).length;

  items.sort((a, b) => cardName(a.card_id).localeCompare(cardName(b.card_id)) || a.version - b.version
    || (a.edition === b.edition ? a.serial - b.serial : a.edition === 'original' ? -1 : 1));
  const grid = h('div', { class: 'cards' });
  for (const it of items) {
    const card = state.cardsById.get(it.card_id);
    if (!card) continue;
    grid.append(h('div', { class: 'slot' },
      cardThumb(card, itemData(it), it),
      h('div', { class: 'meta' }, h('b', { text: editionLabel(it) }), ' · made by ', playerName(card.creator_id),
        isLocked(it) ? h('div', { class: 'muted', text: 'Yours forever, can’t be traded' }) : null),
      h('a', { class: 'btn ghost small', href: shareHash(card.id, it.version) }, 'Share')));
  }

  const wishes = state.wishlist.filter((w) => w.user_id === state.me.id).map((w) => state.cardsById.get(w.card_id)).filter(Boolean);
  const wishGrid = h('div', { class: 'cards' }, wishes.map((card) => {
    const owner = state.playersById.get(card.creator_id);
    return h('div', { class: 'slot' },
      cardThumb(card, card.data),
      h('div', { class: 'meta' }, h('b', { text: playerName(card.creator_id) + '’s card' }),
        h('div', { class: 'muted', text: 'Next from them: ' + nextEdition(card) }),
        items.some((i) => i.card_id === card.id) ? h('div', { class: 'wish-tag', style: 'margin:0', text: '✓ You already have one' }) : null),
      h('div', { class: 'row', style: 'justify-content:center' },
        owner ? h('button', { class: 'btn', type: 'button', onclick: () => openTrade(owner) }, 'Propose a trade') : null,
        h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await attempt(() => api.setWish(card.id, false), 'Removed from your wishlist'); renderCollection(); } }, 'Remove')));
  }));

  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Collection'),
      h('p', { class: 'lead' }, items.length + (items.length === 1 ? ' card' : ' cards') + ' · ' + earned + ' of ' + badges.length + ' badges · collection score ' + stats.score.toLocaleString())),
      h('a', { class: 'btn', href: '#leaderboard' }, 'Leaderboard')),
    h('div', { class: 'stack', style: 'gap:34px' },
      h('section', { class: 'stack' }, h('h2', {}, 'Goals'), badgeGrid(badges)),
      h('section', { class: 'stack' }, h('h2', {}, 'Wishlist'),
        wishes.length ? wishGrid : h('p', { class: 'muted', text: 'Star cards on the Players page to keep track of the ones you want. Their owners can see who wants their card.' })),
      h('section', { class: 'stack' }, h('h2', {}, 'Your cards'),
        items.length ? grid : h('div', { class: 'empty' }, h('h3', {}, 'No cards yet'),
          h('p', {}, 'Make your card to get Original 1/2, then trade with players to collect theirs.'),
          h('a', { class: 'btn primary', href: '#card' }, 'Make your card')))));
}

// ---------------------------------------------------------------- leaderboard

async function renderLeaderboard() {
  await refreshPlayers();
  const lb = leaderboards(await loadWorld());
  const board = (title, note, rows, value) => h('section', { class: 'panel board' },
    h('h3', {}, title), h('p', { class: 'muted small', style: 'margin:4px 0 0', text: note }),
    rows.length ? h('ol', {}, rows.map((r, i) => h('li', { class: r.player && r.player.id === state.me.id ? 'me' : '' },
      h('span', { class: 'lb-rank', text: String(i + 1) }),
      h('span', { class: 'lb-who', text: r.player ? r.player.username : cardName(r.card.id) + ' (' + playerName(r.card.creator_id) + ')' }),
      h('span', { class: 'lb-val', text: value(r) }))))
      : h('p', { class: 'muted', text: 'Nobody yet. Start trading!' }));
  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Leaderboard'),
      h('p', { class: 'lead' }, 'Worked out live from everyone’s collections. Hidden cards don’t count.'))),
    h('div', { class: 'boards' },
      board('Best collection', 'Originals are worth 10, copies 2, times the card’s rarity (Rare ×1.5 up to Mythic ×4), plus 5 for each vintage card.', lb.score, (r) => r.value.toLocaleString() + ' pts'),
      board('Most cards collected', 'Cards from other players.', lb.cards, (r) => r.value + (r.value === 1 ? ' card' : ' cards')),
      board('Biggest set', 'Different players you hold a card from.', lb.set, (r) => r.value + (r.value === 1 ? ' player' : ' players')),
      board('Most badges', 'Out of ' + BADGES.length + '.', lb.badges, (r) => r.value + (r.value === 1 ? ' badge' : ' badges')),
      board('Most-traded cards', 'Editions handed out across all versions.', lb.traded, (r) => r.value + ' traded' + (r.wanted ? ' · ' + r.wanted + ' want it' : ''))));
}

// ---------------------------------------------------------------- players

async function renderPlayers() {
  await refreshPlayers();
  state.wishlist = await api.wishlist().catch(() => []);
  const grid = h('div', { class: 'cards' });
  const others = state.players.filter((p) => p.id !== state.me.id);
  for (const p of others) {
    const c = p.card;
    const v = (c && c.cur) || {};
    const out = (v.original2_given ? 1 : 0) + (v.copies_minted || 0);
    const hiddenFromMe = c && c.hidden && !canSeeHidden(c);
    grid.append(h('div', { class: 'slot' },
      c ? cardThumb(c, c.data) : h('div', { class: 'empty', style: 'width:100%' }, 'No card yet'),
      h('div', { class: 'meta' }, h('b', { text: p.username }),
        c && !hiddenFromMe ? h('div', { class: 'muted', text: (c.current_version > 1 ? 'Version ' + c.current_version + ' · ' : '')
          + (out ? out + ' traded out · next is ' + nextEdition(c) : 'Original 2/2 still available') }) : null,
        c && c.hidden && canSeeHidden(c) ? h('div', { class: 'muted', text: 'Hidden from other players' }) : null,
        c && wantCount(c.id) ? h('div', { class: 'muted', text: '♥ ' + wantCount(c.id) + (wantCount(c.id) === 1 ? ' player wants' : ' players want') + ' this' }) : null),
      h('div', { class: 'row', style: 'justify-content:center' },
        h('button', { class: 'btn', type: 'button', onclick: () => openTrade(p) }, 'Propose a trade'),
        c && !hiddenFromMe ? wishButton(c, renderPlayers) : null,
        c && !hiddenFromMe ? h('a', { class: 'btn ghost small', href: shareHash(c.id, c.current_version) }, 'View') : null,
        c && !hiddenFromMe ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => openReport(c, p.username) }, 'Report') : null)));
  }
  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Players'),
      h('p', { class: 'lead' }, live ? 'Everyone who has signed in. Invite friends by sending them this site’s link.' : 'Sample players for demo mode.'))),
    others.length ? grid : h('div', { class: 'empty' }, h('h3', {}, 'Nobody else is here yet'), h('p', {}, 'Send your friends the link so they can sign in and make cards.')));
}

const wantCount = (cardId) => state.wishlist.filter((w) => w.card_id === cardId).length;
const iWant = (cardId) => state.wishlist.some((w) => w.user_id === state.me.id && w.card_id === cardId);
function wishButton(card, after) {
  const on = iWant(card.id);
  return h('button', {
    class: 'btn ghost small wish' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false',
    title: on ? 'Remove from your wishlist' : 'Add to your wishlist', onclick: async () => {
      await attempt(() => api.setWish(card.id, !on), on ? 'Removed from your wishlist' : 'Added to your wishlist');
      after();
    },
  }, on ? '★ Wanted' : '☆ Want');
}

function openReport(card, owner) {
  const reason = h('input', { type: 'text', maxlength: 280, placeholder: 'What’s wrong with it? (optional)', 'aria-label': 'Reason' });
  const send = h('button', {
    class: 'btn primary', type: 'button', onclick: async () => {
      send.disabled = true;
      try { await attempt(() => api.report(card.id, reason.value.trim()), 'Reported. A moderator will take a look.'); closeModal(); } catch { send.disabled = false; }
    },
  }, 'Send report');
  openModal('Report ' + (owner || 'this') + '’s card', h('div', { class: 'stack' },
    h('p', { class: 'muted', style: 'margin:0', text: 'Only moderators see reports. Use this for pictures or text that shouldn’t be on the site.' }),
    reason, h('div', { class: 'row' }, send, h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'))));
}

// opts.counter: an incoming offer to answer; the window opens with it reversed so it can be changed.
async function openTrade(other, opts = {}) {
  await refreshPlayers();
  state.wishlist = await api.wishlist().catch(() => []);
  const mine = (await api.items(state.me.id)).filter((i) => !isLocked(i));
  const theirs = (await api.items(other.id)).filter((i) => !isLocked(i));
  await loadVersions([...mine, ...theirs]);
  const myCard = state.players.find((p) => p.id === state.me.id)?.card || null;
  const theirCard = state.players.find((p) => p.id === other.id)?.card || null;
  const t = opts.counter;
  const pick = t
    ? { offer: new Set(t.request_items.filter((id) => mine.some((i) => i.id === id))), request: new Set(t.offer_items.filter((id) => theirs.some((i) => i.id === id))), offerMint: !!t.request_mint, requestMint: !!t.offer_mint }
    : { offer: new Set(), request: new Set(), offerMint: false, requestMint: false };
  // wishlist hints: what they want from you, and what you want from them
  const theyWant = new Set(state.wishlist.filter((w) => w.user_id === other.id).map((w) => w.card_id));
  const youWant = new Set(state.wishlist.filter((w) => w.user_id === state.me.id).map((w) => w.card_id));
  const hint = (cardId, mineSide) => ((mineSide ? theyWant : youWant).has(cardId)
    ? h('span', { class: 'wish-tag', text: mineSide ? '♥ they want this' : '★ on your wishlist' }) : null);

  const side = (title, items, key, mintCard, mintKey, mintLabel) => {
    const box = h('div', { class: 'pick' });
    const mineSide = key === 'offer';
    if (mintCard && !mintCard.hidden) {
      const cb = h('input', { type: 'checkbox', checked: pick[mintKey] });
      cb.addEventListener('change', () => { pick[mintKey] = cb.checked; });
      box.append(h('label', { class: 'mint' }, cb, h('span', {}, mintLabel, ' ', h('span', { class: 'muted', text: '(' + nextEdition(mintCard) + ')' })), hint(mintCard.id, mineSide)));
    }
    items.forEach((it) => {
      const cb = h('input', { type: 'checkbox', checked: pick[key].has(it.id) });
      cb.addEventListener('change', () => { cb.checked ? pick[key].add(it.id) : pick[key].delete(it.id); });
      box.append(h('label', {}, cb, h('span', { text: itemLabel(it) }), hint(it.card_id, mineSide)));
    });
    if (!(mintCard && !mintCard.hidden) && !items.length) box.append(h('p', { class: 'muted small', text: 'Nothing to trade here yet.' }));
    return h('div', {}, h('h4', {}, title), box);
  };

  const msg = h('input', { type: 'text', maxlength: 280, placeholder: 'Add a message (optional)', 'aria-label': 'Message' });
  const send = h('button', {
    class: 'btn primary', type: 'button', onclick: async () => {
      send.disabled = true;
      const payload = {
        to: other.id, offerItems: [...pick.offer], offerMint: pick.offerMint,
        requestItems: [...pick.request], requestMint: pick.requestMint, message: msg.value.trim(),
      };
      try {
        if (t) await attempt(() => api.counter(t.id, payload), 'Counter-offer sent to ' + other.username);
        else await attempt(() => api.propose(payload), 'Offer sent to ' + other.username);
        closeModal();
        if (location.hash === '#trades') renderTrades();
      } catch { send.disabled = false; }
    },
  }, t ? 'Send counter-offer' : 'Send offer');

  openModal((t ? 'Counter-offer to ' : 'Trade with ') + other.username, h('div', { class: 'stack' },
    t ? h('p', { class: 'muted small', style: 'margin:0', text: 'This starts as their offer turned around. Change what you give or get, then send it. Their original offer closes as “countered”.' }) : null,
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
  const list = await api.itemsByIds(ids);
  await loadVersions(list);
  const items = new Map(list.map((i) => [i.id, i]));

  const chipsFor = (itemIds, mint, creatorId) => {
    const c = h('div', { class: 'chips' });
    if (mint) c.append(h('span', { class: 'chip orig', text: 'New edition of ' + playerName(creatorId) + '’s card' }));
    itemIds.forEach((id) => {
      const it = items.get(id);
      c.append(h('span', { class: 'chip' + (it && it.edition === 'original' ? ' orig' : ''), text: it ? itemLabel(it) : 'a card' }));
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
        h('button', { class: 'btn', type: 'button', onclick: () => openTrade(state.playersById.get(t.from_user) || { id: t.from_user, username: playerName(t.from_user) }, { counter: t }) }, 'Counter'),
        h('button', { class: 'btn', type: 'button', onclick: async () => { await attempt(() => api.respond(t.id, false), 'Declined'); renderTrades(); refreshBadge(); } }, 'Decline'));
    } else if (t.status === 'pending') {
      actions.append(h('button', { class: 'btn', type: 'button', onclick: async () => { await attempt(() => api.cancel(t.id), 'Offer cancelled'); renderTrades(); } }, 'Cancel offer'));
    }
    return h('div', { class: 'panel trade' },
      h('div', { class: 'row' },
        h('b', { text: t.counter_of
          ? (incoming ? playerName(other) + ' countered your offer' : 'You countered ' + playerName(other) + '’s offer')
          : (incoming ? playerName(other) + ' wants to trade' : 'You offered ' + playerName(other)) }),
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
      h('p', { class: 'lead' }, 'Offers people sent you, offers you sent, and what already happened. This page updates by itself.')),
      h('div', { class: 'row' }, notifyButton(), h('a', { class: 'btn primary', href: '#players' }, 'New trade'))),
    h('div', { class: 'stack', style: 'gap:34px' },
      section('Waiting on you', incoming, 'No offers waiting on you.'),
      section('Waiting on them', outgoing, 'You have no open offers.'),
      section('History', past, 'No finished trades yet.')));
}

// ---------------------------------------------------------------- notifications

// Browser notifications are optional; the badge and toasts work without them.
function notifyButton() {
  if (!('Notification' in window)) return null;
  if (Notification.permission === 'granted') return h('span', { class: 'muted small', text: 'Notifications on' });
  if (Notification.permission === 'denied') return h('span', { class: 'muted small', text: 'Notifications blocked in your browser settings' });
  return h('button', {
    class: 'btn', type: 'button', onclick: async () => {
      const r = await Notification.requestPermission();
      toast(r === 'granted' ? 'You’ll get a notification when a trade comes in.' : 'Notifications stay off.');
      if (location.hash === '#trades') renderTrades();
    },
  }, 'Turn on notifications');
}
function notify(text) {
  toast(text);
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Player Cards', { body: text, tag: 'player-cards' });
  } catch { /* some browsers only allow notifications from a service worker */ }
}

// Compares trades with what was seen last time and announces anything new.
// Runs on live database events, every 45s while the tab is open, and when you come back to it.
const seen = { ready: false, incoming: new Set(), outgoing: new Map() };
async function checkTrades() {
  if (!state.me) return;
  const trades = await api.trades();
  const pendingIn = trades.filter((t) => t.status === 'pending' && t.to_user === state.me.id);
  const mineOut = trades.filter((t) => t.from_user === state.me.id);
  if (seen.ready) {
    const fresh = pendingIn.filter((t) => !seen.incoming.has(t.id));
    if (fresh.length) await refreshPlayers();
    fresh.forEach((t) => notify(playerName(t.from_user) + (t.counter_of ? ' countered your offer' : ' sent you a trade offer')));
    mineOut.forEach((t) => {
      const before = seen.outgoing.get(t.id);
      if (before === 'pending' && !['pending', 'cancelled', 'countered'].includes(t.status)) {
        notify(playerName(t.to_user) + (t.status === 'accepted' ? ' accepted your trade' : t.status === 'declined' ? ' declined your trade' : '’s trade couldn’t go through'));
      }
    });
    const changed = fresh.length || mineOut.some((t) => seen.outgoing.get(t.id) !== t.status);
    if (changed && ['#trades', '#collection'].includes(location.hash)) route();
  }
  seen.incoming = new Set(pendingIn.map((t) => t.id));
  seen.outgoing = new Map(mineOut.map((t) => [t.id, t.status]));
  seen.ready = true;
  const b = $('#tradeBadge');
  b.hidden = pendingIn.length === 0;
  b.textContent = pendingIn.length;
}
let pollTimer = null;
function startTradeWatch() {
  seen.ready = false;
  checkTrades().catch(() => {});
  if (api.onTrades) api.onTrades(() => checkTrades().catch(() => {}));
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) checkTrades().catch(() => {}); }, 45000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkTrades().catch(() => {}); });

// ---------------------------------------------------------------- shared card page

function parseViewHash() {
  const m = /^#view-([0-9a-f-]{36})(?:-v(\d+))?$/i.exec(location.hash);
  return m ? { cardId: m[1], version: m[2] ? +m[2] : null } : null;
}

async function renderView({ cardId, version }) {
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.remove('active'));
  const found = await api.publicCard(cardId, version);
  if (!found || (found.card.hidden && !canSeeHidden(found.card))) {
    view.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Card not found'),
      h('p', {}, 'It may have been hidden, or the link is wrong.'),
      h('a', { class: 'btn primary', href: '#card' }, state.me ? 'Back to my card' : 'Make your own card')));
    return;
  }
  const { card, version: v } = found;
  const data = cleanCard(v.data);
  const link = location.origin + location.pathname + shareHash(card.id, v.version);
  const linkBox = h('input', { type: 'text', value: link, readonly: true, 'aria-label': 'Card link', onclick: (e) => e.target.select() });
  const owner = state.me && state.playersById.get(card.creator_id);

  const actions = h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: (e) => downloadPng(data, v.version, e.target) }, 'Download PNG'),
      h('button', {
        class: 'btn', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { linkBox.select(); toast('Press Ctrl+C to copy the link'); }
        },
      }, 'Copy link')),
    linkBox,
    h('p', { class: 'muted small', style: 'margin:0', text: 'Anyone with the link can see this card, even without signing in.' }),
    state.me && owner && card.creator_id !== state.me.id ? h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => openTrade(owner) }, 'Propose a trade'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => openReport(card, owner.username) }, 'Report')) : null,
    !state.me && live ? h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => attempt(() => api.signIn()) }, 'Make your own card'),
      h('span', { class: 'muted small', text: 'Sign in with Discord, turn your messages into a card, trade with friends.' })) : null);

  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {},
      h('h1', { text: data.name + (v.version > 1 ? ' · v' + v.version : '') }),
      h('p', { class: 'lead', text: data.className ? data.rarity + ' ' + data.className : data.rarity }))),
    h('div', { class: 'share' }, renderCard(data, { item: { edition: 'original', serial: 1, version: v.version } }), actions));
}

// Draws both sides of the card side by side into a PNG.
async function downloadPng(data, version, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Making image…';
  const stage = h('div', { class: 'png-stage' });
  try {
    const { toPng } = await import('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm');
    stage.append(renderCard(data, { flippable: false, item: null }));
    stage.firstChild.classList.add('pc-export');
    document.body.append(stage);
    await document.fonts.ready;
    const imgs = [...stage.querySelectorAll('img')];
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    const url = await toPng(stage.firstChild, { pixelRatio: 2, backgroundColor: '#0b090a', cacheBust: true });
    const a = h('a', { href: url, download: (data.name || 'card').replace(/[^\w-]+/g, '_') + (version > 1 ? '-v' + version : '') + '.png' });
    document.body.append(a);
    a.click();
    a.remove();
    toast('Image downloaded');
  } catch (e) {
    toast('Couldn’t make the image: ' + (e.message || e), true);
  } finally {
    stage.remove();
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------------------------------------------------------------- moderation

async function renderAdmin() {
  if (!state.me.is_admin) { location.hash = '#card'; return; }
  await refreshPlayers();
  const reports = await api.reports();
  const open = reports.filter((r) => r.status === 'open');

  const controls = (card) => h('div', { class: 'row', style: 'justify-content:center' },
    h('button', {
      class: 'btn small', type: 'button', onclick: async () => {
        await attempt(() => api.adminSetHidden(card.id, !card.hidden), card.hidden ? 'Card is visible again' : 'Card hidden');
        renderAdmin();
      },
    }, card.hidden ? 'Unhide' : 'Hide card'),
    cleanCard(card.data).portraitUrl ? h('button', {
      class: 'btn small', type: 'button', onclick: async () => {
        if (!window.confirm('Remove this card’s picture from every version? This deletes the files and can’t be undone.')) return;
        await attempt(() => api.adminRemovePortrait(card), 'Picture removed');
        renderAdmin();
      },
    }, 'Remove picture') : null);

  const reportEl = (r) => {
    const card = state.cardsById.get(r.card_id);
    return h('div', { class: 'slot' },
      card ? renderCard(card.data, { size: 'thumb' }) : h('div', { class: 'empty' }, 'Card deleted'),
      h('div', { class: 'meta' }, h('b', { text: card ? playerName(card.creator_id) + '’s card' : 'Deleted card' }),
        h('div', { class: 'muted', text: 'Reported by ' + playerName(r.reporter) + ' · ' + new Date(r.created_at).toLocaleDateString() }),
        r.reason ? h('div', { text: '“' + r.reason + '”' }) : null,
        card && card.hidden ? h('div', { class: 'muted', text: 'Hidden' }) : null),
      card ? controls(card) : null,
      h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { await attempt(() => api.adminResolve(r.id), 'Report closed'); renderAdmin(); } }, 'Close report'));
  };

  const cards = state.players.filter((p) => p.card);
  view.replaceChildren(
    h('div', { class: 'head-row' }, h('div', {}, h('h1', {}, 'Moderation'),
      h('p', { class: 'lead' }, 'Hidden cards disappear for everyone except their creator and moderators, and can’t be traded. Removing a picture deletes it from every version.'))),
    h('div', { class: 'stack', style: 'gap:34px' },
      h('section', { class: 'stack' }, h('h2', {}, 'Open reports'),
        open.length ? h('div', { class: 'cards' }, open.map(reportEl)) : h('p', { class: 'muted', text: 'No open reports.' })),
      h('section', { class: 'stack' }, h('h2', {}, 'All cards'),
        h('div', { class: 'cards' }, cards.map((p) => h('div', { class: 'slot' },
          renderCard(p.card.data, { size: 'thumb' }),
          h('div', { class: 'meta' }, h('b', { text: p.username }), p.card.hidden ? h('div', { class: 'muted', text: 'Hidden' }) : null),
          controls(p.card)))))));
}

// ---------------------------------------------------------------- routing

const routes = { card: renderMyCard, collection: renderCollection, players: renderPlayers, trades: renderTrades, leaderboard: renderLeaderboard, admin: renderAdmin };

async function route() {
  const shared = parseViewHash();
  if (!state.me && !shared) { renderSignIn(); return; }
  const tab = (location.hash || '#card').slice(1);
  const fn = shared ? () => renderView(shared) : routes[tab] || renderMyCard;
  if (!shared) document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (routes[tab] ? tab : 'card')));
  view.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  try { await fn(); } catch (e) { view.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Something went wrong'), h('p', { text: e.message || String(e) }))); }
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
  if (state.me) startTradeWatch();
  route();
}

api.onChange(async () => {
  state.me = await api.me();
  parsedExport = null; lastStats = null; lastSuggest = null; excluded = new Set();
  state.versionsById = new Map();
  if (state.me) { await refreshPlayers(); startTradeWatch(); }
  await renderHeader();
  route();
});
window.addEventListener('hashchange', route);
boot();
