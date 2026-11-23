// The Discord bot's logic (supabase/functions/discord-bot/bot.ts) with fake Discord and database
// calls: request signatures, /card, /collection, /feed and the posts the feed makes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as bot from '../supabase/functions/discord-bot/bot.ts';
import { rarityFor as siteRarity } from '../js/card.js';

const ME = '100000000000000001';
const FRIEND = '100000000000000002';
const CARD = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CARD_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PORTRAIT = 'https://xqinypchsnkoiezpvqyn.supabase.co/storage/v1/object/public/portraits/u/me.webp';

const player = (over = {}) => ({
  player: { id: 'p1', username: 'dxseo', avatar_url: 'https://cdn.discordapp.com/avatars/1/a.png' },
  card: {
    id: CARD, hidden: false, version: 2, traded_out: 3, owners: 2,
    data: { name: 'dxseo', msgCount: 80000, className: 'Night Owl', quote: 'who up', traits: [{ name: 'Chaos', value: 7 }], tags: ['beats'], portraitUrl: PORTRAIT },
  },
  held: 4,
  collected: 2,
  items: [{ card_id: CARD_B, name: 'bob', maker: 'bob', own: false, edition: 'original', serial: 2, version: 1 }],
  ...over,
});

function fakeDeps({ players = {}, claim = null, channels = [], webhookStatus = 'ok', made = { ok: true, status: 200, body: { id: 'w2', token: 't2' } }, old = null } = {}) {
  const log = { rpc: [], discord: [], posts: [], removed: [], set: [], version: null };
  return {
    log,
    appId: 'app',
    async rpc(name, args) {
      log.rpc.push([name, args]);
      if (name === 'bot_player') return players[args.p_discord_id] || null;
      if (name === 'bot_claim_feed') {
        if (args.p_key !== 'key') throw new Error('Wrong feed key');
        return claim;
      }
      throw new Error('unknown rpc ' + name);
    },
    async discord(method, path, body) {
      log.discord.push([method, path, body]);
      if (method === 'POST' && path.endsWith('/webhooks')) return made;
      return { ok: true, status: 200, body: null };
    },
    async channels() { return channels; },
    async postWebhook(ch, message) { log.posts.push([ch.guild_id, message]); return webhookStatus; },
    async setChannel(row) { log.set.push(row); return old; },
    async removeChannel(guildId) { log.removed.push(guildId); return old; },
    async setCommandsVersion(v) { log.version = v; },
  };
}
const slash = (name, options = [], extra = {}) => ({
  type: 2, guild_id: 'g1', channel_id: 'c1', member: { user: { id: ME, username: 'me' } },
  data: { name, type: 1, options, ...extra }, ...(extra.top || {}),
});

test('bot: rarity matches the site for every tier boundary', () => {
  for (const n of [0, 1, 4999, 5000, 24999, 25000, 74999, 75000, 149999, 150000, 9e6, 'junk', null]) assert.equal(bot.rarityFor(n), siteRarity(n), String(n));
});

test('bot: text is shortened safely and player text can’t format, link or mention', () => {
  const fancy = '𝕷𝖔𝖛𝖊'.repeat(10);
  const short = bot.cut(fancy, 9);
  assert.ok(short.length <= 9);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(short), 'no half characters');
  assert.equal(bot.cut('abc', 3), 'abc');
  assert.equal(bot.esc('**bold** [x](http://y) @everyone <@1>'), '\\*\\*bold\\*\\* \\[x\\]\\(http\\://y\\) \\@everyone \\<\\@1\\>');
});

test('bot: only requests signed by Discord, and only fresh ones, are accepted', async () => {
  const pair = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"type":1}';
  const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(ts + body))).toString('hex');
  assert.equal(await bot.verifyDiscord(pub, sig, ts, body), true);
  assert.equal(await bot.verifyDiscord(pub, sig, ts, '{"type":2}'), false, 'changed body');
  assert.equal(await bot.verifyDiscord(pub, sig, String(Number(ts) + 1), body), false, 'changed timestamp');
  assert.equal(await bot.verifyDiscord(pub, sig, ts, body, Date.now() + 10 * 60 * 1000), false, 'replayed later');
  assert.equal(await bot.verifyDiscord(pub, null, ts, body), false);
  assert.equal(await bot.verifyDiscord('', sig, ts, body), false, 'no key configured');
});

