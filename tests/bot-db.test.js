// What the Discord bot can read from the database (supabase/007_bot.sql): the feed it posts,
// the player lookup behind /card, and that none of it is open to the site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, q, as, asBot, addUser, A, B, C } from './db-helpers.js';

const rejects = (promise, pattern) => assert.rejects(promise, pattern);
const DISCORD = { [A]: '100000000000000001', [B]: '100000000000000002', [C]: '100000000000000003' };

async function world() {
  const db = await freshDb();
  for (const [id, name] of [[A, 'alice'], [B, 'bob'], [C, 'carol']]) {
    await addUser(db, id, { name });
    await q(db, `insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', $2)`, [id, DISCORD[id]]);
  }
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice","msgCount":30000,"className":"Night Owl"}')`));
  await as(db, B, () => q(db, `select public.save_card('{"name":"bob"}')`));
  return db;
}
const feedKey = async (db) => (await q(db, 'select feed_key from public.bot_state'))[0].feed_key;
const claim = async (db, key, limit = 30) => asBot(db, () => q(db, `select public.bot_claim_feed($1, $2, '0 seconds') r`, [key, limit])).then((r) => r[0].r);
const propose = (db, from, to, { offerMint = false, requestMint = false, offer = [], message = null } = {}) =>
  as(db, from, () => q(db, 'select public.propose_trade($1, $2::uuid[], $3, $4::uuid[], $5, $6) id', [to, offer, offerMint, [], requestMint, message])).then((r) => r[0].id);
const accept = (db, uid, trade) => as(db, uid, () => q(db, 'select public.respond_trade($1, true) r', [trade])).then((r) => r[0].r);
const cardOf = async (db, uid) => (await q(db, 'select * from public.cards where creator_id = $1', [uid]))[0];

test('bot: the feed hands over new cards, versions and trades once, in order, never messages', async () => {
  const db = await world();
  const key = await feedKey(db);
  const aliceCard = (await cardOf(db, A)).id;
  assert.equal(await accept(db, B, await propose(db, A, B, { offerMint: true, message: 'secret note' })), 'accepted');
  await propose(db, A, B, { offerMint: true }); // still open: never posted
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice two"}')`));

  const first = await claim(db, key);
  assert.deepEqual(first.events.map((e) => e.kind), ['card', 'card', 'trade', 'version']);
  assert.deepEqual(first.events[2].to_other, [{ card_id: aliceCard, version: 1, edition: 'original', serial: 2 }]);
  assert.equal(first.players[A], 'alice');
  assert.equal(first.players[B], 'bob');
  assert.equal(first.cards[aliceCard].name, 'alice two', 'card names are current');
  assert.equal(first.versions[aliceCard + ':1'].name, 'alice', 'each version keeps its own data');
  assert.equal(first.versions[aliceCard + ':1'].msgCount, 30000);
  assert.ok(!JSON.stringify(first).includes('secret note'), 'trade messages stay private');

  assert.deepEqual((await claim(db, key)).events, [], 'nothing is handed over twice');
  await as(db, C, () => q(db, `select public.save_card('{"name":"carol"}')`));
  assert.deepEqual((await claim(db, key)).events.map((e) => e.actor), [C], 'and new things come next time');
});

test('bot: the feed starts at install time, pages through bursts, and skips hidden cards', async () => {
  const db = await world();
  const key = await feedKey(db);
  await q(db, 'update public.bot_state set feed_after = now()');
  assert.deepEqual((await claim(db, key)).events, [], 'history from before the bot was set up is not dumped into Discord');

  for (let i = 0; i < 3; i++) await accept(db, B, await propose(db, A, B, { offerMint: true }));
  const page = await claim(db, key, 2);
  assert.equal(page.events.length, 2);
  assert.equal((await claim(db, key, 2)).events.length, 1, 'the rest comes on the next run');

  // Alice's card is hidden by a moderator, then she saves a new version: nothing is posted.
  await q(db, 'update public.cards set hidden = true where creator_id = $1', [A]);
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice again"}')`));
  await as(db, C, () => q(db, `select public.save_card('{"name":"carol"}')`));
  const after = await claim(db, key);
  assert.deepEqual(after.events.map((e) => e.actor), [C]);
  assert.ok(!JSON.stringify(after).includes((await cardOf(db, A)).id), 'hidden cards never reach Discord');
});

test('bot: only the right key, and only the bot, can read the feed or the bot tables', async () => {
  const db = await world();
  await rejects(claim(db, 'wrong'), /Wrong feed key/);
  await rejects(claim(db, null), /Wrong feed key/);
  await rejects(as(db, A, () => q(db, `select public.bot_claim_feed('x')`)), /permission denied/);
  await rejects(as(db, A, () => q(db, `select public.bot_player('1')`)), /permission denied/);
  await rejects(as(db, null, () => q(db, `select public.bot_player('1')`)), /permission denied/);
  await rejects(as(db, A, () => q(db, 'select * from public.bot_state')), /permission denied/);
  await rejects(as(db, A, () => q(db, 'select * from public.bot_channels')), /permission denied/);
  await rejects(as(db, A, () => q(db, `select * from public._activity_events(null, null, null)`)), /permission denied/);
  // the bot itself can manage channels
  await asBot(db, () => q(db, `insert into public.bot_channels (guild_id, channel_id, webhook_id, webhook_token) values ('1', '2', '3', 't')`));
  assert.equal((await asBot(db, () => q(db, 'select count(*)::int n from public.bot_channels')))[0].n, 1);
});

