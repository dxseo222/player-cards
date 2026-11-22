// Reads a Discord data package's Messages folder entirely in the browser and turns it
// into stats + card suggestions. Nothing here touches the network.
//
// `entries` is a list of { path, file } where `path` is the file's path inside the
// chosen folder (e.g. "Messages/c123/messages.json") and `file.text()` returns its text.

const SLANG = [
  'idk', 'fr', 'icl', 'ngl', 'rn', 'tbh', 'lmao', 'lmfao', 'lol', 'bro', 'bruh', 'tho', 'nah',
  'bet', 'lowk', 'lowkey', 'deadass', 'ong', 'smh', 'wtf', 'omg', 'ion', 'tryna', 'prolly',
  'imma', 'alr', 'smth', 'ik', 'yk', 'istg', 'fs', 'frfr', 'ts', 'pls', 'ty', 'gng', 'twin',
  'slay', 'periodt', 'xd', 'uwu', 'pog', 'gg', 'wsg', 'hbu', 'wyd', 'ight', 'aight', 'sheesh',
];
const PHRASES = ['type shi', 'on god', 'no cap', 'its giving', 'it\'s giving', 'say less', 'real shi'];

const RX = {
  emoji: /\p{Extended_Pictographic}/gu,
  custom: /<a?:(\w+):\d+>/g,
  heart: /\b(love|ily|ilysm|luv)\b|<3|❤|🫶|💕|💖|🥰/i,
  hustle: /\b(work|working|grind|studio|release|drop|dropping|finish|finished|project|deadline|shift|practice|session)\b/i,
  tech: /\b(code|coding|python|javascript|js|lua|bot|server|pc|gpu|cpu|ram|script|api|bug|debug|command|install)\b/i,
  loyal: /\b(gang|my (ppl|people|guys|boys|girls)|got (you|u)|i gotchu|ride or die|squad|proud of (you|u)|here for (you|u))\b/i,
  music: /\b(song|songs|music|beat|beats|album|ep|verse|hook|mix|mixing|master|producer|prod|soundcloud|spotify|lyrics|track|vocals)\b/i,
  game: /\b(game|games|gaming|play|playing|match|ranked|level|lvl|raid|boss|quest|minecraft|valorant|fortnite|roblox|steam)\b/i,
  art: /\b(draw|drawing|art|sketch|paint|painting|commission|animation|design|edit|editing)\b/i,
  code: /\b(code|coding|python|javascript|bot|script|api|deploy|github|bug|function)\b/i,
  quote: /^(i|im|i'm|i’m|my)\s+(not|just|really|always|never|love|hate|make|feel|wanna|want|need|think|wish|be|was|grew|use|fav|favorite)\b/i,
};

function toDate(ts) {
  // Discord exports use "YYYY-MM-DD HH:MM:SS" in UTC (newer ones use ISO with offset).
  if (!ts) return null;
  const s = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function dayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export async function parseExport(entries, onProgress = () => {}) {
  const byDir = new Map();
  let indexFile = null;
  for (const e of entries) {
    const parts = e.path.replace(/\\/g, '/').split('/');
    const name = parts[parts.length - 1].toLowerCase();
    if (name === 'index.json' && parts.length <= 3) { indexFile = e; continue; }
    if (name !== 'messages.json' && name !== 'channel.json') continue;
    const dir = parts.slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, {});
    byDir.get(dir)[name] = e;
  }

  let index = {};
  if (indexFile) { try { index = JSON.parse(await indexFile.file.text()); } catch { index = {}; } }

  const channels = [];
  const dirs = [...byDir.values()].filter((d) => d['messages.json']);
  if (!dirs.length) throw new Error('No messages found. Pick the "Messages" folder from your Discord data package (it holds one folder per channel, each with messages.json).');

  let done = 0;
  for (const d of dirs) {
    let ch = {};
    if (d['channel.json']) { try { ch = JSON.parse(await d['channel.json'].file.text()); } catch { ch = {}; } }
    let msgs = [];
    try { msgs = JSON.parse(await d['messages.json'].file.text()); } catch { msgs = []; }
    const id = String(ch.id ?? '');
    const label = index[id] || '';
    const type = ch.type || 'UNKNOWN';
    const isDM = type === 'DM' || type === 1;
    const isGroup = type === 'GROUP_DM' || type === 3;
    const guild = (ch.guild && ch.guild.name) || (!isDM && !isGroup && label.includes(', ') ? label.split(', ').slice(1).join(', ') : '');
    const name = ch.name || (label.includes(', ') ? label.split(', ')[0] : label) || (isDM ? 'Direct message' : 'Unknown channel');
    channels.push({
      id: id || String(channels.length),
      kind: isDM ? 'dm' : isGroup ? 'group' : 'server',
      guild: guild || (isDM ? 'Direct messages' : isGroup ? 'Group chats' : 'Unknown server'),
      name,
      messages: msgs.map((m) => ({ ts: m.Timestamp ?? m.timestamp, text: m.Contents ?? m.contents ?? '', att: !!(m.Attachments ?? m.attachments) })),
    });
    done++;
    if (done % 50 === 0) { onProgress(done / dirs.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  onProgress(1);
  return { channels };
}

// Groups channels for the exclude list: [{ guild, kind, count, channels: [{id, name, count}] }]
export function sources(parsed) {
  const map = new Map();
  for (const c of parsed.channels) {
    const key = c.kind + '|' + c.guild;
    if (!map.has(key)) map.set(key, { guild: c.guild, kind: c.kind, count: 0, channels: [] });
    const g = map.get(key);
    g.count += c.messages.length;
    g.channels.push({ id: c.id, name: c.name, count: c.messages.length });
  }
  const list = [...map.values()];
  list.forEach((g) => g.channels.sort((a, b) => b.count - a.count));
  return list.sort((a, b) => b.count - a.count);
}

export function computeStats(parsed, excluded = new Set()) {
  const chans = parsed.channels.filter((c) => !excluded.has(c.id));
  const all = [];
  for (const c of chans) for (const m of c.messages) {
    const d = toDate(m.ts);
    if (d) all.push({ d, text: m.text || '', ch: c.id, guild: c.kind === 'server' ? c.guild : null });
  }
  if (!all.length) return null;
  all.sort((a, b) => a.d - b.d);

  const total = all.length;
  const first = all[0].d, last = all[all.length - 1].d;
  const days = new Set(all.map((m) => dayKey(m.d)));
  const spanDays = Math.round((new Date(dayKey(last)) - new Date(dayKey(first))) / 864e5) + 1;

  // longest daily streak
  const sortedDays = [...days].sort();
  let best = 1, cur = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    const gap = Math.round((new Date(sortedDays[i]) - new Date(sortedDays[i - 1])) / 864e5);
    cur = gap === 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
  }

  const hours = new Array(24).fill(0);
  all.forEach((m) => hours[m.d.getHours()]++);
  const night = all.filter((m) => { const h = m.d.getHours(); return h >= 18 || h < 2; }).length / total;
  const peakHour = hours.indexOf(Math.max(...hours));
  const lateNight = (hours[0] + hours[1] + hours[2] + hours[3] + hours[4]) / total;

  // rapid-fire: next message in the same channel within 60s
  const lastByCh = new Map();
  let burst = 0;
  for (const m of all) {
    const p = lastByCh.get(m.ch);
    if (p && m.d - p <= 60000) burst++;
    lastByCh.set(m.ch, m.d);
  }

  const texts = all.map((m) => m.text).filter(Boolean);
  const letters = texts.filter((t) => /[a-z]/i.test(t));
  const lower = letters.filter((t) => t === t.toLowerCase()).length / Math.max(1, letters.length);
  const periods = texts.filter((t) => /\.\s*$/.test(t) && !/\.\.\s*$/.test(t)).length / Math.max(1, texts.length);
  const lens = texts.map((t) => t.length).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;

  const emoji = new Map(), custom = new Map(), words = new Map();
  const counts = { heart: 0, hustle: 0, tech: 0, loyal: 0, music: 0, game: 0, art: 0, code: 0, caps: 0, bang: 0, emojiMsgs: 0 };
  for (const t of texts) {
    let hadEmoji = false;
    for (const e of t.match(RX.emoji) || []) { emoji.set(e, (emoji.get(e) || 0) + 1); hadEmoji = true; }
    for (const m of t.matchAll(RX.custom)) { const k = ':' + m[1] + ':'; custom.set(k, (custom.get(k) || 0) + 1); hadEmoji = true; }
    if (hadEmoji) counts.emojiMsgs++;
    const low = t.toLowerCase();
    for (const w of low.match(/[a-z']+/g) || []) words.set(w, (words.get(w) || 0) + 1);
    for (const p of PHRASES) if (low.includes(p)) words.set(p, (words.get(p) || 0) + 1);
    for (const k of ['heart', 'hustle', 'tech', 'loyal', 'music', 'game', 'art', 'code']) if (RX[k].test(t)) counts[k]++;
    if (t.length > 3 && t === t.toUpperCase() && /[A-Z]{3}/.test(t)) counts.caps++;
    if (/!!|\?\?|(\w)\1{3,}/.test(t)) counts.bang++;
  }
  const topEmoji = [...emoji.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topCustom = [...custom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const slang = [...SLANG, ...PHRASES].map((w) => [w, words.get(w) || 0]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);

  const servers = new Map();
  all.forEach((m) => { if (m.guild) servers.set(m.guild, (servers.get(m.guild) || 0) + 1); });

  // quote candidates: short first-person lines without mentions or links
  const quotes = texts.filter((t) => t.length >= 28 && t.length <= 110 && RX.quote.test(t)
    && !/<@|<#|https?:|@everyone|\d{4,}/.test(t) && !/\n/.test(t));

  const per = (n) => n / Math.max(1, texts.length);
  return {
    total, first, last, spanDays, daysActive: days.size, streak: best,
    perDay: total / spanDays, hours, night, lateNight, peakHour,
    burst: burst / total, lower, periods, median,
    topEmoji, topCustom, slang, quotes,
    servers: [...servers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    rates: {
      heart: per(counts.heart), hustle: per(counts.hustle), tech: per(counts.tech), loyal: per(counts.loyal),
      music: per(counts.music), game: per(counts.game), art: per(counts.art), code: per(counts.code),
      chaos: per(counts.emojiMsgs + counts.caps * 2 + counts.bang),
    },
  };
}

const clamp = (v) => Math.max(1, Math.min(10, Math.round(v)));
const scale = (x, lo, hi) => clamp(1 + 9 * (x - lo) / (hi - lo));
const fmt = (n) => n.toLocaleString('en-US');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CLASSES = {
  music: { main: 'Bard · Producer', ability: { name: 'Feelings → Song', kind: 'Passive', desc: 'Whatever happened last night is a track by morning.' } },
  code: { main: 'Artificer · Dev', ability: { name: 'Ship It', kind: 'Active', desc: 'Writes the bot, fixes the bug, pushes at 3am.' } },
  game: { main: 'Grinder · Gamer', ability: { name: 'One More Match', kind: 'Passive', desc: 'Says it is the last game. It is never the last game.' } },
  art: { main: 'Artist · Visionary', ability: { name: 'Sketch Mode', kind: 'Active', desc: 'Turns any idea into a drawing, cover or edit.' } },
};

// Turns stats into suggested card fields. Everything is editable afterwards.
export function suggest(stats, quoteSeed = 0) {
  const r = stats.rates;
  const kinds = ['music', 'code', 'game', 'art'].map((k) => [k, r[k] / ({ music: 0.035, code: 0.012, game: 0.04, art: 0.012 })[k]]);
  kinds.sort((a, b) => b[1] - a[1]);
  const cls = CLASSES[kinds[0][0]];

  const tags = [];
  if (stats.night > 0.4) tags.push('Night owl');
  if (stats.perDay > 80) tags.push('Certified yapper'); else if (stats.perDay < 5) tags.push('Lurker');
  if (stats.burst > 0.5) tags.push('Rapid-fire');
  if (stats.lower > 0.8) tags.push('lowercase only');
  if (kinds[1][1] > 0.8) tags.push(CLASSES[kinds[1][0]].main.split(' · ')[1]);

  const sig = stats.topEmoji[0];
  const traits = [
    { name: 'Loyalty', value: scale(r.loyal, 0.0005, 0.0035) },
    { name: 'Heart', value: scale(r.heart, 0.001, 0.01) },
    { name: 'Hustle', value: scale(r.hustle, 0.002, 0.016) },
    { name: 'Chaos', value: scale(r.chaos, 0.03, 0.2) },
    { name: 'Tech', value: scale(r.tech, 0.002, 0.015) },
    { name: 'Patience', value: scale(1 - stats.burst, 0.2, 0.9) },
  ];

  const pickQuotes = shuffle(stats.quotes, quoteSeed).slice(0, 6);
  const since = MONTHS[stats.first.getMonth()] + ' ' + stats.first.getFullYear();
  const yrs = "'" + String(stats.first.getFullYear()).slice(2) + "–'" + String(stats.last.getFullYear()).slice(2);

  const weaknesses = [];
  if (stats.periods < 0.02) weaknesses.push('Periods. Used in ' + (stats.periods * 100).toFixed(1) + '% of messages.');
  if (stats.lateNight > 0.12) weaknesses.push('Sleep schedule. ' + Math.round(stats.lateNight * 100) + '% of messages sent after midnight.');
  if (stats.burst > 0.5) weaknesses.push('Sends 5 messages instead of 1.');

  return {
    since,
    className: cls.main,
    tags: tags.slice(0, 4),
    traits,
    quoteCandidates: pickQuotes,
    quote: pickQuotes[0] || '',
    quoteSource: stats.last.getFullYear() + '',
    emblem: sig ? sig[0] : '🌕',
    portraitLabels: [
      'online at ' + hourLabel(stats.peakHour),
      sig ? sig[0] + ' ×' + fmt(sig[1]) : '',
      fmt(stats.streak) + '-day streak',
    ],
    abilities: [cls.ability],
    weaknesses: weaknesses.slice(0, 3),
    catchphrases: stats.slang.slice(0, 5).map((x) => x[0]).concat(stats.topCustom.slice(0, 1).map((x) => x[0])),
    footer: [
      fmt(stats.total) + ' msgs',
      (stats.daysActive / stats.spanDays * 100).toFixed(1) + '% days online',
      yrs,
    ],
  };
}

export function hourLabel(h) {
  const ampm = h < 12 ? 'am' : 'pm';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ampm;
}

function shuffle(arr, seed) {
  const a = arr.slice();
  let s = (seed * 9301 + 49297) % 233280 || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
