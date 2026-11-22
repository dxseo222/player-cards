// Export parser, suggestions and card cleaning, run on a small made-up Discord export.
// No real messages are used here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExport, sources, computeStats, suggest } from '../js/export.js';
import { cleanCard, clip, rarityFor, nextTier, editionLabel } from '../js/card.js';

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const FANCY_SERVER = '𝕷𝖔𝖛𝖊 𝕷𝖊𝖙𝖙𝖊𝖗 𝕮𝖑𝖚𝖇';

// A fake export: one server channel with a fancy-letter server name, one DM, one private channel.
function fakeExport() {
  const lines = ['idk fr', 'i love making beats at night', 'lmao 😭😭', 'type shi', 'icl this goes hard 🔥', 'im not sleeping tonight fr', 'who up', 'red is my favorite color'];
  const messages = (n, start, stepHours) => Array.from({ length: n }, (_, i) => ({
    ID: i, Timestamp: new Date(Date.parse(start) + i * stepHours * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
    Contents: lines[i % lines.length], Attachments: '',
  }));
  const file = (obj) => ({ text: async () => JSON.stringify(obj) });
  return [
    { path: 'Messages/index.json', file: file({ 1: 'general, ' + FANCY_SERVER, 2: 'Direct Message with someone', 3: 'secret, ' + FANCY_SERVER }) },
    { path: 'Messages/c1/channel.json', file: file({ id: '1', type: 'GUILD_TEXT', name: 'general', guild: { id: '9', name: FANCY_SERVER } }) },
    { path: 'Messages/c1/messages.json', file: file(messages(5200, '2023-01-01T20:00:00Z', 2)) },
    { path: 'Messages/c2/channel.json', file: file({ id: '2', type: 'DM', recipients: ['x', 'y'] }) },
    { path: 'Messages/c2/messages.json', file: file(messages(300, '2023-03-01T23:00:00Z', 5)) },
    { path: 'Messages/c3/channel.json', file: file({ id: '3', type: 'GUILD_TEXT', name: 'secret', guild: { id: '9', name: FANCY_SERVER } }) },
    { path: 'Messages/c3/messages.json', file: file(messages(50, '2023-02-01T12:00:00Z', 1)) },
    { path: 'Messages/c3/notes.txt', file: file('ignored') },
  ];
}

test('parses every channel and groups them by server for the exclude list', async () => {
  const parsed = await parseExport(fakeExport());
  assert.equal(parsed.channels.length, 3);
  const groups = sources(parsed);
  const server = groups.find((g) => g.kind === 'server');
  assert.equal(server.guild, FANCY_SERVER);
  assert.equal(server.count, 5250);
  assert.deepEqual(server.channels.map((c) => c.name), ['general', 'secret']);
  assert.equal(groups.find((g) => g.kind === 'dm').count, 300);
});

test('refuses a folder with no messages', async () => {
  await assert.rejects(parseExport([{ path: 'Account/user.json', file: { text: async () => '{}' } }]), /No messages found/);
});

test('excluded channels are left out of every number', async () => {
  const parsed = await parseExport(fakeExport());
  const all = computeStats(parsed);
  const without = computeStats(parsed, new Set(['3']));
  assert.equal(all.total, 5550);
  assert.equal(without.total, 5500);
  assert.equal(computeStats(parsed, new Set(['1', '2', '3'])), null, 'nothing left means no stats');
});

test('suggestions: rarity from message count, real record, no broken characters', async () => {
  const stats = computeStats(await parseExport(fakeExport()), new Set(['3']));
  const s = suggest(stats, 1);
  assert.equal(s.msgCount, 5500);
  assert.equal(s.rarity, 'Rare');
  assert.equal(s.traits.length, 6);
  assert.ok(s.traits.every((t) => t.value >= 1 && t.value <= 10));
  assert.equal(s.record.find((r) => r.label === 'Home server').value, FANCY_SERVER);
  assert.ok(s.catchphrases.includes('fr'));
  assert.equal(s.emblem, '😭');
  assert.ok(s.quoteCandidates.length > 0 && s.quoteCandidates.every((q) => /\d{4}$/.test(q.date)), 'quotes carry their date');
  const card = cleanCard({ ...s, name: 'test' });
  assert.ok(!LONE_SURROGATE.test(JSON.stringify(card)), 'no half characters anywhere on the card');
  assert.equal(card.rarity, 'Rare');
});

test('clip never cuts a character in half', () => {
  assert.equal(clip(FANCY_SERVER, 5), '𝕷𝖔');
  assert.equal(clip('😭😭😭', 5), '😭😭');
  assert.equal(clip('👨‍👩‍👧 family', 4), '', 'a family emoji is one character of 8 units');
  assert.equal(clip('bad\ud835 half', 20), 'bad half', 'stray halves are removed');
  assert.equal(clip(null, 5), '');
});

test('cleanCard keeps cards within limits and drops bad values', () => {
  const card = cleanCard({
    name: 'x'.repeat(100), msgCount: 'lots', theme: 'nope', frame: 'holo', colors: { accent: 'red', bg: '#112233' },
    portraitUrl: 'https://evil.example.com/a.png', traits: Array(10).fill({ name: 'T', value: 99 }), accent: '#abcdef',
  });
  assert.equal(card.name.length, 24);
  assert.equal(card.rarity, 'Common');
  assert.equal(card.theme, 'requiem');
  assert.equal(card.frame, 'holo');
  assert.equal(card.colors.accent, '', 'invalid colors are dropped');
  assert.equal(card.colors.bg, '#112233');
  assert.equal(cleanCard({ accent: '#ABCDEF' }).colors.accent, '#abcdef', 'older cards keep their single accent color');
  assert.equal(card.portraitUrl, '', 'only Supabase storage pictures are allowed');
  assert.equal(card.traits.length, 6);
  assert.ok(card.traits.every((t) => t.value === 10));
});

test('rarity tiers and edition labels', () => {
  assert.deepEqual([0, 4999, 5000, 25000, 75000, 150000].map(rarityFor), ['Common', 'Common', 'Rare', 'Epic', 'Legendary', 'Mythic']);
  assert.equal(nextTier(6000).name, 'Epic');
  assert.equal(nextTier(200000), null);
  assert.equal(editionLabel({ edition: 'original', serial: 2, version: 1 }), 'Original 2/2');
  assert.equal(editionLabel({ edition: 'copy', serial: 7, version: 3 }), 'v3 · Copy #7');
});
