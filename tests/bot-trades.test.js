// Trading in Discord (supabase/functions/discord-bot/trades.ts) with fake Discord and database
// calls: building an offer with the menus, the channel ping, and answering an offer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as t from '../supabase/functions/discord-bot/trades.ts';
import { COMMANDS, isEphemeral } from '../supabase/functions/discord-bot/bot.ts';

const ME = '100000000000000001';
const PAL = '100000000000000002';
const DRAFT = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const TRADE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const ITEM = (n) => '0000000' + n + '-0000-0000-0000-000000000000';

const options = (over = {}) => ({
  me: { id: 'u-me', username: 'dxseo' },
  them: { id: 'u-pal', username: 'pal_*' },
  my_mint: { card_id: 'c-me', name: 'dxseo', next: 'Copy #3' },
  their_mint: { card_id: 'c-pal', name: 'pal', next: 'Original 2/2' },
  mine: [{ id: ITEM(1), card_id: 'c-x', name: 'xan', maker: 'xan', edition: 'copy', serial: 2, version: 1 }],
  theirs: [{ id: ITEM(2), card_id: 'c-y', name: 'yui', maker: 'yui', edition: 'original', serial: 2, version: 2 }],
  ...over,
});
const view = (over = {}) => ({
  id: TRADE, status: 'pending', message: 'deal?', created_at: new Date().toISOString(), counter_of: null, viewer: 'to',
  from: { id: 'u-me', username: 'dxseo', discord: ME }, to: { id: 'u-pal', username: 'pal_*', discord: PAL },
  offer_items: [], offer_mint: { name: 'dxseo', next: 'Copy #3' }, request_items: options().theirs, request_mint: null,
  ...over,
});

function fakeDeps({ opts = options(), tradeView = view(), sendError = null, actionResult = 'accepted' } = {}) {
  const drafts = new Map();
  const log = { rpc: [] };
  return {
    log,
    drafts,
    async rpc(name, args) {
      log.rpc.push([name, args]);
      if (name === 'bot_trade_options') return opts;
      if (name === 'bot_trade_view') return tradeView;
      if (name === 'bot_open_trades') return [{ id: TRADE, incoming: true, other: 'dxseo', gives: 1, gets: 1, created_at: new Date().toISOString() }];
      if (name === 'bot_trade') {
        if (args.p_action === 'send') {
          if (sendError) throw new Error(sendError);
          drafts.delete(args.p_draft);
          return { trade_id: TRADE, counter: false };
        }
        return { result: args.p_action === 'accept' ? actionResult : args.p_action + 'd' };
      }
      throw new Error('unknown ' + name);
    },
    async createDraft(row) {
      const d = { id: DRAFT, counter_of: null, offer_items: [], offer_mint: false, request_items: [], request_mint: false, message: null, ...row };
      drafts.set(d.id, d);
      return d;
    },
    async getDraft(id) { return drafts.get(id) || null; },
    async updateDraft(id, patch) { const d = { ...drafts.get(id), ...patch }; drafts.set(id, d); return d; },
    async deleteDraft(id) { drafts.delete(id); },
  };
}
const member = (id = ME) => ({ member: { user: { id, username: 'x' } }, guild_id: 'g1', channel_id: 'c1', application_id: 'app', token: 'tok' });
const slash = (name, options = []) => ({ type: 2, ...member(), data: { name, type: 1, options } });
const click = (custom_id, extra = {}, who = ME) => ({ type: 3, ...member(who), data: { custom_id, component_type: 2, ...extra } });

test('trades: /trade opens a private builder with both sides to pick from', async () => {
  const deps = fakeDeps();
  const i = slash('trade', [{ name: 'player', type: 6, value: PAL }]);
  assert.equal(isEphemeral(i), true, 'only you see the builder');
  const msg = await t.tradeCommand(i, deps);
  assert.deepEqual(deps.drafts.get(DRAFT).to_user, 'u-pal');
  const [give, want, buttons] = msg.components.map((r) => r.components);
  assert.deepEqual(give[0].options.map((o) => o.label), ['New edition of your card · Copy #3', 'xan · Copy #2']);
  assert.deepEqual(want[0].options.map((o) => o.value), ['mint', ITEM(2)]);
  assert.equal(want[0].options[1].label, 'yui · v2 · Original 2/2');
  assert.equal(buttons[0].disabled, true, 'nothing to send yet');
  assert.equal(msg.embeds[0].title, 'Trade with pal_*');
  assert.ok(COMMANDS.some((c) => c.name === 'trade') && COMMANDS.some((c) => c.name === 'trades'));
});

