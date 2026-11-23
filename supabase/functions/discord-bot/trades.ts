// @ts-nocheck
// Trading in Discord.
//   /trade @player   a private menu to pick what you give and what you want, add a note, and send.
//                    The other player gets pinged in the channel with a "View offer" button that
//                    only works for them (the offer itself is never shown to anyone else).
//   /trades          your offers still waiting for an answer.
//   Offer buttons:   Accept, Decline, Counter (for the person it was sent to), Cancel (for the sender).
// The trade rules live in the database (supabase/010_bot_trades.sql calls the site's own trade
// functions), so a trade made here is checked exactly like one made on the site.

import { SITE, cut, text, editionLabel, TRADE_COLOR, notSignedIn, otherNotSignedIn } from './bot.ts';

const MAX_OPTIONS = 25; // Discord's limit per menu
const MAX_PER_SIDE = 20; // the site's limit per side of a trade
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const userId = (i) => ((i.member && i.member.user) || i.user || {}).id;
const row = (...components) => ({ type: 1, components });
const button = (label, custom_id, style = 2, disabled = false) => ({ type: 2, style, label, custom_id, disabled });
const linkTo = (label, url) => ({ type: 2, style: 5, label, url });
const closed = (content) => ({ content, embeds: [], components: [] });

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// One side of a trade as text. `next` shows which edition a new copy would be (only while open).
function side(items, mint, whose, next = true) {
  const lines = [];
  if (mint) lines.push('✦ A new edition of ' + whose + (next && mint.next ? ' (' + mint.next + ')' : ''));
  for (const it of items) lines.push('**' + text(it.name || 'player', 40) + '** · ' + editionLabel(it));
  return lines.length ? cut(lines.join('\n'), 1024) : '*Nothing*';
}

function menu(customId, placeholder, mint, mintLabel, items, chosenMint, chosenItems) {
  const options = [];
  if (mint) options.push({ label: cut(mintLabel + ' · ' + mint.next, 100), value: 'mint', default: !!chosenMint });
  for (const it of items) {
    options.push({
      label: cut((it.name || 'player') + ' · ' + editionLabel(it), 100),
      description: cut('Made by ' + (it.maker || 'someone'), 100),
      value: it.id,
      default: chosenItems.includes(it.id),
    });
  }
  const shown = options.slice(0, MAX_OPTIONS);
  return {
    hidden: options.length - shown.length,
    select: shown.length ? {
      type: 3, custom_id: customId, placeholder, min_values: 0,
      max_values: Math.min(shown.length, MAX_PER_SIDE), options: shown,
    } : null,
  };
}

// ---------------------------------------------------------------- building an offer

// d: the draft (bot_trade_drafts row); o: bot_trade_options for the two players.
export function builderMessage(d, o, notice) {
  const them = o.them.username;
  const mine = new Map(o.mine.map((it) => [it.id, it]));
  const theirs = new Map(o.theirs.map((it) => [it.id, it]));
  const give = d.offer_items.map((id) => mine.get(id)).filter(Boolean);
  const want = d.request_items.map((id) => theirs.get(id)).filter(Boolean);
  const giveMint = d.offer_mint ? o.my_mint : null;
  const wantMint = d.request_mint ? o.their_mint : null;
  const empty = !give.length && !want.length && !giveMint && !wantMint;

  const giveMenu = menu('td:' + d.id + ':give', 'Cards you give', o.my_mint, 'New edition of your card', o.mine, d.offer_mint, d.offer_items);
  const wantMenu = menu('td:' + d.id + ':want', 'Cards you want from ' + cut(them, 60), o.their_mint, 'New edition of ' + cut(them, 40) + '’s card', o.theirs, d.request_mint, d.request_items);
  const hints = [];
  if (!giveMenu.select) hints.push(o.my_mint === null
    ? 'You haven’t made your card yet, so you have nothing to give. You can still ask for theirs, or make your card on the site first.'
    : 'You have nothing to give yet.');
  if (!wantMenu.select) hints.push('**' + text(them, 40) + '** has nothing to trade yet.');
  if (giveMenu.hidden || wantMenu.hidden) hints.push('Some cards didn’t fit in the menus (25 at most). Use the site for those.');

  const rows = [];
  if (giveMenu.select) rows.push(row(giveMenu.select));
  if (wantMenu.select) rows.push(row(wantMenu.select));
  rows.push(row(
    button(d.counter_of ? 'Send counter-offer' : 'Send offer', 'td:' + d.id + ':send', 1, empty),
    button(d.message ? 'Edit note' : 'Add note', 'td:' + d.id + ':note'),
    button('Cancel', 'td:' + d.id + ':cancel', 4),
    ...(o.my_mint === null ? [linkTo('Make your card', SITE + '#card')] : [])));

  return {
    content: notice ? '⚠️ ' + cut(notice, 300) : '',
    embeds: [{
      title: (d.counter_of ? 'Counter-offer to ' : 'Trade with ') + cut(them, 80),
      color: TRADE_COLOR,
      description: hints.join('\n') || undefined,
      fields: [
        { name: 'You give', value: side(give, giveMint, 'your card') },
        { name: cut(them, 200) + ' gives', value: side(want, wantMint, text(them, 40) + '’s card') },
        d.message ? { name: 'Note', value: text(d.message, 300) } : null,
      ].filter(Boolean),
      footer: { text: 'Only you can see this until you send it.' },
    }],
    components: rows,
    allowed_mentions: { parse: [] },
  };
}