test('bot: /card shows your own card, someone else’s, or says why it can’t', async () => {
  const deps = fakeDeps({ players: { [ME]: player(), [FRIEND]: player({ card: null, player: { id: 'p2', username: 'pal' } }) } });
  const mine = await bot.commandReply(slash('card'), deps);
  const [embed] = mine.embeds;
  assert.equal(embed.title, 'dxseo');
  assert.equal(embed.color, bot.RARITY_COLORS.Legendary);
  assert.equal(embed.url, bot.SITE + '#view-' + CARD + '-v2');
  assert.equal(embed.thumbnail.url, PORTRAIT);
  assert.ok(embed.fields.some((f) => f.name === 'Traits' && f.value.includes('▰▰▰▰▰▰▰▱▱▱')));
  assert.equal(mine.components[0].components[0].url, embed.url, 'Open card button');

  const noCard = await bot.commandReply(slash('card', [{ name: 'player', type: 6, value: FRIEND }]), deps);
  assert.match(noCard.content, /pal\*\* signed in but hasn’t made a card yet/);

  const stranger = await bot.commandReply(slash('card', [{ name: 'player', type: 6, value: '999' }], { resolved: { users: { 999: { id: '999', global_name: 'New_Guy' } } } }), deps);
  assert.match(stranger.content, /New\\_Guy\*\* is not on Player Cards yet/);

  const hidden = await bot.commandReply(slash('card'), fakeDeps({ players: { [ME]: player({ card: { id: CARD, hidden: true, version: 1, data: null } }) } }));
  assert.match(hidden.content, /hidden by a moderator/);

  const rightClick = await bot.commandReply(slash('Player Card', [], { type: 2, target_id: ME }), deps);
  assert.equal(rightClick.embeds[0].title, 'dxseo', 'right-click → Apps → Player Card');
  assert.equal(bot.isEphemeral(slash('card')), false);
});

test('bot: /collection lists what someone holds', async () => {
  const deps = fakeDeps({ players: { [ME]: player() } });
  const r = await bot.commandReply(slash('collection'), deps);
  assert.match(r.embeds[0].description, /\*\*bob\*\* · Original 2\/2 · by bob/);
  assert.match(r.embeds[0].footer.text, /4 cards · 2 players collected/);
  const empty = await bot.commandReply(slash('collection'), fakeDeps({ players: { [ME]: player({ items: [] }) } }));
  assert.match(empty.content, /hasn’t collected any cards yet/);
});

