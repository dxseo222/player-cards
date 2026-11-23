// Database rules: runs every supabase/*.sql migration in order on a fake Supabase and checks
// the trading, version, moderation, naming, counter-offer and wishlist rules from the outside.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, readMigration, q, as, addUser, A, B, C } from './db-helpers.js';

const rejects = (promise, pattern) => assert.rejects(promise, pattern);

async function twoPlayersWithCards() {
  const db = await freshDb();
  await addUser(db, A, { name: 'alice' });
  await addUser(db, B, { name: 'bob' });
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice v1"}')`));
  await as(db, B, () => q(db, `select public.save_card('{"name":"bob v1"}')`));
  return db;
}
const cardOf = async (db, uid) => (await q(db, 'select * from public.cards where creator_id = $1', [uid]))[0];
const propose = (db, from, to, { offerMint = false, requestMint = false, offer = [], request = [] } = {}) =>
  as(db, from, () => q(db, 'select public.propose_trade($1, $2::uuid[], $3, $4::uuid[], $5, null) id', [to, offer, offerMint, request, requestMint])).then((r) => r[0].id);
const accept = (db, uid, trade) => as(db, uid, () => q(db, 'select public.respond_trade($1, true) r', [trade])).then((r) => r[0].r);

test('all migrations apply in order and can be re-run', async () => {
  const db = await freshDb();
  for (const m of ['003_versions_moderation.sql', '004_profile_names.sql', '005_counters_wishlist.sql', '006_activity.sql', '007_bot.sql', '009_card_images.sql', '010_bot_trades.sql']) await db.exec(readMigration(m));
});

test('making a card gives the creator Original 1/2', async () => {
  const db = await twoPlayersWithCards();
  const items = await q(db, `select edition, serial from public.items where owner_id = $1`, [A]);
  assert.deepEqual(items, [{ edition: 'original', serial: 1 }]);
});

test('first trade of a card hands out Original 2/2, then numbered copies', async () => {
  const db = await twoPlayersWithCards();
  for (let i = 0; i < 3; i++) assert.equal(await accept(db, B, await propose(db, A, B, { offerMint: true })), 'accepted');
  const got = await q(db, `select i.edition, i.serial from public.items i join public.cards c on c.id = i.card_id
    where c.creator_id = $1 and i.owner_id = $2 order by i.edition desc, i.serial`, [A, B]);
  assert.deepEqual(got.map((x) => x.edition + ' ' + x.serial), ['original 2', 'copy 1', 'copy 2']);
});

test('Original 1/2 can never be traded', async () => {
  const db = await twoPlayersWithCards();
  const mine = (await q(db, `select array_agg(id) ids from public.items where owner_id = $1`, [A]))[0].ids;
  await rejects(propose(db, A, B, { offer: mine }), /not available/);
});

test('an offer fails cleanly if a card changed hands before it was accepted', async () => {
  const db = await twoPlayersWithCards();
  await addUser(db, C, { name: 'carol' });
  await accept(db, B, await propose(db, A, B, { offerMint: true }));
  const bobsCopy = (await q(db, `select i.id from public.items i join public.cards c on c.id = i.card_id where c.creator_id = $1 and i.owner_id = $2`, [A, B]))[0].id;
  const toAlice = await propose(db, B, A, { offer: [bobsCopy] });
  const toCarol = await propose(db, B, C, { offer: [bobsCopy] });
  assert.equal(await accept(db, C, toCarol), 'accepted');
  assert.equal(await accept(db, A, toAlice), 'failed');
});

test('saving after a trade freezes the old version and starts a new one', async () => {
  const db = await twoPlayersWithCards();
  await accept(db, B, await propose(db, A, B, { offerMint: true }));
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice v2"}')`));
  const card = await cardOf(db, A);
  assert.equal(card.current_version, 2);
  const v1 = await q(db, `select data->>'name' n from public.card_versions where card_id = $1 and version = 1`, [card.id]);
  assert.equal(v1[0].n, 'alice v1', 'the traded version keeps its old look');
  const originals = await q(db, `select v.version from public.items i join public.card_versions v on v.id = i.version_id
    where i.owner_id = $1 and i.edition = 'original' and i.serial = 1 order by v.version`, [A]);
  assert.deepEqual(originals.map((x) => x.version), [1, 2], 'the creator keeps Original 1/2 of every version');

  await as(db, A, () => q(db, `select public.save_card('{"name":"alice v2 typo fix"}')`));
  assert.equal((await cardOf(db, A)).current_version, 2, 'untraded versions are edited in place');
  await accept(db, B, await propose(db, A, B, { offerMint: true }));
  const v2 = await q(db, `select i.edition, i.serial from public.items i join public.card_versions v on v.id = i.version_id
    where v.card_id = $1 and v.version = 2 and i.owner_id = $2`, [card.id, B]);
  assert.deepEqual(v2, [{ edition: 'original', serial: 2 }], 'the new version has its own Original 2/2');
});

