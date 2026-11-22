// Reads a Discord data package's Messages folder entirely in the browser and turns it
// into stats + card suggestions. Nothing here touches the network.
//
// `entries` is a list of { path, file } where `path` is the file's path inside the
// chosen folder (e.g. "Messages/c123/messages.json") and `file.text()` returns its text.

import { rarityFor } from './card.js?v5';

const SLANG = [
  'idk', 'fr', 'icl', 'ngl', 'rn', 'tbh', 'lmao', 'lmfao', 'lol', 'bro', 'bruh', 'tho', 'nah',
  'bet', 'lowk', 'lowkey', 'deadass', 'ong', 'smh', 'wtf', 'omg', 'ion', 'tryna', 'prolly',
  'imma', 'alr', 'smth', 'ik', 'yk', 'istg', 'fs', 'frfr', 'ts', 'pls', 'ty', 'gng', 'twin',
  'slay', 'periodt', 'xd', 'uwu', 'pog', 'gg', 'wsg', 'hbu', 'wyd', 'ight', 'aight', 'sheesh',
];
const PHRASES = ['type shi', 'on god', 'no cap', 'its giving', 'it\'s giving', 'say less', 'real shi'];

// Each pattern is tested once per message; rates are "share of messages that match".
const PATTERNS = {
  // personality
  heart: /\b(love (you|u|ya)|ily|ilysm|luv (you|u)|miss (you|u)|proud of (you|u))\b|<3|❤|🫶|💕|💖|🥰|🥹/i,
  loyal: /\b(gang|my (ppl|people|guys|boys|girls|brother|bro)|got (you|u)|i gotchu|ride or die|squad|i'?m here for (you|u)|always here)\b/i,
  hustle: /\b(work|working|grind|grinding|studio|release|drop|dropping|finish|finished|project|deadline|shift|practice|session|progress)\b/i,
  laugh: /\b(lmao|lmfao|lol|haha+|hehe+|dead|crying)\b|😭|💀|😂|🤣/i,
  hype: /🔥|💯|‼️|\b(let'?s go+|lets go+|goated|hard af|so hard|w+)\b|!!/i,
  drama: /\b(wtf|omg|bro what|why would|hell nah|nahh+|crazy|insane|unhinged)\b|\?\?|😳|🙄/i,
  flirt: /😏|🥵|😩|😋|\b(babe|baby|shawty|bae|cutie|pause|kiss|kisses|daddy|mommy)\b/i,
  help: /\b(you('| )?ll be (ok|okay|fine)|it'?s (ok|okay)|you got this|i understand|that makes sense|have you tried|try (this|doing))\b/i,
  question: /\?\s*$|^(what|why|how|who|where|when|which|wdym|wym|do (you|u)|did (you|u)|are (you|u)|r u|is (it|this|that)|can (you|u|i)|should i|wanna|anyone)\b/i,
  // interests
  music: /\b(song|songs|music|beat|beats|album|ep|verse|hook|mix|mixing|master|producer|prod|soundcloud|spotify|lyrics|track|vocals|bpm)\b/i,
  code: /\b(code|coding|python|javascript|js|lua|bot|script|api|deploy|github|bug|function|error|compile)\b/i,
  tech: /\b(pc|gpu|cpu|ram|ssd|monitor|install|driver|windows|bios|wifi|router|keyboard|mouse)\b/i,
  game: /\b(game|games|gaming|match|ranked|lvl|raid|boss|quest|minecraft|valorant|fortnite|roblox|steam|warframe|elden|xbox|ps5|controller)\b/i,
  art: /\b(draw|drawing|art|sketch|paint|painting|commission|animation|design|edit|editing|cover art|photoshop)\b/i,
  anime: /\b(anime|manga|episode|waifu|husbando|season \d|crunchyroll|manhwa|op|jjk|aot)\b/i,
  sports: /\b(nba|nfl|soccer|football|basketball|baseball|hockey|ufc|league|playoffs|goal|dunk)\b/i,
  gym: /\b(gym|workout|lift|lifting|gains|protein|bench|squat|cardio|reps)\b/i,
  food: /\b(eat|eating|food|hungry|starving|pizza|cook|cooking|dinner|lunch|breakfast|snack)\b/i,
  school: /\b(school|class|homework|hw|exam|test|teacher|college|uni|assignment|study|studying)\b/i,
  // looks
  goth: /\b(dead|hell|blood|goth|demon|devil|grave|coffin|cursed|vamp|requiem|reaper)\b|✞|♱|🥀|💀|🖤|⛧|🦇/i,
  cute: /\b(cute|uwu|owo|kawaii|bestie|bunny|kitty|soft|baby)\b|:3|🥺|✨|💕|🌸|🎀|🐰/i,
};
const BASE = { // rough "typical" rates, used to judge what stands out for a person
  music: 0.012, code: 0.006, tech: 0.004, game: 0.02, art: 0.006, anime: 0.004,
  sports: 0.004, gym: 0.002, food: 0.008, school: 0.008,
};
const COLORS = {
  red: '#b3202b', crimson: '#a3141f', pink: '#e06a9a', purple: '#9b6bff', violet: '#8a5cf6', lilac: '#b8a2ff',
  blue: '#3b82f6', teal: '#22b8a5', green: '#3fae6a', yellow: '#e8b923', gold: '#d4a017', orange: '#ff8a3d',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x) => Math.round(x * 100) + '%';
export const fmtDate = (d) => MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();

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
    if (d) all.push({ d, text: m.text || '', ch: c.id, kind: c.kind, guild: c.kind === 'server' ? c.guild : null });
  }
  if (!all.length) return null;
  all.sort((a, b) => a.d - b.d);

  const total = all.length;
  const first = all[0].d, last = all[all.length - 1].d;
  const days = new Set(all.map((m) => dayKey(m.d)));
  const spanDays = Math.round((new Date(dayKey(last)) - new Date(dayKey(first))) / 864e5) + 1;

  const sortedDays = [...days].sort();
  let best = 1, cur = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    const gap = Math.round((new Date(sortedDays[i]) - new Date(sortedDays[i - 1])) / 864e5);
    cur = gap === 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
  }

  const hours = new Array(24).fill(0);
  let weekend = 0;
  const months = new Map();
  for (const m of all) {
    hours[m.d.getHours()]++;
    const wd = m.d.getDay();
    if (wd === 0 || wd === 6) weekend++;
    const mk = m.d.getFullYear() * 12 + m.d.getMonth();
    months.set(mk, (months.get(mk) || 0) + 1);
  }
  const share = (from, to) => { let s = 0; for (let h = from; h !== to; h = (h + 1) % 24) s += hours[h]; return s / total; };
  const night = share(18, 2), lateNight = share(0, 5), morning = share(5, 11);
  const peakHour = hours.indexOf(Math.max(...hours));
  const [peakMonthKey, peakMonthCount] = [...months.entries()].sort((a, b) => b[1] - a[1])[0];
  const peakMonth = MONTHS[peakMonthKey % 12] + ' ' + Math.floor(peakMonthKey / 12);

  const lastByCh = new Map();
  let burst = 0;
  for (const m of all) {
    const p = lastByCh.get(m.ch);
    if (p && m.d - p <= 60000) burst++;
    lastByCh.set(m.ch, m.d);
  }

  const withText = all.filter((m) => m.text);
  const texts = withText.map((m) => m.text);
  const letters = texts.filter((t) => /[a-z]/i.test(t));
  const lower = letters.filter((t) => t === t.toLowerCase()).length / Math.max(1, letters.length);
  const caps = letters.filter((t) => t.length > 3 && t === t.toUpperCase() && /[A-Z]{3}/.test(t)).length / Math.max(1, letters.length);
  const periods = texts.filter((t) => /\.\s*$/.test(t) && !/\.\.\s*$/.test(t)).length / Math.max(1, texts.length);
  const lens = texts.map((t) => t.length).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const longShare = texts.filter((t) => t.length >= 120).length / Math.max(1, texts.length);

  const emoji = new Map(), custom = new Map(), words = new Map(), colors = new Map(), linkHosts = new Map();
  const hits = Object.fromEntries(Object.keys(PATTERNS).map((k) => [k, 0]));
  let emojiMsgs = 0, links = 0, gifs = 0, dmMsgs = 0, groupMsgs = 0;
  const vocab = new Set();
  let vocabWords = 0;
  for (const m of withText) {
    const t = m.text;
    if (m.kind === 'dm') dmMsgs++; else if (m.kind === 'group') groupMsgs++;
    let hadEmoji = false;
    for (const e of t.match(/\p{Extended_Pictographic}/gu) || []) { emoji.set(e, (emoji.get(e) || 0) + 1); hadEmoji = true; }
    for (const c of t.matchAll(/<a?:(\w+):\d+>/g)) { const k = ':' + c[1] + ':'; custom.set(k, (custom.get(k) || 0) + 1); hadEmoji = true; }
    if (hadEmoji) emojiMsgs++;
    for (const u of t.matchAll(/https?:\/\/(?:www\.)?([^/\s]+)/g)) {
      links++;
      const host = u[1].toLowerCase();
      if (/tenor|giphy|klipy/.test(host)) { gifs++; continue; }
      if (/discord(app)?\.(com|net|gg)$/.test(host)) continue;
      linkHosts.set(host, (linkHosts.get(host) || 0) + 1);
    }
    const low = t.toLowerCase();
    const ws = low.replace(/https?:\S+|<[^>]+>/g, ' ').match(/[a-z']+/g) || [];
    for (const w of ws) {
      words.set(w, (words.get(w) || 0) + 1);
      if (COLORS[w]) colors.set(w, (colors.get(w) || 0) + 1);
      if (vocabWords < 60000) { vocab.add(w); vocabWords++; }
    }
    for (const p of PHRASES) if (low.includes(p)) words.set(p, (words.get(p) || 0) + 1);
    for (const k in PATTERNS) if (PATTERNS[k].test(t)) hits[k]++;
  }
  const n = Math.max(1, texts.length);
  const rates = Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v / n]));
  rates.emoji = emojiMsgs / n;
  rates.links = (links - gifs) / n;
  rates.gifs = gifs / n;
  rates.caps = caps;

  const topEmoji = [...emoji.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topCustom = [...custom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const slang = [...SLANG, ...PHRASES].map((w) => [w, words.get(w) || 0]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);

  const servers = new Map();
  all.forEach((m) => { if (m.guild) servers.set(m.guild, (servers.get(m.guild) || 0) + 1); });

  // quote candidates: short first-person lines without mentions or links, with their date
  const quoteRx = /^(i|im|i'm|i’m|my)\s+(not|just|really|always|never|love|hate|make|feel|wanna|want|need|think|wish|be|was|grew|use|fav|favorite)\b/i;
  const quotes = withText.filter((m) => m.text.length >= 28 && m.text.length <= 110 && quoteRx.test(m.text)
    && !/<@|<#|https?:|@everyone|\d{4,}|\n/.test(m.text)).map((m) => ({ text: m.text, date: m.d }));

  return {
    total, first, last, spanDays, daysActive: days.size, streak: best,
    perDay: total / spanDays, hours, night, lateNight, morning, weekend: weekend / total, peakHour,
    peakMonth, peakMonthCount,
    burst: burst / total, lower, periods, median, longShare,
    dmShare: dmMsgs / n, groupShare: groupMsgs / n,
    vocabRatio: vocab.size / Math.max(1, vocabWords),
    topEmoji, topCustom, slang, quotes, rates,
    colors: [...colors.entries()].sort((a, b) => b[1] - a[1]),
    linkHosts: [...linkHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    servers: [...servers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

// ---------------------------------------------------------------- suggestions

const clamp = (v) => Math.max(1, Math.min(10, Math.round(v)));
const scale = (x, lo, hi) => clamp(1 + 9 * (x - lo) / (hi - lo));

// Interest → class role, matching ability, and a tag.
const ROLES = {
  music: { role: 'Bard', tag: 'Music head', ability: { name: 'Feelings → Song', kind: 'Passive', desc: 'Whatever happened last night is a track by morning.' } },
  code: { role: 'Artificer', tag: 'Coder', ability: { name: 'Ship It', kind: 'Active', desc: 'Writes the bot, fixes the bug, pushes at 3am.' } },
  tech: { role: 'Tinkerer', tag: 'PC medic', ability: { name: 'PC Medic', kind: 'Support', desc: 'Diagnoses your RAM, finds your missing GPU.' } },
  game: { role: 'Grinder', tag: 'Gamer', ability: { name: 'One More Match', kind: 'Passive', desc: 'Says it’s the last game. It is never the last game.' } },
  art: { role: 'Artist', tag: 'Artist', ability: { name: 'Sketch Mode', kind: 'Active', desc: 'Turns any idea into a drawing, cover or edit.' } },
  anime: { role: 'Weeb Scholar', tag: 'Anime watcher', ability: { name: 'Episode Recap', kind: 'Passive', desc: 'Can explain the whole plot. Will, unprompted.' } },
  sports: { role: 'Sports Oracle', tag: 'Sports fan', ability: { name: 'Hot Take', kind: 'Active', desc: 'Calls the game before it starts. Sometimes right.' } },
  gym: { role: 'Gym Warrior', tag: 'Gym rat', ability: { name: 'PR Day', kind: 'Passive', desc: 'Every conversation leads back to the gym.' } },
  food: { role: 'Foodie', tag: 'Always hungry', ability: { name: 'Snack Break', kind: 'Passive', desc: 'Hunger level reported in real time.' } },
  school: { role: 'Scholar', tag: 'Student', ability: { name: 'All-Nighter', kind: 'Active', desc: 'Starts the assignment the night it’s due. Finishes it.' } },
};

// Personality traits: how each is scored from the messages, and the class prefix it gives.
const TRAITS = [
  { name: 'Loyalty', prefix: 'Loyal', score: (s) => scale(s.rates.loyal, 0.0005, 0.0035) },
  { name: 'Heart', prefix: 'Lovestruck', score: (s) => scale(s.rates.heart, 0.001, 0.006) },
  { name: 'Hustle', prefix: 'Relentless', score: (s) => scale(s.rates.hustle, 0.002, 0.016) },
  { name: 'Humor', prefix: 'Comedic', score: (s) => scale(s.rates.laugh, 0.02, 0.15) },
  { name: 'Chaos', prefix: 'Chaotic', score: (s) => scale(s.rates.emoji + s.rates.caps * 2 + s.rates.drama, 0.04, 0.22) },
  { name: 'Hype', prefix: 'Hyped', score: (s) => scale(s.rates.hype, 0.005, 0.04) },
  { name: 'Drama', prefix: 'Dramatic', score: (s) => scale(s.rates.drama, 0.005, 0.035) },
  { name: 'Rizz', prefix: 'Smooth', score: (s) => scale(s.rates.flirt, 0.002, 0.02) },
  { name: 'Wisdom', prefix: 'Wise', score: (s) => scale(s.rates.help + s.longShare, 0.005, 0.06) },
  { name: 'Curiosity', prefix: 'Curious', score: (s) => scale(s.rates.question, 0.03, 0.12) },
  { name: 'Night owl', prefix: 'Nocturnal', score: (s) => scale(s.lateNight, 0.04, 0.22) },
  { name: 'Grind', prefix: 'Unstoppable', score: (s) => scale(s.daysActive / s.spanDays, 0.3, 1) },
  { name: 'Speed', prefix: 'Rapid', score: (s) => scale(s.burst, 0.15, 0.6) },
  { name: 'Patience', prefix: 'Patient', score: (s) => scale(1 - s.burst, 0.35, 0.85) },
  { name: 'Tech', prefix: 'Techy', score: (s) => scale(s.rates.code + s.rates.tech, 0.003, 0.02) },
];

export function hourLabel(h) {
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + (h < 12 ? 'am' : 'pm');
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

// Turns stats into suggested card fields plus lists of alternatives. Everything is editable.
export function suggest(stats, quoteSeed = 0) {
  const s = stats;
  const sig = s.topEmoji[0];
  const top = s.servers[0] && [s.servers[0][0].replace(/\s*\(.*?\)\s*/g, ' ').trim() || s.servers[0][0], s.servers[0][1]];

  // interests, strongest first relative to a typical rate
  const interests = Object.keys(ROLES).map((k) => [k, s.rates[k] / BASE[k]]).sort((a, b) => b[1] - a[1]);
  const mainInterest = interests[0][0];

  // traits: score them all, keep the 5 highest plus the single lowest (every card gets a weak spot)
  const scored = TRAITS.map((t) => ({ name: t.name, prefix: t.prefix, value: t.score(s) }));
  const byValue = scored.slice().sort((a, b) => b.value - a.value);
  const keep = byValue.slice(0, 5);
  const low = byValue.filter((t) => !keep.includes(t) && !(t.name === 'Patience' && keep.some((k) => k.name === 'Speed')) && !(t.name === 'Speed' && keep.some((k) => k.name === 'Patience'))).pop();
  const traits = [...keep, low].filter(Boolean).map(({ name, value }) => ({ name, value }));
  const className = byValue[0].prefix + ' ' + ROLES[mainInterest].role;

  // tags: every detector that fires, ranked by how strongly
  const tagPool = [
    [s.lateNight > 0.12, s.lateNight / 0.12, 'Night owl'],
    [s.morning > 0.3, s.morning / 0.3, 'Early bird'],
    [s.perDay > 80, s.perDay / 80, 'Certified yapper'],
    [s.perDay < 5, 5 / Math.max(1, s.perDay), 'Lurker'],
    [s.burst > 0.5, s.burst / 0.5, 'Rapid-fire'],
    [s.lower > 0.75, s.lower / 0.75, 'lowercase only'],
    [s.rates.caps > 0.04, s.rates.caps / 0.04, 'CAPS LOCK'],
    [s.rates.emoji > 0.12, s.rates.emoji / 0.12, 'Emoji fiend'],
    [s.rates.gifs > 0.01, s.rates.gifs / 0.01, 'GIF sniper'],
    [s.rates.links > 0.03, s.rates.links / 0.03, 'Link dealer'],
    [s.rates.heart > 0.006, s.rates.heart / 0.006, 'Hopeless romantic'],
    [s.rates.laugh > 0.1, s.rates.laugh / 0.1, 'Always laughing'],
    [s.rates.flirt > 0.012, s.rates.flirt / 0.012, 'Flirt'],
    [s.dmShare > 0.4, s.dmShare / 0.4, 'DM dweller'],
    [s.groupShare > 0.25, s.groupShare / 0.25, 'Group chat menace'],
    [s.weekend > 0.36, s.weekend / 0.36, 'Weekend warrior'],
    [s.median > 45, s.median / 45, 'Essay writer'],
    [s.median < 14, 14 / Math.max(1, s.median), 'One-word replies'],
    [s.daysActive / s.spanDays > 0.9, (s.daysActive / s.spanDays) / 0.9, 'Never offline'],
    [s.first.getFullYear() <= 2018, 2, 'OG since ' + s.first.getFullYear()],
    ...interests.slice(1, 3).filter(([, r]) => r > 1.2).map(([k, r]) => [true, r / 2, ROLES[k].tag]),
  ];
  const tagOptions = tagPool.filter((t) => t[0]).sort((a, b) => b[1] - a[1]).map((t) => t[2]);

  // abilities: the main interest's, then ones earned by standout habits
  const abilityPool = [
    ROLES[mainInterest].ability,
    s.lateNight > 0.12 && { name: 'Night Shift', kind: 'Passive', desc: 'Strongest after midnight. ' + pct(s.lateNight) + ' of messages sent between 12am and 5am.' },
    s.burst > 0.5 && { name: 'Rapid-Fire', kind: 'Active', desc: 'Sends five messages before you finish reading the first.' },
    sig && sig[1] > 500 && { name: sig[0] + ' Barrage', kind: 'Active', desc: 'Used ' + fmt(sig[1]) + ' times and counting.' },
    s.streak >= 100 && { name: 'Iron Streak', kind: 'Passive', desc: 'Showed up ' + fmt(s.streak) + ' days in a row.' },
    s.rates.heart > 0.006 && { name: 'Comfort Zone', kind: 'Support', desc: 'Says the soft stuff out loud. Friends heal nearby.' },
    s.rates.gifs > 0.01 && { name: 'GIF Sniper', kind: 'Active', desc: 'Has the perfect reaction GIF loaded at all times.' },
    s.rates.links > 0.03 && { name: 'Link Dealer', kind: 'Support', desc: 'Drops links nonstop' + (s.linkHosts[0] ? ', mostly ' + s.linkHosts[0][0].split('.').slice(-2, -1)[0] : '') + '.' },
    s.rates.help > 0.004 && { name: 'Talk It Out', kind: 'Support', desc: 'Gives real advice when it counts.' },
    top && { name: 'Home Turf', kind: 'Passive', desc: 'Stronger in ' + top[0] + ' (' + fmt(top[1]) + ' messages there).' },
  ].filter(Boolean);
  const abilities = abilityPool.slice(0, 3);

  const weakPool = [
    s.periods < 0.02 && 'Periods. Used in ' + (s.periods * 100).toFixed(1) + '% of messages.',
    s.lateNight > 0.12 && 'Sleep schedule. ' + pct(s.lateNight) + ' of messages sent after midnight.',
    s.burst > 0.5 && 'Sends 5 messages instead of 1.',
    low && low.name + '. Rated ' + low.value + '/10.',
    s.rates.caps > 0.04 && 'Indoor voice. ' + pct(s.rates.caps) + ' of messages in caps.',
    s.median < 14 && 'Replies in 3 words or fewer.',
    s.perDay < 5 && 'Leaves people on read.',
  ].filter(Boolean);

  // look: theme from the vibe of the messages, accent from the color they talk about most
  const goth = s.rates.goth, cute = s.rates.cute;
  const theme = goth > cute * 1.2 && goth > 0.01 ? 'requiem' : cute > goth * 1.2 && cute > 0.01 ? 'lilac' : 'mono';
  const color = s.colors.find(([w]) => COLORS[w]);
  const accent = color && color[1] >= 20 ? COLORS[color[0]] : '';

  const statOptions = [
    'online at ' + hourLabel(s.peakHour),
    sig ? sig[0] + ' ×' + fmt(sig[1]) : null,
    fmt(s.streak) + '-day streak',
    fmt(s.total) + ' msgs',
    (s.daysActive / s.spanDays * 100).toFixed(1) + '% days online',
    "'" + String(s.first.getFullYear()).slice(2) + "–'" + String(s.last.getFullYear()).slice(2),
    'peak: ' + s.peakMonth,
    top ? 'home: ' + top[0] : null,
    pct(s.lateNight) + ' after midnight',
    pct(s.burst) + ' rapid-fire',
    pct(s.lower) + ' lowercase',
    'median ' + s.median + ' chars',
    s.topCustom[0] ? s.topCustom[0][0] + ' ×' + fmt(s.topCustom[0][1]) : null,
    s.slang[0] ? '"' + s.slang[0][0] + '" ×' + fmt(s.slang[0][1]) : null,
  ].filter(Boolean).map((x) => x.slice(0, 26));

  const quoteCandidates = shuffle(s.quotes, quoteSeed).slice(0, 6).map((q) => ({ text: q.text, date: fmtDate(q.date) }));

  // back of the card: a record like a real trading card, and lore written from the history
  const since = MONTHS[s.first.getMonth()] + ' ' + s.first.getFullYear();
  const record = [
    { label: 'Messages', value: fmt(s.total) },
    { label: 'Days online', value: fmt(s.daysActive) },
    { label: 'Best streak', value: fmt(s.streak) + ' days' },
    { label: 'Peak month', value: s.peakMonth },
    { label: 'Most active', value: hourLabel(s.peakHour) },
    top ? { label: 'Home server', value: top[0] } : { label: 'Per day', value: fmt(s.perDay) + ' msgs' },
  ];
  const loreParts = [
    'On Discord since ' + since + '.',
    'Peaked in ' + s.peakMonth + ' with ' + fmt(s.peakMonthCount) + ' messages in one month.',
    top ? 'Calls ' + top[0] + ' home.' : null,
    s.lateNight > 0.12 ? 'Comes alive after midnight.' : s.morning > 0.3 ? 'Up before everyone else.' : null,
    s.streak >= 100 ? 'Once went ' + fmt(s.streak) + ' days without missing one.' : null,
    'Known for ' + ROLES[mainInterest].tag.toLowerCase() + ' energy.',
  ].filter(Boolean);
  let lore = '';
  for (const p of loreParts) if ((lore + ' ' + p).trim().length <= 320) lore = (lore + ' ' + p).trim();

  return {
    since,
    record,
    lore,
    msgCount: s.total,
    rarity: rarityFor(s.total),
    className,
    classOptions: [...new Set([className, ...byValue.slice(1, 4).map((t) => t.prefix + ' ' + ROLES[mainInterest].role),
      ...interests.slice(1, 3).map(([k]) => byValue[0].prefix + ' ' + ROLES[k].role)])],
    tags: tagOptions.slice(0, 4),
    tagOptions,
    traits,
    traitOptions: byValue.map(({ name, value }) => ({ name, value })),
    quoteCandidates,
    quote: quoteCandidates[0] ? quoteCandidates[0].text : '',
    quoteSource: quoteCandidates[0] ? quoteCandidates[0].date : '',
    emblem: sig ? sig[0] : 'moon',
    emblemOptions: ['moon', ...s.topEmoji.slice(0, 7).map((e) => e[0])],
    portraitLabels: [statOptions[0], statOptions[1] || '', statOptions[2]],
    footer: [statOptions[3], statOptions[4], statOptions[5]],
    statOptions,
    abilities,
    abilityOptions: abilityPool,
    weaknesses: weakPool.slice(0, 3),
    weaknessOptions: weakPool,
    catchphrases: s.slang.slice(0, 5).map((x) => x[0]).concat(s.topCustom.slice(0, 1).map((x) => x[0])),
    theme,
    accent,
  };
}
