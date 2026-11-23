// @ts-nocheck
// Player Cards Discord bot, running as a Supabase Edge Function (no server to keep on).
//
// Two kinds of requests arrive here:
//   * Discord, when someone uses a command (checked with the app's public key).
//   * The database, once a minute (008_bot_schedule.sql), with the feed key: post what's new.
//
// Secrets (Supabase → Edge Functions → Secrets): DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN.
// SUPABASE_URL and the service key are provided by Supabase automatically.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { SITE, verifyDiscord, commandReply, isEphemeral, runFeed } from './bot.ts';
import { tradeCommand, componentReply } from './trades.ts';

const env = (k) => Deno.env.get(k) || '';
const API = 'https://discord.com/api/v10';
const APP_ID = env('DISCORD_APP_ID');
const BOT_TOKEN = env('DISCORD_BOT_TOKEN');
const PUBLIC_KEY = env('DISCORD_PUBLIC_KEY');
const USER_AGENT = 'DiscordBot (' + SITE + ', 1)';

// Newer projects hand functions their secret keys as JSON; older ones as the service role key.
function serviceKey() {
  try {
    const keys = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    const key = keys.default || Object.values(keys)[0];
    if (key) return key;
  } catch { /* fall back */ }
  return env('SUPABASE_SERVICE_ROLE_KEY');
}
const sb = createClient(env('SUPABASE_URL'), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

// One Discord API call, waiting once if Discord asks us to slow down.
async function call(url, method, body, auth) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...(auth ? { Authorization: 'Bot ' + BOT_TOKEN } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 429 && attempt === 0) {
      await sleep(Math.min(5, Number(data && data.retry_after) || 1) * 1000);
      continue;
    }
    return { ok: res.ok, status: res.status, body: data };
  }
}

const deps = {
  appId: APP_ID && BOT_TOKEN ? APP_ID : '',
  rpc,
  discord: (method, path, body) => call(API + path, method, body, true),
  async channels() {
    const { data, error } = await sb.from('bot_channels').select('guild_id, channel_id, webhook_id, webhook_token');
    if (error) throw new Error(error.message);
    return data;
  },
  async postWebhook(ch, message) {
    const r = await call(API + '/webhooks/' + ch.webhook_id + '/' + ch.webhook_token, 'POST', message, false);
    if (r.status === 404 || r.status === 401) return 'gone';
    if (!r.ok) console.error('Posting to', ch.guild_id, 'failed', r.status, JSON.stringify(r.body));
    return 'ok';
  },
  async setChannel(row) {
    const { data: old } = await sb.from('bot_channels').select('*').eq('guild_id', row.guild_id).maybeSingle();
    const { error } = await sb.from('bot_channels').upsert(row);
    if (error) throw new Error(error.message);
    return old;
  },
  async removeChannel(guildId) {
    const { data, error } = await sb.from('bot_channels').delete().eq('guild_id', guildId).select();
    if (error) throw new Error(error.message);
    return (data || [])[0] || null;
  },
  // offers being put together with /trade (unfinished ones are cleared after a day)
  async createDraft(row) {
    await sb.from('bot_trade_drafts').delete().lt('created_at', new Date(Date.now() - 86400000).toISOString());
    const { data, error } = await sb.from('bot_trade_drafts').insert(row).select().single();
    if (error) throw new Error(error.message);
    return data;
  },
  async getDraft(id) {
    const { data, error } = await sb.from('bot_trade_drafts').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
  async updateDraft(id, patch) {
    const { data, error } = await sb.from('bot_trade_drafts').update(patch).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },
  async deleteDraft(id) {
    const { error } = await sb.from('bot_trade_drafts').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },
  async setCommandsVersion(v) {
    const { error } = await sb.from('bot_state').update({ commands_version: v }).eq('id', true);
    if (error) throw new Error(error.message);
  },
};

// After a button: replace the message it was on (edit), then maybe post in the channel (followup).
async function followThrough(i, slow) {
  let out;
  try {
    out = await slow();
  } catch (e) {
    console.error('Button failed:', e.message);
    out = { edit: { content: 'Something went wrong. Try again in a minute.' } };
  }
  const hook = API + '/webhooks/' + i.application_id + '/' + i.token;
  if (out.edit) {
    const r = await call(hook + '/messages/@original', 'PATCH', { allowed_mentions: { parse: [] }, ...out.edit }, false);
    if (!r.ok) console.error('Edit failed', r.status, JSON.stringify(r.body));
  }
  if (out.followup) {
    const r = await call(hook, 'POST', out.followup, false);
    if (!r.ok) console.error('Channel message failed', r.status, JSON.stringify(r.body));
  }
}

// Keeps working after the reply has gone back to Discord.
const later = (promise) => (typeof EdgeRuntime !== 'undefined' ? EdgeRuntime.waitUntil(promise) : promise);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Player Cards bot', { status: 200 });

  const feedKey = req.headers.get('x-feed-key');
  if (feedKey) {
    try {
      return json(await runFeed(feedKey, deps));
    } catch (e) {
      console.error('Feed run failed:', e.message);
      return json({ error: e.message }, /feed key/i.test(e.message) ? 401 : 500);
    }
  }

  const body = await req.text();
  const ok = await verifyDiscord(PUBLIC_KEY, req.headers.get('x-signature-ed25519'), req.headers.get('x-signature-timestamp'), body);
  if (!ok) return new Response('Bad signature', { status: 401 });

  const i = JSON.parse(body);
  if (i.type === 1) return json({ type: 1 }); // Discord checking the endpoint

  // Buttons, menus (3) and forms (5): answer right away, then do the slow part.
  if (i.type === 3 || i.type === 5) {
    const { response, later: slow } = componentReply(i, deps);
    if (slow) later(followThrough(i, slow));
    return json(response);
  }
  if (i.type !== 2) return json({ type: 4, data: { content: 'That isn’t supported.', flags: 64 } });

  // Answer "thinking…" right away (Discord allows 3 seconds), then fill in the real reply.
  const reply = ['trade', 'trades'].includes(i.data && i.data.name) ? tradeCommand : commandReply;
  const done = reply(i, deps)
    .catch((e) => {
      console.error('Command failed:', e.message);
      return { content: 'Something went wrong. Try again in a minute.' };
    })
    .then((message) => call(API + '/webhooks/' + i.application_id + '/' + i.token + '/messages/@original', 'PATCH',
      { allowed_mentions: { parse: [] }, ...message }, false))
    .then((r) => { if (!r.ok) console.error('Reply failed', r.status, JSON.stringify(r.body)); })
    .catch((e) => console.error('Reply failed:', e.message));
  later(done);
  return json({ type: 5, data: isEphemeral(i) ? { flags: 64 } : {} });
});
