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