test('bot: /card finds a player by Discord account, with counts and their collection', async () => {
  const db = await world();
  assert.equal(await accept(db, B, await propose(db, A, B, { offerMint: true })), 'accepted');
  assert.equal(await accept(db, B, await propose(db, A, B, { offerMint: true })), 'accepted');
  await q(db, `update public.cards set data = data || '{"portraitUrl":"data:image/png;base64,AAAA"}' where creator_id = $1`, [A]);

  const alice = (await asBot(db, () => q(db, 'select public.bot_player($1) r', [DISCORD[A]])))[0].r;
  assert.equal(alice.player.username, 'alice');
  assert.equal(alice.card.data.name, 'alice');
  assert.equal(alice.card.data.portraitUrl, null, 'pictures stored inside the card are not sent to Discord');
  assert.equal(alice.card.traded_out, 2);
  assert.equal(alice.card.owners, 1);
  assert.equal(alice.held, 1);

  const bob = (await asBot(db, () => q(db, 'select public.bot_player($1) r', [DISCORD[B]])))[0].r;
  assert.deepEqual(bob.items.map((i) => [i.name, i.edition, i.serial, i.own]),
    [['alice', 'original', 2, false], ['alice', 'copy', 1, false], ['bob', 'original', 1, true]], 'other people’s cards first, originals before copies');
  assert.equal(bob.collected, 1);

  const carol = (await asBot(db, () => q(db, 'select public.bot_player($1) r', [DISCORD[C]])))[0].r;
  assert.equal(carol.card, null, 'signed in but no card yet');
  assert.equal((await asBot(db, () => q(db, `select public.bot_player('999') r`)))[0].r, null, 'never signed in');

  await q(db, 'update public.cards set hidden = true where creator_id = $1', [A]);
  const hidden = (await asBot(db, () => q(db, 'select public.bot_player($1) r', [DISCORD[A]])))[0].r;
  assert.equal(hidden.card.hidden, true);
  assert.equal(hidden.card.data, null, 'a hidden card’s contents are not shown');
  const bobNow = (await asBot(db, () => q(db, 'select public.bot_player($1) r', [DISCORD[B]])))[0].r;
  assert.deepEqual(bobNow.items.map((i) => i.name), ['bob'], 'hidden cards leave collections too');
});

const IMG = (uid, name = 'card-v1-abc.webp') => 'https://xqinypchsnkoiezpvqyn.supabase.co/storage/v1/object/public/card-images/' + uid + '/' + name;
const setImage = (db, uid, version, url) => as(db, uid, () => q(db, 'select public.set_card_image($1, $2)', [version, url]));
const imageOf = async (db, uid, version) => (await q(db, `select v.image_url from public.card_versions v join public.cards c on c.id = v.card_id
  where c.creator_id = $1 and v.version = $2`, [uid, version]))[0].image_url;

test('card pictures: only your own card, only your own folder, never stale', async () => {
  const db = await world();
  await setImage(db, A, 1, IMG(A));
  assert.equal(await imageOf(db, A, 1), IMG(A));

  await rejects(setImage(db, A, 1, IMG(B)), /isn't allowed/, 'not someone else’s folder');
  await rejects(setImage(db, A, 1, 'https://evil.example/card.webp'), /isn't allowed/);
  await rejects(setImage(db, A, 1, IMG(A, '../x.webp').replace('/x.webp', '/x.svg')), /isn't allowed/);
  await rejects(setImage(db, A, 7, IMG(A)), /doesn't exist/);
  await rejects(setImage(db, C, 1, IMG(C)), /Make your card first/);
  await rejects(as(db, null, () => q(db, 'select public.set_card_image(1, null)')), /permission denied/);
  await rejects(as(db, A, () => q(db, `update public.card_versions set image_url = 'x'`)), /permission denied/);

  // editing an untraded card clears its picture
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice edited"}')`));
  assert.equal(await imageOf(db, A, 1), null, 'an edit makes the old picture wrong');

  // a traded version keeps its picture when the next version starts
  await setImage(db, A, 1, IMG(A));
  await accept(db, B, await propose(db, A, B, { offerMint: true }));
  await as(db, A, () => q(db, `select public.save_card('{"name":"alice v2"}')`));
  assert.equal(await imageOf(db, A, 1), IMG(A));
  assert.equal(await imageOf(db, A, 2), null);

  // a moderator removing the portrait clears the picture too
  await q(db, `update public.card_versions set data = data || '{"portraitUrl":"https://x.supabase.co/storage/v1/object/public/portraits/a/p.webp"}'
    where version = 2 and card_id = (select id from public.cards where creator_id = $1)`, [A]);
  await setImage(db, A, 2, IMG(A, 'card-v2-def.webp'));
  await q(db, 'update public.profiles set is_admin = true where id = $1', [C]);
  const aliceId = (await cardOf(db, A)).id;
  await as(db, C, () => q(db, 'select public.admin_remove_portrait($1)', [aliceId]));
  assert.equal(await imageOf(db, A, 2), null);
  assert.ok((await q(db, `select 1 from storage.buckets where id = 'card-images' and public`)).length, 'the bucket exists');
});

test('card pictures: the bot shows them in /card and the feed, but not for hidden cards', async () => {
  const db = await world();
  const key = await feedKey(db);
  await setImage(db, A, 1, IMG(A));
  const alice = (await asBot(db, () => q(db, 'select public.bot_player($1) r', [DISCORD[A]])))[0].r;
  assert.equal(alice.card.image_url, IMG(A));
  const feed = await claim(db, key);
  const aliceCard = (await cardOf(db, A)).id;
  assert.equal(feed.versions[aliceCard + ':1'].imageUrl, IMG(A));

  await q(db, 'update public.cards set hidden = true where creator_id = $1', [A]);
  const hidden = (await asBot(db, () => q(db, 'select public.bot_player($1) r', [DISCORD[A]])))[0].r;
  assert.equal(hidden.card.image_url, null);
});
