-- Fence Storage writes before account erasure. The lifecycle row is always
-- present, cannot be changed directly by a client, and serializes the deletion
-- transition against in-flight evidence INSERT/UPDATE policy checks.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists public.account_lifecycle (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active',
  deletion_started_at timestamptz,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.account_lifecycle'::regclass
      and conname = 'account_lifecycle_status_check'
  ) then
    alter table public.account_lifecycle
      add constraint account_lifecycle_status_check
      check (status in ('active', 'deleting'));
  end if;
end;
$$;

-- CREATE TRIGGER takes the table lock needed to wait out older in-flight Auth
-- inserts. Installing the dedicated trigger before backfill then makes the
-- trigger/backfill sequence race-free without requiring a surrounding manual
-- transaction.
create or replace function private.handle_new_account_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.account_lifecycle (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_lifecycle_created on auth.users;
create trigger on_auth_user_lifecycle_created
  after insert on auth.users
  for each row execute function private.handle_new_account_lifecycle();

revoke all on function private.handle_new_account_lifecycle() from public, anon, authenticated;

-- Keep the original profile/settings trigger narrowly scoped; lifecycle state
-- is owned by the dedicated trigger above.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

insert into public.account_lifecycle (user_id)
select account.id
from auth.users as account
on conflict (user_id) do nothing;

alter table public.account_lifecycle enable row level security;
revoke all privileges on table public.account_lifecycle from public, anon, authenticated;

create or replace function private.evidence_writes_allowed()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  lifecycle_status text;
begin
  if caller_id is null then
    return false;
  end if;

  select lifecycle.status
  into lifecycle_status
  from public.account_lifecycle as lifecycle
  join auth.users as account on account.id = lifecycle.user_id
  where lifecycle.user_id = caller_id
  for key share of lifecycle;

  return lifecycle_status = 'active';
end;
$$;
revoke all on function private.evidence_writes_allowed() from public, anon, authenticated;
grant execute on function private.evidence_writes_allowed() to authenticated;

drop function if exists public.begin_account_deletion();

create or replace function public.begin_account_deletion(p_expected_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'authentication_required'
      using errcode = '42501';
  end if;

  if p_expected_account_id is null or caller_id is distinct from p_expected_account_id then
    raise exception 'account_identity_mismatch'
      using errcode = '42501';
  end if;

  if not exists (select 1 from auth.users where id = caller_id) then
    raise exception 'account_not_found'
      using errcode = '42501';
  end if;

  insert into public.account_lifecycle (user_id)
  values (caller_id)
  on conflict (user_id) do nothing;

  -- Conflicts with the write guard's KEY SHARE lock, so successful in-flight
  -- writes finish before the deleting state becomes visible.
  perform 1
  from public.account_lifecycle
  where user_id = caller_id
  for update;

  update public.account_lifecycle
  set status = 'deleting',
      deletion_started_at = coalesce(deletion_started_at, clock_timestamp())
  where user_id = caller_id;
end;
$$;
revoke all on function public.begin_account_deletion(uuid) from public;
revoke all on function public.begin_account_deletion(uuid) from anon;
revoke all on function public.begin_account_deletion(uuid) from authenticated;
grant execute on function public.begin_account_deletion(uuid) to authenticated;

-- Once deletion starts, SELECT/DELETE remain available for the Storage API
-- sweep, while INSERT/UPDATE are fenced by the lifecycle helper.
drop policy if exists "users upload own evidence" on storage.objects;
drop policy if exists "users update own evidence" on storage.objects;

create policy "users upload own evidence" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and private.evidence_writes_allowed()
  );
create policy "users update own evidence" on storage.objects for update to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and private.evidence_writes_allowed()
  )
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and private.evidence_writes_allowed()
  );

-- Finalization refuses to skip the lifecycle transition or the Storage sweep.
-- It only checks storage.objects metadata; it never deletes Storage rows in SQL.
drop function if exists public.delete_my_account();

create or replace function public.delete_my_account(p_expected_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  lifecycle_status text;
begin
  if caller_id is null then
    raise exception 'authentication_required'
      using errcode = '42501';
  end if;

  if p_expected_account_id is null or caller_id is distinct from p_expected_account_id then
    raise exception 'account_identity_mismatch'
      using errcode = '42501';
  end if;

  select lifecycle.status
  into lifecycle_status
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = caller_id
  for update;

  if lifecycle_status is distinct from 'deleting' then
    raise exception 'account_deletion_not_started'
      using errcode = '55000',
            hint = 'Call begin_account_deletion(account_id), then remove and verify evidence through the Storage API.';
  end if;

  if exists (
    select 1
    from storage.objects as object
    where object.bucket_id = 'evidence'
      and (storage.foldername(object.name))[1] = caller_id::text
  ) then
    raise exception 'account_evidence_not_empty'
      using errcode = '55000',
            hint = 'Remove and verify all evidence through the Storage API before retrying.';
  end if;

  delete from auth.users where id = caller_id;
end;
$$;
revoke all on function public.delete_my_account(uuid) from public;
revoke all on function public.delete_my_account(uuid) from anon;
revoke all on function public.delete_my_account(uuid) from authenticated;
grant execute on function public.delete_my_account(uuid) to authenticated;
