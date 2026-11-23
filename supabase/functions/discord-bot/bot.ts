// @ts-nocheck
// Player Cards Discord bot: everything that doesn't talk to the network itself, so the tests
// (tests/bot.test.js) can run it with fake Discord and database calls.
//
// Commands:  /help
//            /card [player]   /collection [player]   right-click a user → Apps → Player Card
//            /trade @player   /trades   (trading lives in trades.ts)
//            /feed here   /feed off   (Manage Server only: where new cards and trades are posted)

export const SITE = 'https://dxseo222.github.io/player-cards/';

// Bump this whenever COMMANDS changes; the next feed run re-registers them with Discord.
export const COMMANDS_VERSION = 3;

const PLAYER_OPTION = { type: 6, name: 'player', description: 'Whose (leave empty for yours)', required: false };
const GUILD_ONLY = { contexts: [0], integration_types: [0] };
export const COMMANDS = [
  { name: 'help', type: 1, description: 'How Player Cards works, and what to do next', ...GUILD_ONLY },
  { name: 'card', type: 1, description: 'Show a Player Card', options: [PLAYER_OPTION], ...GUILD_ONLY },
  { name: 'collection', type: 1, description: 'Show the Player Cards someone has collected', options: [PLAYER_OPTION], ...GUILD_ONLY },
  { name: 'Player Card', type: 2, ...GUILD_ONLY },
  {
    name: 'trade', type: 1, description: 'Offer someone a trade',
    options: [{ type: 6, name: 'player', description: 'Who to trade with', required: true }], ...GUILD_ONLY,
  },
  { name: 'trades', type: 1, description: 'Your trade offers that are still waiting for an answer', ...GUILD_ONLY },
  {
    name: 'feed', type: 1, description: 'Post new Player Cards and finished trades in a channel',
    default_member_permissions: '32', // Manage Server
    options: [
      { type: 1, name: 'here', description: 'Post new cards and finished trades in this channel' },
      { type: 1, name: 'off', description: 'Stop posting in this server' },
    ],
    ...GUILD_ONLY,
  },
];

// ---------------------------------------------------------------- text helpers

// Must match RARITY_TIERS in js/card.js (a test checks).
const TIERS = [['Mythic', 150000], ['Legendary', 75000], ['Epic', 25000], ['Rare', 5000], ['Common', 0]];
export const rarityFor = (count) => TIERS.find(([, min]) => (Number(count) || 0) >= min)[0];
export const RARITY_COLORS = { Common: 0x8b807b, Rare: 0x3d86de, Epic: 0x9b6bff, Legendary: 0xf0b52a, Mythic: 0xff4fd8 };
export const TRADE_COLOR = 0xf2c94c;

// Shortens to at most n UTF-16 units without cutting an emoji or fancy letter in half.
export function cut(value, n) {
  const s = String(value ?? '');
  if (s.length <= n) return s;
  let out = '';
  for (const ch of s) {
    if (out.length + ch.length > n - 1) break;
    out += ch;
  }
  return out + '…';
}

