// Trading through the Discord bot (supabase/010_bot_trades.sql): the bot acts for the Discord
// user who pressed a button, through the site's own trade functions and rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, q, as, asBot, addUser, A, B, C } from './db-helpers.js';

const rejects = (promise, pattern) => assert.rejects(promise, pattern);
const D = { [A]: '100000000000000001', [B]: '100000000000000002', [C]: '100000000000000003' };

async function world() {
  const db = await freshDb();
  for (const [id, name] of [[A, 'alice'], [B, 'bob'], [C, 'carol']]) {
    await addUser(db, id, { name });
    await q(db, `insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', $2)`, [id, D[id]]);
  }
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice"}')`));
  await as(db, B, () => q(db, `select public.save_card('{"name":"bob"}')`));
  return db;
}
const bot = (db, sql, params) => asBot(db, () => q(db, sql, params)).then((r) => r[0].r);
const draft = async (db, from, to, fields) => {
  const cols = Object.keys(fields);
  const vals = Object.values(fields);
  const rows = await asBot(db, () => q(db, `insert into public.bot_trade_drafts (discord_id, to_discord_id, to_user${cols.map((c) => ', ' + c).join('')})
    values ($1, $2, $3${cols.map((_, i) => ', $' + (i + 4)).join('')}) returning id`, [D[from], D[to], to, ...vals]));
  return rows[0].id;
};
const send = (db, who, draftId) => bot(db, `select public.bot_trade($1, 'send', null, $2) r`, [D[who], draftId]);
const act = (db, who, action, trade) => bot(db, 'select public.bot_trade($1, $2, $3) r', [D[who], action, trade]);

test('bot trades: options list what each side can trade, never Original 1/2', async () => {
  const db = await world();
  const o = await bot(db, 'select public.bot_trade_options($1, $2) r', [D[A], D[B]]);
  assert.equal(o.me.username, 'alice');
  assert.equal(o.them.username, 'bob');
  assert.deepEqual(o.my_mint && [o.my_mint.name, o.my_mint.next], ['alice', 'Original 2/2']);
  assert.deepEqual(o.mine, [], 'Alice only holds her own Original 1/2, which never trades');
  await rejects(bot(db, 'select public.bot_trade_options($1, $2) r', [D[A], D[A]]), /yourself/);
  await rejects(bot(db, `select public.bot_trade_options($1, '999') r`, [D[A]]), /isn't on Player Cards yet/);
  await rejects(bot(db, `select public.bot_trade_options('999', $1) r`, [D[A]]), /Sign in on the Player Cards site/);
  const carol = await bot(db, 'select public.bot_trade_options($1, $2) r', [D[A], D[C]]);
  assert.equal(carol.their_mint, null, 'Carol has no card to hand out yet');
});

test('bot trades: send, accept and the cards move exactly like a site trade', async () => {
  const db = await world();
  const id = await draft(db, A, B, { offer_mint: true, request_mint: true, message: 'swap?' });
  const sent = await send(db, A, id);
  assert.equal(sent.counter, false);
  const trade = (await q(db, 'select * from public.trades where id = $1', [sent.trade_id]))[0];
  assert.deepEqual([trade.from_user, trade.to_user, trade.status, trade.message], [A, B, 'pending', 'swap?']);
  assert.equal((await q(db, 'select count(*)::int n from public.bot_trade_drafts'))[0].n, 0, 'the draft is gone once sent');
  await rejects(send(db, A, id), /already sent/);

  const view = await bot(db, 'select public.bot_trade_view($1, $2) r', [D[B], sent.trade_id]);
  assert.equal(view.viewer, 'to');
  assert.equal(view.from.discord, D[A]);
  assert.equal(view.offer_mint.name, 'alice');
  assert.equal(view.message, 'swap?');
  assert.equal(await bot(db, 'select public.bot_trade_view($1, $2) r', [D[C], sent.trade_id]), null, 'nobody else can see it');

  const open = await bot(db, 'select public.bot_open_trades($1) r', [D[B]]);
  assert.deepEqual(open.map((t) => [t.incoming, t.other, t.gives, t.gets]), [[true, 'alice', 1, 1]]);

  await rejects(act(db, A, 'accept', sent.trade_id), /Trade not found/, 'only the person it was sent to can accept');
  assert.deepEqual(await act(db, B, 'accept', sent.trade_id), { result: 'accepted' });
  const got = await q(db, `select c.creator_id, i.edition, i.serial from public.items i join public.cards c on c.id = i.card_id where i.owner_id = $1 order by c.creator_id`, [B]);
  assert.deepEqual(got.map((x) => [x.creator_id, x.edition, x.serial]), [[A, 'original', 2], [B, 'original', 1]]);
  assert.equal((await q(db, `select auth.uid() u`))[0].u, null, 'acting as a player ends with the request');
});

test('bot trades: the site’s rules still apply, and counters, declines and cancels work', async () => {
  const db = await world();
  const aliceOriginal = (await q(db, `select id from public.items where owner_id = $1`, [A]))[0].id;
  await rejects(send(db, A, await draft(db, A, B, { offer_items: [aliceOriginal] })), /not available/, 'Original 1/2 never trades');
  await rejects(send(db, A, await draft(db, A, B, {})), /at least one card/);
  await rejects(send(db, B, await draft(db, A, B, { offer_mint: true })), /already sent or cancelled/, 'only the person who made a draft can send it');

  const first = (await send(db, A, await draft(db, A, B, { offer_mint: true }))).trade_id;
  // Bob counters: he asks for the same, and offers his own card too
  const counterId = await draft(db, B, A, { counter_of: first, offer_mint: true, request_mint: true });
  const counter = await send(db, B, counterId);
  assert.equal(counter.counter, true);
  assert.equal((await q(db, 'select status from public.trades where id = $1', [first]))[0].status, 'countered');
  assert.equal((await q(db, 'select counter_of from public.trades where id = $1', [counter.trade_id]))[0].counter_of, first);

  assert.deepEqual(await act(db, A, 'decline', counter.trade_id), { result: 'declined' });
  const again = (await send(db, A, await draft(db, A, B, { offer_mint: true }))).trade_id;
  await rejects(act(db, B, 'cancel', again), /not found or already answered/, 'only the sender can take an offer back');
  assert.deepEqual(await act(db, A, 'cancel', again), { result: 'cancelled' });
  await rejects(act(db, B, 'accept', again), /already cancelled/);
});

test('bot trades: closed to the site and to signed-out visitors', async () => {
  const db = await world();
  for (const sql of [
    `select public.bot_trade('1', 'cancel', null)`, `select public.bot_trade_options('1', '2')`, `select public.bot_open_trades('1')`,
    `select public._act_as('${A}')`, `select * from public.bot_trade_drafts`,
  ]) {
    await rejects(as(db, A, () => q(db, sql)), /permission denied/, sql);
    await rejects(as(db, null, () => q(db, sql)), /permission denied/, sql);
  }
});