test('bot: /feed here makes a webhook, replaces the old one, and explains missing permissions', async () => {
  const deps = fakeDeps({ old: { guild_id: 'g1', channel_id: 'c0', webhook_id: 'w1', webhook_token: 't1' } });
  const here = slash('feed', [{ name: 'here', type: 1 }]);
  assert.equal(bot.isEphemeral(here), true);
  const r = await bot.commandReply(here, deps);
  assert.match(r.content, /posted in <#c1>/);
  assert.match(r.content, /stopped posting in <#c0>/);
  assert.deepEqual(deps.log.set[0], { guild_id: 'g1', channel_id: 'c1', webhook_id: 'w2', webhook_token: 't2', added_by: ME });
  assert.deepEqual(deps.log.discord.at(-1).slice(0, 2), ['DELETE', '/webhooks/w1/t1'], 'the old webhook is cleaned up');

  const noPerm = await bot.commandReply(here, fakeDeps({ made: { ok: false, status: 403, body: {} } }));
  assert.match(noPerm.content, /Manage Webhooks/);

  const off = fakeDeps({ old: { guild_id: 'g1', channel_id: 'c1', webhook_id: 'w2', webhook_token: 't2' } });
  assert.match((await bot.commandReply(slash('feed', [{ name: 'off', type: 1 }]), off)).content, /^Stopped/);
  assert.deepEqual(off.log.removed, ['g1']);
  assert.match((await bot.commandReply(slash('feed', [{ name: 'off', type: 1 }]), fakeDeps())).content, /wasn’t posting/);
});

const claimWith = (events, extra = {}) => ({
  events,
  players: { p1: 'dxseo', p2: 'pal_*' },
  cards: { [CARD]: { name: 'dxseo' }, [CARD_B]: { name: 'pal' } },
  versions: { [CARD + ':1']: { name: 'dxseo', msgCount: 160000, portraitUrl: PORTRAIT } },
  commands_version: bot.COMMANDS_VERSION,
  ...extra,
});
const cardEvent = { kind: 'card', happened_at: '2026-11-22T10:00:00Z', actor: 'p1', other: null, card_id: CARD, version: 1, to_other: [], to_actor: [] };
const tradeEvent = {
  kind: 'trade', happened_at: '2026-11-22T11:00:00Z', actor: 'p1', other: 'p2', card_id: null, version: null,
  to_other: [{ card_id: CARD, version: 1, edition: 'original', serial: 2 }], to_actor: [{ card_id: CARD_B, version: 3, edition: 'copy', serial: 4 }],
};

test('bot: feed posts new cards and trades to every server, ten at a time', async () => {
  const events = [cardEvent, tradeEvent, ...Array.from({ length: 10 }, () => cardEvent)];
  const deps = fakeDeps({ claim: claimWith(events), channels: [{ guild_id: 'g1' }, { guild_id: 'g2' }] });
  const r = await bot.runFeed('key', deps);
  assert.deepEqual(r, { events: 12, posts: 4, registered: false });
  const [first] = deps.log.posts;
  assert.equal(first[1].embeds.length, 10);
  assert.deepEqual(first[1].allowed_mentions, { parse: [] });
  const [made, trade] = first[1].embeds;
  assert.equal(made.description, '✦ **dxseo** made their card');
  assert.equal(made.color, bot.RARITY_COLORS.Mythic);
  assert.equal(made.url, bot.SITE + '#view-' + CARD + '-v1');
  assert.equal(trade.description, '⇄ **dxseo** traded with **pal\\_\\***');
  assert.deepEqual(trade.fields.map((f) => [f.name, f.value]), [['pal_* got', '**dxseo** · Original 2/2'], ['dxseo got', '**pal** · v3 · Copy #4']]);
});

test('bot: feed registers commands once, drops deleted webhooks, and needs the key', async () => {
  const deps = fakeDeps({ claim: claimWith([cardEvent], { commands_version: 0 }), channels: [{ guild_id: 'g1' }], webhookStatus: 'gone' });
  const r = await bot.runFeed('key', deps);
  assert.equal(r.registered, true);
  assert.deepEqual(deps.log.discord[0].slice(0, 2), ['PUT', '/applications/app/commands']);
  assert.equal(deps.log.version, bot.COMMANDS_VERSION);
  assert.deepEqual(deps.log.removed, ['g1'], 'a webhook someone deleted stops the posts there');

  const quiet = fakeDeps({ claim: claimWith([]), channels: [{ guild_id: 'g1' }] });
  assert.deepEqual(await bot.runFeed('key', quiet), { events: 0, posts: 0, registered: false });
  assert.equal(quiet.log.discord.length, 0);

  await assert.rejects(bot.runFeed('nope', fakeDeps({ claim: claimWith([]) })), /Wrong feed key/);
});

test('bot: big bursts are split so no post goes over Discord’s size limit', () => {
  const big = { description: 'x'.repeat(2000), fields: [{ name: 'a got', value: 'y'.repeat(1024) }] };
  const chunks = bot.chunkEmbeds(Array.from({ length: 5 }, () => big));
  assert.deepEqual(chunks.map((c) => c.length), [1, 1, 1, 1, 1]);
  assert.deepEqual(bot.chunkEmbeds(Array.from({ length: 23 }, () => ({ description: 'hi' }))).map((c) => c.length), [10, 10, 3]);
});

test('bot: blank tags and traits never make an empty field', async () => {
  const p = player();
  p.card.data = { ...p.card.data, tags: ['  ', ''], traits: [{ name: '   ', value: 3 }], name: '   ' };
  const r = await bot.commandReply(slash('card'), fakeDeps({ players: { [ME]: p } }));
  assert.ok(r.embeds[0].fields.every((f) => f.value && f.value.trim()), 'every field has text');
  assert.ok(!r.embeds[0].fields.some((f) => f.name === 'Tags' || f.name === 'Traits'));
  assert.equal(r.embeds[0].title, 'player');
});

test('bot: command names and options are ones Discord accepts', () => {
  for (const c of bot.COMMANDS) {
    if (c.type === 1) {
      assert.match(c.name, /^[a-z0-9_-]{1,32}$/);
      assert.ok(c.description.length >= 1 && c.description.length <= 100, c.name);
    } else assert.ok(c.name.length <= 32 && !('description' in c));
    for (const o of c.options || []) assert.ok(o.description.length <= 100 && /^[a-z0-9_-]{1,32}$/.test(o.name));
  }
});
