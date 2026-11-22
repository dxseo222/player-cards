// A throwaway Postgres (PGlite, runs in-process) with just enough of Supabase faked
// (auth.uid(), auth.users, storage, the anon/authenticated roles) to run supabase/*.sql.

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
export const MIGRATIONS = ['schema.sql', '002_portraits.sql', '003_versions_moderation.sql', '004_profile_names.sql', '005_counters_wishlist.sql'];

const SUPABASE_STUBS = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
`;

export function readMigration(name) {
  // pgcrypto isn't bundled with PGlite; gen_random_uuid() is built into Postgres anyway.
  return fs.readFileSync(path.join(SQL_DIR, name), 'utf8').replace(/create extension[^;]*;/i, '');
}

export async function freshDb(upTo = MIGRATIONS.length) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const m of MIGRATIONS.slice(0, upTo)) await db.exec(readMigration(m));
  return db;
}

export async function q(db, sql, params) {
  return (await db.query(sql, params)).rows;
}

// Runs fn as a signed-in player (uid) or as a signed-out visitor (uid = null).
export async function as(db, uid, fn) {
  await db.exec(`set test.uid = '${uid || ''}'`);
  await db.exec(uid ? 'set role authenticated' : 'set role anon');
  try { return await fn(); } finally { await db.exec('reset role'); }
}

export async function addUser(db, id, meta) {
  await db.query('insert into auth.users (id, raw_user_meta_data) values ($1, $2)', [id, JSON.stringify(meta)]);
}

export const A = '11111111-1111-1111-1111-111111111111';
export const B = '22222222-2222-2222-2222-222222222222';
export const C = '33333333-3333-3333-3333-333333333333';
