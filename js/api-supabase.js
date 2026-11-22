// Live backend: Supabase (Discord sign-in + Postgres). The trade rules themselves live in
// supabase/*.sql, so they can't be bypassed from the browser.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js?v9';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const listeners = new Set();
let session = null;
let tradeChannel = null;

function check({ data, error }) {
  if (error) {
    if (/card_versions|current_version|is_admin|report_card/.test(error.message || '')) {
      throw new Error('The database needs an update. Run supabase/003_versions_moderation.sql in Supabase.');
    }
    throw new Error(error.message || 'Something went wrong talking to the server');
  }
  return data;
}

// Attaches each card's current version row (its trade counters) as card.cur.
async function withCurrentVersions(cards) {
  if (!cards.length) return cards;
  const versions = check(await sb.from('card_versions').select('id, card_id, version, original2_given, copies_minted').in('card_id', cards.map((c) => c.id)));
  return cards.map((c) => ({
    ...c,
    cur: versions.find((v) => v.card_id === c.id && v.version === c.current_version) || null,
    versionCount: versions.filter((v) => v.card_id === c.id).length,
  }));
}

export const api = {
  mode: 'live',
  async init() {
    session = check(await sb.auth.getSession()).session;
    sb.auth.onAuthStateChange((_e, s) => {
      const changed = (s && s.user.id) !== (session && session.user.id);
      session = s;
      if (changed) listeners.forEach((cb) => cb());
    });
    return session ? this.me() : null;
  },
  onChange(cb) { listeners.add(cb); },
  async signIn() {
    check(await sb.auth.signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: location.origin + location.pathname },
    }));
  },
  async signOut() { await sb.auth.signOut(); },

  async me() {
    if (!session) return null;
    const rows = check(await sb.from('profiles').select('*').eq('id', session.user.id));
    const meta = session.user.user_metadata || {};
    return rows[0] || { id: session.user.id, username: meta.full_name || meta.name || 'player', avatar_url: meta.avatar_url || null, is_admin: false };
  },
  async players() {
    const [profiles, cards] = await Promise.all([
      sb.from('profiles').select('*').order('username').then(check),
      sb.from('cards').select('*').then(check).then(withCurrentVersions),
    ]);
    const byCreator = new Map(cards.map((c) => [c.creator_id, c]));
    return profiles.map((p) => ({ ...p, card: byCreator.get(p.id) || null }));
  },
  async myCard() {
    const rows = check(await sb.from('cards').select('*').eq('creator_id', session.user.id));
    return rows[0] ? (await withCurrentVersions(rows))[0] : null;
  },
  async saveCard(data) { return check(await sb.rpc('save_card', { p_data: data })); },
  async versions(ids) {
    if (!ids.length) return [];
    return check(await sb.from('card_versions').select('*').in('id', ids));
  },
  // Works signed out too, for shared links (hidden cards come back empty).
  async publicCard(cardId, version) {
    const cards = check(await sb.from('cards').select('id, data, current_version, hidden, creator_id').eq('id', cardId));
    if (!cards[0]) return null;
    const v = version || cards[0].current_version;
    const versions = check(await sb.from('card_versions').select('*').eq('card_id', cardId).eq('version', v));
    return versions[0] ? { card: cards[0], version: versions[0] } : null;
  },

  // Portraits go in the public "portraits" bucket under the player's own folder.
  async uploadPortrait(blob) {
    const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
    const path = session.user.id + '/' + Date.now() + '.' + ext;
    const { error } = await sb.storage.from('portraits').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false });
    if (error) {
      if (/bucket not found/i.test(error.message)) throw new Error('Portrait storage isn’t set up yet. Run supabase/002_portraits.sql in Supabase.');
      throw new Error(error.message || 'Upload failed');
    }
    return sb.storage.from('portraits').getPublicUrl(path).data.publicUrl;
  },
  // Old versions may still show a picture, so only pictures no version uses are deleted.
  async removePortrait(url) {
    const marker = '/storage/v1/object/public/portraits/';
    const i = (url || '').indexOf(marker);
    if (i < 0) return;
    const path = decodeURIComponent(url.slice(i + marker.length));
    if (!path.startsWith(session.user.id + '/')) return;
    const mine = await this.myCard();
    if (mine) {
      const used = check(await sb.from('card_versions').select('id').eq('card_id', mine.id).eq('data->>portraitUrl', url));
      if (used.length) return;
    }
    await sb.storage.from('portraits').remove([path]);
  },

  async items(ownerId) { return check(await sb.from('items').select('*').eq('owner_id', ownerId)); },
  async itemsByIds(ids) {
    if (!ids.length) return [];
    return check(await sb.from('items').select('*').in('id', ids));
  },
  async trades() {
    return check(await sb.from('trades').select('*').order('created_at', { ascending: false }).limit(100));
  },
  async propose({ to, offerItems = [], offerMint = false, requestItems = [], requestMint = false, message = '' }) {
    check(await sb.rpc('propose_trade', {
      p_to: to, p_offer_items: offerItems, p_offer_mint: offerMint,
      p_request_items: requestItems, p_request_mint: requestMint, p_message: message,
    }));
  },
  async respond(id, accept) { return check(await sb.rpc('respond_trade', { p_trade: id, p_accept: accept })); },
  async cancel(id) { check(await sb.rpc('cancel_trade', { p_trade: id })); },

  // Live trade updates: calls cb(trade, event) for offers to or from the signed-in player.
  onTrades(cb) {
    if (!session) return;
    if (tradeChannel) sb.removeChannel(tradeChannel);
    const uid = session.user.id;
    const handle = (p) => cb(p.new, p.eventType);
    tradeChannel = sb.channel('trades-' + uid)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trades', filter: 'to_user=eq.' + uid }, handle)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'trades', filter: 'from_user=eq.' + uid }, handle)
      .subscribe();
  },

  // ---------- moderation ----------
  async report(cardId, reason) { check(await sb.rpc('report_card', { p_card: cardId, p_reason: reason })); },
  async reports() { return check(await sb.from('reports').select('*').order('created_at', { ascending: false }).limit(200)); },
  async adminSetHidden(cardId, hidden) { check(await sb.rpc('admin_set_hidden', { p_card: cardId, p_hidden: hidden })); },
  async adminRemovePortrait(card) {
    check(await sb.rpc('admin_remove_portrait', { p_card: card.id }));
    const files = check(await sb.storage.from('portraits').list(card.creator_id, { limit: 100 }));
    if (files.length) await sb.storage.from('portraits').remove(files.map((f) => card.creator_id + '/' + f.name));
  },
  async adminResolve(reportId) { check(await sb.rpc('admin_resolve_report', { p_report: reportId })); },
};
