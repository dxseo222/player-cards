-- Portrait pictures for cards.
-- Run once in Supabase → SQL Editor (projects set up before portraits existed).
-- New projects get the same thing from the end of schema.sql.
--
-- Pictures live in a public "portraits" bucket, so cards can show them. Each player can
-- only upload, replace or delete files inside their own folder (named after their user id).
-- The site shrinks pictures to 720×540 WebP/JPEG before uploading; 1 MB is the hard cap.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portraits', 'portraits', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = true,
      file_size_limit = 1048576,
      allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png'];

drop policy if exists "portraits read" on storage.objects;
create policy "portraits read" on storage.objects for select to authenticated
  using (bucket_id = 'portraits');

drop policy if exists "portraits upload own" on storage.objects;
create policy "portraits upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'portraits' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "portraits update own" on storage.objects;
create policy "portraits update own" on storage.objects for update to authenticated
  using (bucket_id = 'portraits' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'portraits' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "portraits delete own" on storage.objects;
create policy "portraits delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'portraits' and (storage.foldername(name))[1] = auth.uid()::text);