test('players cannot write tables directly or make themselves admin', async () => {
  const db = await twoPlayersWithCards();
  await as(db, B, async () => {
    await rejects(q(db, `update public.items set owner_id = $1`, [B]), /permission denied/);
    await rejects(q(db, `insert into public.card_versions (card_id, version, data) select id, 9, '{}' from public.cards limit 1`), /permission denied/);
    await rejects(q(db, `update public.profiles set is_admin = true`), /permission denied/);
    await rejects(q(db, `select public.admin_set_hidden((select id from public.cards limit 1), true)`), /Only moderators/);
  });
});

test('moderators can read reports and hide cards; hidden cards cannot be minted', async () => {
  const db = await twoPlayersWithCards();
  const bobCard = (await cardOf(db, B)).id;
  await as(db, A, () => q(db, 'select public.report_card($1, $2)', [bobCard, 'test']));
  await as(db, A, () => q(db, 'select public.report_card($1, $2)', [bobCard, 'again']));
  assert.equal((await q(db, `select count(*)::int n from public.reports`))[0].n, 1, 'one open report per player per card');
  assert.equal((await as(db, B, () => q(db, 'select count(*)::int n from public.reports')))[0].n, 0, 'players cannot read reports');

  await q(db, 'update public.profiles set is_admin = true where id = $1', [A]);
  await as(db, A, () => q(db, 'select public.admin_set_hidden($1, true)', [bobCard]));
  await rejects(propose(db, A, B, { requestMint: true }), /no card to trade/);
  assert.equal((await as(db, null, () => q(db, 'select count(*)::int n from public.cards')))[0].n, 1, 'signed-out visitors only see visible cards');
});

test('signed-out visitors cannot list players, trades or wishlists', async () => {
  const db = await twoPlayersWithCards();
  await as(db, null, async () => {
    await rejects(q(db, 'select * from public.profiles'), /permission denied/);
    await rejects(q(db, 'select * from public.trades'), /permission denied/);
    await rejects(q(db, 'select * from public.wishlist'), /permission denied/);
  });
});

test('blank or invisible display names fall back to the Discord username', async () => {
  const db = await freshDb();
  await addUser(db, A, { custom_claims: { global_name: 'ㅤ' }, full_name: 'ㅤ', name: 'realname' });
  await addUser(db, B, { custom_claims: { global_name: '  ' } });
  const names = await q(db, 'select username from public.profiles order by id');
  assert.deepEqual(names.map((x) => x.username), ['realname', 'player']);
});

test('counter-offers close the original and send a linked offer back', async () => {
  const db = await twoPlayersWithCards();
  const t1 = await propose(db, A, B, { offerMint: true });
  await rejects(as(db, A, () => q(db, `select public.counter_trade($1, '{}', true, '{}', true, null)`, [t1])), /Trade not found/);
  const t2 = (await as(db, B, () => q(db, `select public.counter_trade($1, '{}', true, '{}', true, null) id`, [t1])))[0].id;
  const [orig] = await q(db, 'select status from public.trades where id = $1', [t1]);
  const [counter] = await q(db, 'select from_user, to_user, counter_of, status from public.trades where id = $1', [t2]);
  assert.equal(orig.status, 'countered');
  assert.deepEqual(counter, { from_user: B, to_user: A, counter_of: t1, status: 'pending' });
  await rejects(as(db, B, () => q(db, `select public.counter_trade($1, '{}', true, '{}', false, null)`, [t1])), /already countered/);
  assert.equal(await accept(db, A, t2), 'accepted');
});