// Player-written text is shown as plain text, never as Discord formatting or links.
export const esc = (s) => String(s ?? '').replace(/[\\*_~`|>[\]()<#@:-]/g, '\\$&');
export const text = (s, n) => esc(cut(String(s ?? '').replace(/\s+/g, ' ').trim(), n));

export const shareUrl = (cardId, version) => SITE + '#view-' + cardId + (version ? '-v' + version : '');

export function editionLabel(item) {
  const ed = item.edition === 'original' ? 'Original ' + item.serial + '/2' : 'Copy #' + item.serial;
  return item.version > 1 ? 'v' + item.version + ' · ' + ed : ed;
}

const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/\S+$/.test(u) && u.length < 1000 ? u : undefined);
const num = (n) => Math.max(0, Math.round(Number(n) || 0)).toLocaleString('en-US');
const plural = (n, one, many) => num(n) + ' ' + (Number(n) === 1 ? one : many);
// Coloured squares read clearly in Discord's font (▰ and ▱ look almost the same).
export const bar = (v) => {
  const n = Math.max(0, Math.min(10, Math.round(Number(v) || 0)));
  return '🟥'.repeat(n) + '⬛'.repeat(10 - n);
};
const rarityLine = (d) => {
  const rarity = rarityFor(d && d.msgCount);
  return d && d.className ? rarity + ' · ' + text(d.className, 40) : rarity;
};
export const linkButton = (label, url) => ({ type: 1, components: [{ type: 2, style: 5, label, url }] });

// ---------------------------------------------------------------- getting started

// What to tell someone who isn't set up yet, with a button straight to the right page.
export const notSignedIn = () => ({
  content: 'You’re not on Player Cards yet. Open the site, sign in with Discord and make your card. It takes a couple of minutes, and you can fill it in from your Discord data.',
  components: [linkButton('Make your card', SITE + '#card')],
});
export const noCardYet = () => ({
  content: 'You haven’t made your card yet. Make it on the site, then it can be shown, collected and traded.',
  components: [linkButton('Make your card', SITE + '#card')],
});
export const otherNotSignedIn = (name) => ({
  content: '**' + text(name, 60) + '** isn’t on Player Cards yet. Send them the site so they can make a card: ' + SITE,
});

const STEP = ['1. Open the site and sign in with Discord.', '2. Make your card. You can fill it in from your Discord data export.', '3. Collect your friends’ cards by trading, here or on the site.'];

// p: bot_player for the person asking (null if they've never signed in).
export function helpMessage(p) {
  let status;
  if (!p) status = '**Where you are:** not signed in yet. Start with step 1.';
  else if (!p.card) status = '**Where you are:** signed in, no card yet. Step 2 is next.';
  else if (p.card.hidden) status = '**Where you are:** your card is hidden by a moderator.';
  else {
    status = '**Where you are:** your card **' + text((p.card.data && p.card.data.name) || 'player', 40) + '** is ready. You hold '
      + plural(p.held, 'card', 'cards') + (p.collected ? ' from ' + plural(p.collected, 'other player', 'other players') : '') + '.'
      + (p.collected ? '' : ' Try `/trade` with a friend.');
  }
  return {
    embeds: [{
      title: 'Player Cards',
      color: RARITY_COLORS.Mythic,
      description: 'Make a trading card from your Discord messages, then collect and trade your friends’ cards.\n\n' + status,
      fields: [
        { name: 'Getting started', value: STEP.join('\n') },
        { name: 'Cards', value: '`/card [player]` shows a card (yours if you leave it empty)\nRight-click someone → **Apps → Player Card** does the same\n`/collection [player]` shows the cards someone has collected' },
        { name: 'Trading', value: '`/trade @player` picks what you give and what you want, then sends the offer\n`/trades` shows your offers waiting for an answer\nThey get a ping with a button only they can open, to accept, decline or counter.' },
        { name: 'How cards work', value: 'Every card has two originals. **Original 1/2** always stays with its maker. The maker’s first trade hands out **Original 2/2**, then numbered copies. Rarity comes from how many messages you’ve sent.' },
        { name: 'For server admins', value: '`/feed here` posts new cards and finished trades in a channel. `/feed off` stops it.' },
      ],
      footer: { text: 'Only you can see this.' },
    }],
    components: [linkButton(p && p.card ? 'Open Player Cards' : 'Make your card', SITE + (p && p.card ? '' : '#card'))],
  };
}

// ---------------------------------------------------------------- /card and /collection

export function cardMessage(p, self = false) {
  const name = text(p.player.username, 60);
  if (!p.card && self) return noCardYet();
  if (!p.card) return { content: '**' + name + '** signed in but hasn’t made a card yet.' };
  if (p.card.hidden || !p.card.data) return { content: '**' + name + '**’s card is hidden by a moderator.' };
  const d = p.card.data;
  const rarity = rarityFor(d.msgCount);
  const url = shareUrl(p.card.id, p.card.version);
  const author = { name: cut(p.player.username, 80), icon_url: httpsUrl(p.player.avatar_url) };
  const counts = 'Traded out ' + plural(p.card.traded_out, 'time', 'times') + ' · owned by ' + plural(p.card.owners, 'other player', 'other players')
    + ' · ' + plural(p.held, 'card', 'cards') + ' collected';

  // The picture of the card, drawn by the site, when there is one: it says everything the text would.
  if (httpsUrl(p.card.image_url)) {
    return {
      embeds: [{
        author,
        title: cut(String(d.name || '').trim() || 'player', 100),
        url,
        color: RARITY_COLORS[rarity],
        description: rarityLine(d) + ' · ' + num(d.msgCount) + ' messages' + (p.card.version > 1 ? ' · version ' + p.card.version : ''),
        image: { url: p.card.image_url },
        footer: { text: counts },
      }],
      components: [linkButton('Open card', url)],
    };
  }

  const lines = [];
  if (d.aka) lines.push('*' + text(d.aka, 80) + '*');
  if (d.quote) lines.push('> “' + text(d.quote, 200) + '”' + (d.quoteSource ? ' — ' + text(d.quoteSource, 60) : ''));
  if (d.lore) lines.push(text(d.lore, 400));
  // Discord rejects empty fields, so blank traits and tags are dropped first.
  const traits = (Array.isArray(d.traits) ? d.traits : []).filter((t) => t && text(t.name, 16)).slice(0, 6);
  const tags = (Array.isArray(d.tags) ? d.tags : []).map((t) => text(t, 24)).filter(Boolean).slice(0, 4);
  const fields = [
    { name: 'Rarity', value: rarityLine(d), inline: true },
    { name: 'Messages', value: num(d.msgCount), inline: true },
    { name: 'Version', value: 'v' + p.card.version, inline: true },
    traits.length ? { name: 'Traits', value: traits.map((t) => bar(t.value) + ' ' + text(t.name, 16)).join('\n') } : null,
    tags.length ? { name: 'Tags', value: tags.join(' · ') } : null,
    { name: 'Traded out', value: plural(p.card.traded_out, 'time', 'times'), inline: true },
    { name: 'Owned by', value: plural(p.card.owners, 'other player', 'other players'), inline: true },
    { name: 'Collection', value: plural(p.held, 'card', 'cards'), inline: true },
  ].filter(Boolean);
  return {
    embeds: [{
      author,
      title: cut(String(d.name || '').trim() || 'player', 100),
      url,
      color: RARITY_COLORS[rarity],
      description: lines.join('\n\n') || undefined,
      fields,
      thumbnail: httpsUrl(d.portraitUrl) ? { url: d.portraitUrl } : undefined,
      footer: { text: 'Player Cards' + (d.since ? ' · since ' + cut(d.since, 30) : '') },
    }],
    components: [linkButton('Open card', url)],
  };
}

export function collectionMessage(p, self = false) {
  const name = text(p.player.username, 60);
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length && self) return p.card ? { content: 'You haven’t collected any cards yet. Trade with a friend using `/trade`.' } : noCardYet();
  if (!items.length) return { content: '**' + name + '** hasn’t collected any cards yet.' };
  const SHOW = 20;
  const lines = items.slice(0, SHOW).map((i) => '**' + text(i.name || 'player', 32) + '** · ' + editionLabel(i)
    + (i.own ? ' · their own card' : ' · by ' + text(i.maker, 32)));
  if (items.length > SHOW) lines.push('…and ' + plural(items.length - SHOW, 'more', 'more'));
  return {
    embeds: [{
      author: { name: cut(p.player.username, 80), icon_url: httpsUrl(p.player.avatar_url) },
      title: cut(p.player.username, 80) + '’s collection',
      color: TRADE_COLOR,
      description: lines.join('\n'),
      footer: { text: plural(p.held, 'card', 'cards') + ' · ' + plural(p.collected, 'player collected', 'players collected') },
    }],
  };
}

// ---------------------------------------------------------------- the feed

export function feedEmbeds(claim) {
  const players = claim.players || {};
  const cards = claim.cards || {};
  const versions = claim.versions || {};
  const who = (id) => text(players[id] || 'Someone', 40);
  const moved = (list) => cut(list.map((m) => '**' + text((cards[m.card_id] || {}).name || 'a card', 40) + '** · ' + editionLabel(m)).join('\n'), 1024);
  return (claim.events || []).map((e) => {
    if (e.kind === 'trade') {
      return {
        color: TRADE_COLOR,
        description: '⇄ **' + who(e.actor) + '** traded with **' + who(e.other) + '**',
        fields: [
          e.to_other.length ? { name: cut((players[e.other] || 'Someone') + ' got', 256), value: moved(e.to_other) } : null,
          e.to_actor.length ? { name: cut((players[e.actor] || 'Someone') + ' got', 256), value: moved(e.to_actor) } : null,
        ].filter(Boolean),
        timestamp: e.happened_at,
      };
    }
    const d = versions[e.card_id + ':' + e.version] || {};
    const rarity = rarityFor(d.msgCount);
    const picture = httpsUrl(d.imageUrl);
    return {
      color: RARITY_COLORS[rarity],
      description: (e.kind === 'card' ? '✦ **' + who(e.actor) + '** made their card' : '⟳ **' + who(e.actor) + '** updated their card to version ' + e.version)
        + (picture ? '\n' + rarityLine(d) : ''),
      title: cut(String(d.name || '').trim() || 'player', 100),
      url: shareUrl(e.card_id, e.version),
      fields: picture ? [] : [{ name: 'Rarity', value: rarityLine(d), inline: true }],
      image: picture ? { url: picture } : undefined,
      thumbnail: !picture && httpsUrl(d.portraitUrl) ? { url: d.portraitUrl } : undefined,
      timestamp: e.happened_at,
    };
  });
}

// Discord allows 10 embeds and 6,000 characters per message, so posts are split by both.
const embedSize = (e) => [e.title, e.description, e.footer && e.footer.text, e.author && e.author.name,
  ...(e.fields || []).flatMap((f) => [f.name, f.value])].reduce((n, s) => n + (s ? String(s).length : 0), 0);
export function chunkEmbeds(embeds, maxCount = 10, maxChars = 5500) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const e of embeds) {
    const n = embedSize(e);
    if (cur.length && (cur.length >= maxCount || size + n > maxChars)) { out.push(cur); cur = []; size = 0; }
    cur.push(e);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// deps: rpc(name, args), discord(method, path, body) → { ok, status, body }, appId,
//       channels(), postWebhook(channel, message) → 'ok' | 'gone', removeChannel(guildId), setCommandsVersion(v)
export async function runFeed(key, deps) {
  // New cards wait 20 seconds before posting, so the picture the site draws right after saving is ready.
  const claim = await deps.rpc('bot_claim_feed', { p_key: key, p_settle: '20 seconds' });
  let registered = false;
  if (claim.commands_version !== COMMANDS_VERSION && deps.appId) {
    const r = await deps.discord('PUT', '/applications/' + deps.appId + '/commands', COMMANDS);
    if (r.ok) {
      await deps.setCommandsVersion(COMMANDS_VERSION);
      registered = true;
    } else console.error('Registering commands failed', r.status, JSON.stringify(r.body));
  }
  const embeds = feedEmbeds(claim);
  let posts = 0;
  if (embeds.length) {
    for (const ch of await deps.channels()) {
      for (const chunk of chunkEmbeds(embeds)) {
        const res = await deps.postWebhook(ch, { username: 'Player Cards', embeds: chunk, allowed_mentions: { parse: [] } });
        if (res === 'gone') {
          await deps.removeChannel(ch.guild_id); // someone deleted the webhook in Discord
          break;
        }
        posts += 1;
      }
    }
  }
  return { events: embeds.length, posts, registered };
}

// ---------------------------------------------------------------- interactions

// Checks that a request really came from Discord (ed25519 signature over timestamp + body).
const fromHex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));
export async function verifyDiscord(publicKeyHex, signatureHex, timestamp, body, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex || '') || !/^[0-9a-f]{128}$/i.test(signatureHex || '') || !/^\d+$/.test(timestamp || '')) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false; // older than 5 minutes: a replay
  try {
    const key = await crypto.subtle.importKey('raw', fromHex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromHex(signatureHex), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

// Only the person who ran /help, /feed, /trade or /trades sees the reply.
export const isEphemeral = (i) => !!i.data && ['help', 'feed', 'trade', 'trades'].includes(i.data.name);

const userName = (u) => (u && (u.global_name || u.username)) || 'That player';

export async function commandReply(i, deps) {
  const invoker = (i.member && i.member.user) || i.user || {};
  const d = i.data || {};

  if (d.name === 'feed') return feedCommand(i, d, invoker, deps);
  if (d.name === 'help') return helpMessage(await deps.rpc('bot_player', { p_discord_id: String(invoker.id) }));

  let targetId = invoker.id;
  if (d.type === 2) targetId = d.target_id;
  else {
    const opt = (d.options || []).find((o) => o.name === 'player');
    if (opt) targetId = opt.value;
  }
  const resolved = (d.resolved && d.resolved.users && d.resolved.users[targetId]) || (targetId === invoker.id ? invoker : null);
  const self = String(targetId) === String(invoker.id);
  const p = await deps.rpc('bot_player', { p_discord_id: String(targetId) });
  if (!p) return self ? notSignedIn() : otherNotSignedIn(userName(resolved));
  return d.name === 'collection' ? collectionMessage(p, self) : cardMessage(p, self);
}

async function feedCommand(i, d, invoker, deps) {
  if (!i.guild_id) return { content: 'Use this in a server channel.' };
  const sub = ((d.options || [])[0] || {}).name;
  if (sub === 'off') {
    const old = await deps.removeChannel(i.guild_id);
    if (!old) return { content: 'Player Cards wasn’t posting in this server.' };
    await deps.discord('DELETE', '/webhooks/' + old.webhook_id + '/' + old.webhook_token);
    return { content: 'Stopped. New cards and trades won’t be posted here anymore.' };
  }
  const channelId = i.channel_id || (i.channel && i.channel.id);
  const made = await deps.discord('POST', '/channels/' + channelId + '/webhooks', { name: 'Player Cards' });
  if (!made.ok) {
    if (made.status === 403) return { content: 'I need the **Manage Webhooks** permission in this channel to post here. Give it to the Player Cards role (or me) and try again.' };
    return { content: 'Discord wouldn’t let me post in this channel (error ' + made.status + '). Threads and forum channels don’t work; try a normal text channel.' };
  }
  const old = await deps.setChannel({
    guild_id: i.guild_id, channel_id: channelId, webhook_id: made.body.id, webhook_token: made.body.token, added_by: invoker.id || null,
  });
  if (old && old.webhook_id !== made.body.id) await deps.discord('DELETE', '/webhooks/' + old.webhook_id + '/' + old.webhook_token);
  return {
    content: 'Done. New cards, new versions and finished trades will be posted in <#' + channelId + '>, usually within a minute.'
      + (old && old.channel_id !== channelId ? ' (It stopped posting in <#' + old.channel_id + '>.)' : '')
      + '\nTrade messages and open offers are never posted.',
  };
}