test('trades: picking cards, adding a note, then sending pings them in the channel', async () => {
  const deps = fakeDeps();
  await t.tradeCommand(slash('trade', [{ name: 'player', type: 6, value: PAL }]), deps);

  const give = t.componentReply(click('td:' + DRAFT + ':give', { values: ['mint', ITEM(1)] }), deps);
  assert.deepEqual(give.response, { type: 6 }, 'answered right away, the message is updated after');
  const afterGive = (await give.later()).edit;
  assert.equal(afterGive.components[0].components[0].options.filter((o) => o.default).length, 2, 'choices stay ticked');
  assert.match(afterGive.embeds[0].fields[0].value, /A new edition of your card \(Copy #3\)\n\*\*xan\*\* · Copy #2/);
  assert.equal(afterGive.components[2].components[0].disabled, false);

  const note = t.componentReply(click('td:' + DRAFT + ':note'), deps);
  assert.equal(note.response.type, 9, 'opens the note form');
  assert.equal(note.later, undefined);
  const typed = t.componentReply({ type: 5, ...member(), data: { custom_id: 'tdn:' + DRAFT, components: [{ type: 1, components: [{ type: 4, custom_id: 'note', value: '  for your card?  ' }] }] } }, deps);
  const afterNote = (await typed.later()).edit;
  assert.equal(deps.drafts.get(DRAFT).message, 'for your card?');
  assert.equal(afterNote.embeds[0].fields.at(-1).value, 'for your card?');

  const sent = await t.componentReply(click('td:' + DRAFT + ':send'), deps).later();
  assert.match(sent.edit.content, /^Offer sent to \*\*pal\\_\\\*\*\*/);
  assert.deepEqual(sent.edit.components, []);
  assert.equal(sent.followup.content, '<@' + PAL + '>, **dxseo** sent you a trade offer. Only you can open it.');
  assert.deepEqual(sent.followup.allowed_mentions, { users: [PAL] }, 'pings only them');
  assert.equal(sent.followup.components[0].components[0].custom_id, 'tv:' + TRADE);
  assert.ok(!JSON.stringify(sent.followup).includes('for your card'), 'what’s in the offer stays private');
});

test('trades: only the person who made a draft can use it, and errors keep the builder', async () => {
  const deps = fakeDeps({ sendError: 'That card is not available' });
  await t.tradeCommand(slash('trade', [{ name: 'player', type: 6, value: PAL }]), deps);
  const stranger = await t.componentReply(click('td:' + DRAFT + ':give', { values: ['mint'] }, PAL), deps).later();
  assert.match(stranger.edit.content, /already sent or cancelled/);
  assert.equal(deps.drafts.get(DRAFT).offer_mint, false);

  const failed = await t.componentReply(click('td:' + DRAFT + ':send'), deps).later();
  assert.match(failed.edit.content, /⚠️ That card is not available/);
  assert.ok(failed.edit.components.length, 'the menus stay so it can be fixed');
  assert.equal(failed.followup, undefined);

  const cancelled = await t.componentReply(click('td:' + DRAFT + ':cancel'), deps).later();
  assert.match(cancelled.edit.content, /Nothing was sent/);
  assert.equal(deps.drafts.size, 0);
});

test('trades: View offer shows the offer only to the two players, with the right buttons', async () => {
  const deps = fakeDeps();
  const r = t.componentReply(click('tv:' + TRADE, {}, PAL), deps);
  assert.deepEqual(r.response, { type: 5, data: { flags: 64 } }, 'a private reply');
  const msg = (await r.later()).edit;
  assert.equal(msg.embeds[0].title, 'Trade offer from dxseo');
  assert.deepEqual(msg.components[0].components.map((b) => b.label), ['Accept', 'Decline', 'Counter', 'Open on site']);
  assert.equal(msg.embeds[0].fields.at(-1).value, 'deal?');

  const sender = t.viewMessage(view({ viewer: 'from' }));
  assert.deepEqual(sender.components[0].components.map((b) => b.label), ['Cancel offer', 'Open on site']);
  assert.match(t.viewMessage(null).content, /isn’t yours to see/);
  const done = t.viewMessage(view({ status: 'accepted' }));
  assert.equal(done.embeds[0].description, 'This offer was accepted.');
  assert.deepEqual(done.components[0].components.map((b) => b.label), ['Open on site']);
  assert.ok(!done.embeds[0].fields[0].value.includes('Copy #3'), 'no “next edition” once it’s settled');
});

test('trades: accepting pings the sender, declining stays quiet, counter starts a turned-around draft', async () => {
  const accepted = fakeDeps({ tradeView: view({ status: 'accepted' }) });
  const a = await t.componentReply(click('ta:' + TRADE, {}, PAL), accepted).later();
  assert.match(a.edit.content, /Trade done/);
  assert.equal(a.followup.content, '<@' + ME + '>, **pal\\_\\*** accepted your trade offer. Your new cards are in your collection.');
  assert.deepEqual(a.followup.allowed_mentions, { users: [ME] });
  assert.deepEqual(accepted.log.rpc[0], ['bot_trade', { p_discord_id: PAL, p_action: 'accept', p_trade: TRADE }]);

  const failed = await t.componentReply(click('ta:' + TRADE, {}, PAL), fakeDeps({ actionResult: 'failed' })).later();
  assert.match(failed.edit.content, /changed hands/);
  assert.equal(failed.followup, undefined);

  const declined = await t.componentReply(click('tx:' + TRADE, {}, PAL), fakeDeps({ tradeView: view({ status: 'declined' }) })).later();
  assert.equal(declined.edit.content, 'Offer declined.');
  assert.equal(declined.followup, undefined, 'declines aren’t announced');

  const deps = fakeDeps({ opts: options({ me: { id: 'u-pal', username: 'pal_*' }, them: { id: 'u-me', username: 'dxseo' }, mine: options().theirs, theirs: [] }) });
  const c = await t.componentReply(click('tc:' + TRADE, {}, PAL), deps).later();
  const d = deps.drafts.get(DRAFT);
  assert.deepEqual([d.counter_of, d.to_user, d.to_discord_id, d.offer_items, d.request_mint], [TRADE, 'u-me', ME, [ITEM(2)], true]);
  assert.equal(c.edit.embeds[0].title, 'Counter-offer to dxseo');
  assert.equal(c.edit.components.at(-1).components[0].label, 'Send counter-offer');
});

test('trades: /trades lists open offers with a menu to open one', async () => {
  const deps = fakeDeps();
  const msg = await t.tradeCommand(slash('trades'), deps);
  assert.match(msg.embeds[0].fields[0].value, /From \*\*dxseo\*\* · 1 for 1/);
  assert.equal(msg.components[0].components[0].custom_id, 'tl');
  const opened = await t.componentReply(click('tl', { component_type: 3, values: [TRADE] }, PAL), deps).later();
  assert.equal(opened.edit.embeds[0].title, 'Trade offer from dxseo');
  const none = t.listMessage([]);
  assert.match(none.content, /no open trade offers/);
});

test('trades: every message fits Discord’s limits', async () => {
  const many = Array.from({ length: 40 }, (_, k) => ({ id: ITEM(1).replace('1', String(k % 10)) + k, name: 'n'.repeat(120), maker: 'm'.repeat(120), edition: 'copy', serial: k, version: 1 }));
  const msg = t.builderMessage({ id: DRAFT, offer_items: [], offer_mint: false, request_items: [], request_mint: false, message: null }, options({ mine: many, theirs: many }));
  for (const r of msg.components) for (const c of r.components) {
    assert.ok(c.custom_id.length <= 100);
    if (c.options) {
      assert.ok(c.options.length <= 25 && c.max_values <= c.options.length);
      for (const o of c.options) assert.ok(o.label.length <= 100 && (!o.description || o.description.length <= 100));
    }
  }
  assert.match(msg.embeds[0].description, /didn’t fit/);
  for (const f of msg.embeds[0].fields) assert.ok(f.value.length >= 1 && f.value.length <= 1024);
});
