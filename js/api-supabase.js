// Live backend: Supabase (Discord sign-in + Postgres). The trade rules themselves live in
// supabase/schema.sql, so they can't be bypassed from the browser.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js?v8';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const listeners = new Set();
let session = null;

function check({ data, error }) {
  if (error) throw new Error(error.message || 'Something went wrong talking to the server');
  return data;
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
    return rows[0] || { id: session.user.id, username: meta.full_name || meta.name || 'player', avatar_url: meta.avatar_url || null };
  },
  async players() {
    const [profiles, cards] = await Promise.all([
      sb.from('profiles').select('*').order('username').then(check),
      sb.from('cards').select('*').then(check),
    ]);
    const byCreator = new Map(cards.map((c) => [c.creator_id, c]));
    return profiles.map((p) => ({ ...p, card: byCreator.get(p.id) || null }));
  },
  async myCard() {
    const rows = check(await sb.from('cards').select('*').eq('creator_id', session.user.id));
    return rows[0] || null;
  },
  async saveCard(data) { return check(await sb.rpc('save_card', { p_data: data })); },
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
  async removePortrait(url) {
    const marker = '/storage/v1/object/public/portraits/';
    const i = (url || '').indexOf(marker);
    if (i < 0) return;
    const path = decodeURIComponent(url.slice(i + marker.length));
    if (!path.startsWith(session.user.id + '/')) return;
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
};