export function noteModal(draftId) {
  return {
    type: 9,
    data: {
      custom_id: 'tdn:' + draftId,
      title: 'Note with your offer',
      components: [row({ type: 4, custom_id: 'note', style: 2, label: 'Note (optional, only they see it)', max_length: 280, required: false })],
    },
  };
}

// The text someone typed in the note form.
function noteFrom(i) {
  const find = (list) => {
    for (const c of list || []) {
      if (c.custom_id === 'note') return c.value;
      const inner = find(c.components || (c.component ? [c.component] : []));
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return String(find(i.data && i.data.components) || '').trim().slice(0, 280);
}

// ---------------------------------------------------------------- looking at an offer

const STATUS = {
  accepted: 'This offer was accepted.',
  declined: 'This offer was declined.',
  cancelled: 'This offer was cancelled.',
  countered: 'This offer was answered with a counter-offer.',
  failed: 'This offer couldn’t go through: one of the cards changed hands.',
};

// v: bot_trade_view (null when the viewer isn't in the trade).
export function viewMessage(v, notice) {
  if (!v) return closed('That offer isn’t yours to see.');
  const sender = v.viewer === 'from';
  const open = v.status === 'pending';
  const from = v.from.username;
  const to = v.to.username;
  const fields = [
    { name: sender ? 'You give' : cut(from, 200) + ' gives', value: side(v.offer_items, v.offer_mint, sender ? 'your card' : text(from, 40) + '’s card', open) },
    { name: sender ? cut(to, 200) + ' gives' : 'You give', value: side(v.request_items, v.request_mint, sender ? text(to, 40) + '’s card' : 'your card', open) },
    v.message ? { name: 'Note', value: text(v.message, 300) } : null,
  ].filter(Boolean);
  const buttons = [];
  if (open && !sender) buttons.push(button('Accept', 'ta:' + v.id, 3), button('Decline', 'tx:' + v.id, 4), button('Counter', 'tc:' + v.id, 2));
  if (open && sender) buttons.push(button('Cancel offer', 'tk:' + v.id, 4));
  buttons.push(linkTo('Open on site', SITE + '#trades'));
  return {
    content: notice ? cut(notice, 300) : '',
    embeds: [{
      title: (sender ? 'Your offer to ' + cut(to, 80) : (v.counter_of ? 'Counter-offer from ' : 'Trade offer from ') + cut(from, 80)),
      color: TRADE_COLOR,
      description: open ? 'Sent ' + ago(v.created_at) : STATUS[v.status] || 'This offer is ' + v.status + '.',
      fields,
    }],
    components: [row(...buttons)],
    allowed_mentions: { parse: [] },
  };
}

// list: bot_open_trades.
export function listMessage(list) {
  if (!list.length) return closed('You have no open trade offers. Start one with `/trade`.');
  const line = (t) => '• ' + (t.incoming ? 'From **' + text(t.other, 40) + '**' : 'To **' + text(t.other, 40) + '**')
    + ' · ' + t.gives + ' for ' + t.gets + ' · ' + ago(t.created_at);
  const incoming = list.filter((t) => t.incoming);
  const outgoing = list.filter((t) => !t.incoming);
  return {
    content: '',
    embeds: [{
      title: 'Your open trades',
      color: TRADE_COLOR,
      fields: [
        incoming.length ? { name: 'Waiting for you', value: cut(incoming.map(line).join('\n'), 1024) } : null,
        outgoing.length ? { name: 'Waiting for them', value: cut(outgoing.map(line).join('\n'), 1024) } : null,
      ].filter(Boolean),
    }],
    components: [row({
      type: 3, custom_id: 'tl', placeholder: 'Open an offer',
      options: list.slice(0, MAX_OPTIONS).map((t) => ({
        label: cut((t.incoming ? 'From ' : 'To ') + t.other + ' · ' + t.gives + ' for ' + t.gets, 100),
        description: ago(t.created_at),
        value: t.id,
      })),
    })],
    allowed_mentions: { parse: [] },
  };
}

// ---------------------------------------------------------------- channel pings

export function offerPing(toDiscord, fromName, tradeId, counter) {
  return {
    content: '<@' + toDiscord + '>, **' + text(fromName, 60) + '** sent you a ' + (counter ? 'counter-offer' : 'trade offer') + '. Only you can open it.',
    components: [row(button('View offer', 'tv:' + tradeId, 1))],
    allowed_mentions: { users: [String(toDiscord)] },
  };
}

export function acceptedPing(v) {
  return {
    content: '<@' + v.from.discord + '>, **' + text(v.to.username, 60) + '** accepted your trade offer. Your new cards are in your collection.',
    allowed_mentions: { users: [String(v.from.discord)] },
  };
}

// ---------------------------------------------------------------- handling commands and buttons

// deps: rpc(name, args), createDraft(row) → row, getDraft(id) → row | null, updateDraft(id, patch) → row, deleteDraft(id)

export async function tradeCommand(i, deps) {
  const me = userId(i);
  const d = i.data || {};
  if (!i.guild_id) return { content: 'Use this in a server channel.' };
  if (d.name === 'trades') {
    const [player, list] = await Promise.all([
      deps.rpc('bot_player', { p_discord_id: me }),
      deps.rpc('bot_open_trades', { p_discord_id: me }),
    ]);
    return player ? listMessage(list || []) : notSignedIn();
  }

  const target = String(((d.options || []).find((o) => o.name === 'player') || {}).value || '');
  if (!target) return { content: 'Pick who to trade with.' };
  let o;
  try {
    o = await deps.rpc('bot_trade_options', { p_discord_id: me, p_to_discord_id: target });
  } catch (e) {
    if (/Sign in on the Player Cards site/.test(e.message)) return notSignedIn();
    if (/isn't on Player Cards yet/.test(e.message)) {
      const u = (d.resolved && d.resolved.users && d.resolved.users[target]) || {};
      return otherNotSignedIn(u.global_name || u.username || 'That player');
    }
    return { content: e.message };
  }
  const draft = await deps.createDraft({ discord_id: me, to_discord_id: target, to_user: o.them.id });
  return builderMessage(draft, o);
}

// Buttons, menus and the note form. Returns { response } to send straight back to Discord, and
// later(), which does the slow part and returns { edit, followup }: edit replaces the message
// the button was on (or the "thinking" message), followup is a new message in the channel.
export function componentReply(i, deps) {
  const me = userId(i);
  const [kind, ref, part] = String((i.data && i.data.custom_id) || '').split(':');
  if (kind === 'td' && part === 'note') return { response: noteModal(ref) };
  if (kind === 'tv') return { response: { type: 5, data: { flags: 64 } }, later: () => showTrade(me, ref, deps) };
  return {
    response: { type: 6 },
    later: async () => {
      try {
        if (kind === 'td') return await draftAction(i, me, ref, part, deps);
        if (kind === 'tdn') return await draftAction(i, me, ref, 'note', deps);
        if (kind === 'tl') return await showTrade(me, (i.data.values || [])[0], deps);
        if (kind === 'tc') return await startCounter(me, ref, deps);
        const action = { ta: 'accept', tx: 'decline', tk: 'cancel' }[kind];
        if (action) return await answer(me, ref, action, deps);
        return { edit: closed('That button doesn’t do anything anymore.') };
      } catch (e) {
        return { edit: { content: '⚠️ ' + cut(e.message || String(e), 300) } };
      }
    },
  };
}

async function showTrade(me, tradeId, deps) {
  if (!UUID.test(tradeId || '')) return { edit: closed('That offer doesn’t exist.') };
  return { edit: viewMessage(await deps.rpc('bot_trade_view', { p_discord_id: me, p_trade: tradeId })) };
}

const optionsFor = (d, deps) => deps.rpc('bot_trade_options', { p_discord_id: d.discord_id, p_to_discord_id: d.to_discord_id });

async function draftAction(i, me, draftId, part, deps) {
  const d = UUID.test(draftId || '') ? await deps.getDraft(draftId) : null;
  if (!d || d.discord_id !== me) return { edit: closed('This offer was already sent or cancelled.') };

  if (part === 'cancel') {
    await deps.deleteDraft(d.id);
    return { edit: closed('Trade cancelled. Nothing was sent.') };
  }
  if (part === 'send') {
    let sent;
    try {
      sent = await deps.rpc('bot_trade', { p_discord_id: me, p_action: 'send', p_draft: d.id });
    } catch (e) {
      return { edit: builderMessage(d, await optionsFor(d, deps), e.message) };
    }
    const v = await deps.rpc('bot_trade_view', { p_discord_id: me, p_trade: sent.trade_id });
    return {
      edit: closed((sent.counter ? 'Counter-offer' : 'Offer') + ' sent to **' + text(v.to.username, 60) + '**. They can open it from the ping, or with `/trades`.'),
      followup: offerPing(d.to_discord_id, v.from.username, sent.trade_id, sent.counter),
    };
  }

  let patch = null;
  const values = (i.data && i.data.values) || [];
  if (part === 'give') patch = { offer_mint: values.includes('mint'), offer_items: values.filter((x) => x !== 'mint') };
  if (part === 'want') patch = { request_mint: values.includes('mint'), request_items: values.filter((x) => x !== 'mint') };
  if (part === 'note') patch = { message: noteFrom(i) || null };
  const next = patch ? await deps.updateDraft(d.id, patch) : d;
  return { edit: builderMessage(next, await optionsFor(next, deps)) };
}

async function answer(me, tradeId, action, deps) {
  let result = null;
  let problem = null;
  try {
    result = (await deps.rpc('bot_trade', { p_discord_id: me, p_action: action, p_trade: tradeId })).result;
  } catch (e) {
    problem = e.message;
  }
  const v = await deps.rpc('bot_trade_view', { p_discord_id: me, p_trade: tradeId });
  const said = {
    accepted: '✅ Trade done! Your new cards are in your collection.',
    failed: '⚠️ That trade can’t go through anymore: one of the cards changed hands.',
    declined: 'Offer declined.',
    cancelled: 'Offer cancelled.',
  }[result];
  const out = { edit: viewMessage(v, problem ? '⚠️ ' + problem : said) };
  if (result === 'accepted' && v && v.from.discord) out.followup = acceptedPing(v);
  return out;
}

async function startCounter(me, tradeId, deps) {
  const v = UUID.test(tradeId || '') ? await deps.rpc('bot_trade_view', { p_discord_id: me, p_trade: tradeId }) : null;
  if (!v || v.viewer !== 'to' || v.status !== 'pending' || !v.from.discord) {
    return { edit: viewMessage(v, '⚠️ You can only counter an open offer that was sent to you.') };
  }
  const o = await deps.rpc('bot_trade_options', { p_discord_id: me, p_to_discord_id: v.from.discord });
  const mine = new Set(o.mine.map((it) => it.id));
  const theirs = new Set(o.theirs.map((it) => it.id));
  // Starts from their offer turned around; change anything before sending.
  const d = await deps.createDraft({
    discord_id: me, to_discord_id: v.from.discord, to_user: v.from.id, counter_of: v.id,
    offer_items: v.request_items.map((it) => it.id).filter((id) => mine.has(id)),
    offer_mint: !!v.request_mint && !!o.my_mint,
    request_items: v.offer_items.map((it) => it.id).filter((id) => theirs.has(id)),
    request_mint: !!v.offer_mint && !!o.their_mint,
  });
  return { edit: builderMessage(d, o) };
}
