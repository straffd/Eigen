-- Eigen: classes and folders.
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run: it only creates what is missing and replaces policies/functions.

-- ---------- Tables ----------
create table if not exists public.classes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  created_at  timestamptz not null default now()
);

create table if not exists public.folders (
  id          uuid primary key default gen_random_uuid(),
  class_id    uuid not null references public.classes (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  created_at  timestamptz not null default now()
);

-- Archiving (added later; safe on existing tables)
alter table public.classes add column if not exists archived_at timestamptz;
alter table public.folders add column if not exists archived_at timestamptz;

-- Folder order within a class (drag to reorder). Null = not yet ordered; sorted after by creation time.
alter table public.folders add column if not exists position double precision;

create index if not exists classes_user_id_idx on public.classes (user_id);
create index if not exists folders_class_id_idx on public.folders (class_id);
create index if not exists folders_user_id_idx on public.folders (user_id);

-- ---------- Row Level Security: each user only sees and edits their own rows ----------
alter table public.classes enable row level security;
alter table public.folders enable row level security;

drop policy if exists "classes: owner can read"   on public.classes;
drop policy if exists "classes: owner can insert" on public.classes;
drop policy if exists "classes: owner can update" on public.classes;
drop policy if exists "classes: owner can delete" on public.classes;

create policy "classes: owner can read"   on public.classes for select to authenticated using (user_id = auth.uid());
create policy "classes: owner can insert" on public.classes for insert to authenticated with check (user_id = auth.uid());
create policy "classes: owner can update" on public.classes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "classes: owner can delete" on public.classes for delete to authenticated using (user_id = auth.uid());

drop policy if exists "folders: owner can read"   on public.folders;
drop policy if exists "folders: owner can insert" on public.folders;
drop policy if exists "folders: owner can update" on public.folders;
drop policy if exists "folders: owner can delete" on public.folders;

-- A folder can only be put in a class the same user owns.
create policy "folders: owner can read"   on public.folders for select to authenticated using (user_id = auth.uid());
create policy "folders: owner can insert" on public.folders for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid()));
create policy "folders: owner can update" on public.folders for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.classes c where c.id = class_id and c.user_id = auth.uid()));
create policy "folders: owner can delete" on public.folders for delete to authenticated using (user_id = auth.uid());

-- ---------- Free plan: at most 4 active (non-archived) classes per user, enforced by the database ----------
create or replace function public.enforce_class_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  class_limit constant int := 4;
begin
  -- Only active classes count. Skip archived inserts and updates that don't make a class active.
  if new.archived_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.archived_at is null then
    return new;
  end if;
  -- Only ever count the caller's own classes (this function bypasses RLS).
  if new.user_id is distinct from auth.uid() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- Serialise per user so two tabs can't both slip past the limit.
  perform pg_advisory_xact_lock(hashtext('eigen_class_limit:' || new.user_id::text));
  if (select count(*) from public.classes
      where user_id = new.user_id and archived_at is null and id <> new.id) >= class_limit then
    raise exception 'class_limit: free plan includes up to % active classes', class_limit
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists classes_enforce_limit on public.classes;
create trigger classes_enforce_limit
  before insert or update of archived_at on public.classes
  for each row execute function public.enforce_class_limit();

-- ---------- Table access for signed-in users (RLS above still limits them to their own rows) ----------
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.classes, public.folders to authenticated;

-- ---------- Files ----------
-- Each file's bytes live in the private "files" storage bucket at <user_id>/<file_id>.
-- A row here must exist before the upload is allowed (see storage policies below),
-- which is how the per-user storage quota is enforced.
create table if not exists public.files (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  folder_id     uuid not null references public.folders (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 200),
  size          bigint not null check (size >= 0 and size <= 52428800),
  mime_type     text,
  storage_path  text not null unique,
  uploaded      boolean not null default false,
  created_at    timestamptz not null default now(),
  check (storage_path = user_id::text || '/' || id::text)
);

create index if not exists files_folder_id_idx on public.files (folder_id);
create index if not exists files_user_id_idx on public.files (user_id);

alter table public.files enable row level security;

drop policy if exists "files: owner can read"   on public.files;
drop policy if exists "files: owner can insert" on public.files;
drop policy if exists "files: owner can update" on public.files;
drop policy if exists "files: owner can delete" on public.files;

create policy "files: owner can read"   on public.files for select to authenticated using (user_id = auth.uid());
create policy "files: owner can insert" on public.files for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.folders f where f.id = folder_id and f.user_id = auth.uid()));
create policy "files: owner can update" on public.files for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.folders f where f.id = folder_id and f.user_id = auth.uid()));
create policy "files: owner can delete" on public.files for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.files to authenticated;

-- Size, path and owner are fixed once a file is created; only name, folder and uploaded can change.
create or replace function public.files_lock_columns()
returns trigger
language plpgsql
as $$
begin
  if new.size is distinct from old.size
     or new.storage_path is distinct from old.storage_path
     or new.user_id is distinct from old.user_id then
    raise exception 'size, storage_path and user_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists files_lock_columns on public.files;
create trigger files_lock_columns
  before update on public.files
  for each row execute function public.files_lock_columns();

-- Free plan: 250 MB of files per user.
create or replace function public.enforce_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  quota constant bigint := 262144000; -- 250 MB
begin
  if new.user_id is distinct from auth.uid() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('eigen_storage_quota:' || new.user_id::text));
  if (select coalesce(sum(size), 0) from public.files where user_id = new.user_id) + new.size > quota then
    raise exception 'storage_quota: free plan includes % MB of files', quota / 1048576
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists files_enforce_quota on public.files;
create trigger files_enforce_quota
  before insert on public.files
  for each row execute function public.enforce_storage_quota();

-- ---------- Storage bucket (private, 50 MB per file) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "files bucket: owner can read"   on storage.objects;
drop policy if exists "files bucket: owner can upload" on storage.objects;
drop policy if exists "files bucket: owner can delete" on storage.objects;

create policy "files bucket: owner can read" on storage.objects for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);

-- Uploads only go to a path that has a matching files row (so the quota applies) and can't overwrite.
create policy "files bucket: owner can upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'files'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (select 1 from public.files f
                where f.storage_path = objects.name and f.user_id = auth.uid() and not f.uploaded)
  );

create policy "files bucket: owner can delete" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
