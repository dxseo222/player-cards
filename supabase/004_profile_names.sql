-- 004: never give a player a blank name.
-- Some Discord display names are empty or made only of invisible characters (like ㅤ),
-- which left profiles with a name nobody could see. Run once in Supabase → SQL Editor.

-- A name counts as blank if nothing is left after removing spaces and invisible characters.
create or replace function public._visible_name(n text)
returns text language sql immutable as $$
  select case
    when n is null then null
    when regexp_replace(n, '[[:space:]' || chr(12644) || chr(4447) || chr(4448) || chr(65440)
                         || chr(8203) || chr(8204) || chr(8205) || chr(10240) || chr(173) || ']', '', 'g') = '' then null
    else left(btrim(n), 40)
  end;
$$;

-- New sign-ins: display name, then Discord username, then "player".
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, avatar_url)
  values (
    new.id,
    coalesce(
      public._visible_name(new.raw_user_meta_data -> 'custom_claims' ->> 'global_name'),
      public._visible_name(new.raw_user_meta_data ->> 'full_name'),
      public._visible_name(new.raw_user_meta_data ->> 'name'),
      public._visible_name(new.raw_user_meta_data ->> 'user_name'),
      'player'),
    new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

-- Existing players with a blank name get the same fallback.
update public.profiles p
set username = coalesce(
  public._visible_name(u.raw_user_meta_data -> 'custom_claims' ->> 'global_name'),
  public._visible_name(u.raw_user_meta_data ->> 'full_name'),
  public._visible_name(u.raw_user_meta_data ->> 'name'),
  public._visible_name(u.raw_user_meta_data ->> 'user_name'),
  'player')
from auth.users u
where u.id = p.id and public._visible_name(p.username) is null;

revoke all on function public._visible_name(text) from public, anon, authenticated;