test('wishlists: only your own wishes, never your own card', async () => {
  const db = await twoPlayersWithCards();
  const aliceCard = (await cardOf(db, A)).id;
  const bobCard = (await cardOf(db, B)).id;
  await as(db, B, () => q(db, 'insert into public.wishlist (user_id, card_id) values ($1, $2)', [B, aliceCard]));
  await rejects(as(db, B, () => q(db, 'insert into public.wishlist (user_id, card_id) values ($1, $2)', [B, bobCard])), /row-level security/);
  await rejects(as(db, B, () => q(db, 'insert into public.wishlist (user_id, card_id) values ($1, $2)', [A, bobCard])), /row-level security/);
  await as(db, A, () => q(db, 'delete from public.wishlist where user_id = $1', [B]));
  assert.equal((await q(db, 'select count(*)::int n from public.wishlist'))[0].n, 1, 'others cannot delete your wishes');
});

const feed = (db, uid, before = null, player = null) =>
  as(db, uid, () => q(db, 'select * from public.activity_feed($1, 40, $2)', [before, player]));

test('activity feed: new cards, versions and what moved in trades, never messages', async () => {
  const db = await twoPlayersWithCards();
  await addUser(db, C, { name: 'carol' });
  const aliceCard = (await cardOf(db, A)).id;
  const bobCard = (await cardOf(db, B)).id;
  // Alice gives Bob Original 2/2 of her card and gets Original 2/2 of Bob's, with a message.
  const t1 = await as(db, A, () => q(db, `select public.propose_trade($1, '{}', true, '{}', true, 'secret note') id`, [B])).then((r) => r[0].id);
  assert.equal(await accept(db, B, t1), 'accepted');
  await accept(db, B, await propose(db, A, B, { offerMint: true }));
  await propose(db, A, B, { offerMint: true }); // still pending: must not show
  const declined = await propose(db, A, B, { offerMint: true });
  await as(db, B, () => q(db, 'select public.respond_trade($1, false)', [declined]));
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice v2"}')`));

  const rows = await feed(db, C);
  assert.deepEqual(rows.map((r) => r.kind), ['version', 'trade', 'trade', 'card', 'card']);
  assert.equal(rows[0].actor, A);
  assert.equal(rows[0].version, 2);
  const [second, first] = [rows[1], rows[2]];
  assert.deepEqual(first.to_other, [{ card_id: aliceCard, version: 1, edition: 'original', serial: 2 }], 'Bob got Original 2/2 of Alice’s card');
  assert.deepEqual(first.to_actor, [{ card_id: bobCard, version: 1, edition: 'original', serial: 2 }], 'Alice got Original 2/2 of Bob’s card');
  assert.deepEqual(second.to_other, [{ card_id: aliceCard, version: 1, edition: 'copy', serial: 1 }]);
  assert.deepEqual(second.to_actor, []);
  assert.ok(!JSON.stringify(rows).includes('secret note'), 'trade messages stay private');

  // a traded-on item shows up too, by its own edition
  const bobsCopy = (await q(db, `select id from public.items where card_id = $1 and owner_id = $2 and edition = 'copy'`, [aliceCard, B]))[0].id;
  await accept(db, C, await propose(db, B, C, { offer: [bobsCopy] }));
  const [latest] = await feed(db, A);
  assert.equal(latest.actor, B);
  assert.equal(latest.other, C);
  assert.deepEqual(latest.to_other, [{ card_id: aliceCard, version: 1, edition: 'copy', serial: 1 }]);
});

test('activity feed: paging, one player, hidden cards and signed-out visitors', async () => {
  const db = await twoPlayersWithCards();
  await addUser(db, C, { name: 'carol' });
  await as(db, C, () => q(db, `select public.save_card('{"name":"carol"}')`));
  await accept(db, B, await propose(db, A, B, { offerMint: true }));
  const all = await feed(db, A);
  assert.equal(all.length, 4);
  const older = await feed(db, A, all[1].happened_at);
  assert.deepEqual(older.map((r) => r.happened_at), all.slice(2).map((r) => r.happened_at), 'Load more continues where the page ended');
  assert.deepEqual((await feed(db, A, null, C)).map((r) => r.kind), ['card'], 'a player’s profile only shows their events');

  await q(db, 'update public.cards set hidden = true where creator_id = $1', [A]);
  const after = await feed(db, B);
  assert.ok(after.every((r) => r.actor !== A || r.kind === 'trade'), 'hidden cards’ own events are gone');
  assert.ok(!after.some((r) => r.kind === 'trade'), 'a trade with only hidden cards in it disappears');

  await rejects(feed(db, null), /permission denied/, 'signed-out visitors cannot read the feed');
  await rejects(as(db, B, () => q(db, `select public._moved_items('{}', false, $1, now())`, [A])), /permission denied/);
});
