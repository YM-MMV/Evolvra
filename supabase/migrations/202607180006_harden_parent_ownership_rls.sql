-- Prevent an authenticated caller from attaching an otherwise owner-labelled
-- child row to another account's parent record. RLS remains the API boundary;
-- foreign keys alone establish existence, not ownership.

-- Reassert the account-erasure fence here as part of the final security
-- migration so both fresh and previously upgraded projects converge on the
-- same lifecycle, policy, and RPC contract.
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

  -- A signed stale JWT can outlive the auth.users row when the client lost the
  -- successful deletion response. Treat that exact caller as already deleted
  -- so retry is idempotent and can continue device cleanup safely.
  if not exists (select 1 from auth.users where id = caller_id) then
    return;
  end if;

  insert into public.account_lifecycle (user_id)
  values (caller_id)
  on conflict (user_id) do nothing;

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

alter table public.profiles enable row level security;
alter table public.account_lifecycle enable row level security;
alter table public.areas enable row level security;
alter table public.stats enable row level security;
alter table public.goals enable row level security;
alter table public.goal_stats enable row level security;
alter table public.goal_check_ins enable row level security;
alter table public.progress_metrics enable row level security;
alter table public.metric_entries enable row level security;
alter table public.milestones enable row level security;
alter table public.quests enable row level security;
alter table public.quest_completions enable row level security;
alter table public.reviews enable row level security;
alter table public.user_settings enable row level security;
alter table public.workspace_snapshots enable row level security;

drop policy if exists "owner access" on public.profiles;
drop policy if exists "owner access" on public.areas;
drop policy if exists "owner access" on public.stats;
drop policy if exists "owner access" on public.goals;
drop policy if exists "owner access" on public.goal_stats;
drop policy if exists "owner access" on public.goal_check_ins;
drop policy if exists "owner access" on public.progress_metrics;
drop policy if exists "owner access" on public.metric_entries;
drop policy if exists "owner access" on public.milestones;
drop policy if exists "owner access" on public.quests;
drop policy if exists "owner access" on public.quest_completions;
drop policy if exists "owner access" on public.reviews;
drop policy if exists "owner access" on public.user_settings;
drop policy if exists "owner access" on public.workspace_snapshots;

create policy "owner access" on public.profiles for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
create policy "owner access" on public.areas for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "owner access" on public.stats for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "owner access" on public.goals for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (
      area_id is null
      or exists (
        select 1
        from public.areas as parent_area
        where parent_area.id = goals.area_id
          and parent_area.user_id = auth.uid()
      )
    )
  );
create policy "owner access" on public.goal_stats for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.goals as parent_goal
      where parent_goal.id = goal_stats.goal_id
        and parent_goal.user_id = auth.uid()
    )
    and exists (
      select 1
      from public.stats as parent_stat
      where parent_stat.id = goal_stats.stat_id
        and parent_stat.user_id = auth.uid()
    )
  );
create policy "owner access" on public.goal_check_ins for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.goals as parent_goal
      where parent_goal.id = goal_check_ins.goal_id
        and parent_goal.user_id = auth.uid()
    )
  );
create policy "owner access" on public.progress_metrics for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.goals as parent_goal
      where parent_goal.id = progress_metrics.goal_id
        and parent_goal.user_id = auth.uid()
    )
  );
create policy "owner access" on public.metric_entries for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.goals as parent_goal
      where parent_goal.id = metric_entries.goal_id
        and parent_goal.user_id = auth.uid()
    )
    and exists (
      select 1
      from public.progress_metrics as parent_metric
      where parent_metric.id = metric_entries.metric_id
        and parent_metric.goal_id = metric_entries.goal_id
        and parent_metric.user_id = auth.uid()
    )
  );
create policy "owner access" on public.milestones for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.goals as parent_goal
      where parent_goal.id = milestones.goal_id
        and parent_goal.user_id = auth.uid()
    )
  );
create policy "owner access" on public.quests for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.goals as parent_goal
      where parent_goal.id = quests.goal_id
        and parent_goal.user_id = auth.uid()
    )
  );
create policy "owner access" on public.quest_completions for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.goals as parent_goal
      where parent_goal.id = quest_completions.goal_id
        and parent_goal.user_id = auth.uid()
    )
    and exists (
      select 1
      from public.quests as parent_quest
      where parent_quest.id = quest_completions.quest_id
        and parent_quest.goal_id = quest_completions.goal_id
        and parent_quest.user_id = auth.uid()
    )
  );
create policy "owner access" on public.reviews for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "owner access" on public.user_settings for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "owner access" on public.workspace_snapshots for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Explicit Data API privileges are required on new Supabase projects. RLS is
-- the row boundary; anonymous clients receive no normalized-domain privileges.
grant usage on schema public to authenticated;
revoke all privileges on table
  public.profiles,
  public.areas,
  public.stats,
  public.goals,
  public.goal_stats,
  public.goal_check_ins,
  public.progress_metrics,
  public.metric_entries,
  public.milestones,
  public.quests,
  public.quest_completions,
  public.reviews,
  public.user_settings
from public, anon;
grant select, insert, update, delete on table
  public.profiles,
  public.areas,
  public.stats,
  public.goals,
  public.goal_stats,
  public.goal_check_ins,
  public.progress_metrics,
  public.metric_entries,
  public.milestones,
  public.quests,
  public.quest_completions,
  public.reviews,
  public.user_settings
to authenticated;

-- Lifecycle state is RPC-only and has no client RLS policy.
revoke all privileges on table public.account_lifecycle from public, anon, authenticated;

-- Snapshot updates remain restricted to the compare-and-swap RPC. Revoke every
-- legacy auto-exposure grant first so upgraded projects cannot retain anonymous
-- access or service-role write access from an older Data API default. The
-- service role has read-only access for trusted operational inspection and
-- cloud integration verification; it is never exposed to the browser.
revoke all privileges on table public.workspace_snapshots from public, anon, authenticated, service_role;
grant select, delete on table public.workspace_snapshots to authenticated;
grant select on table public.workspace_snapshots to service_role;

-- Security-definer CAS writes bypass table RLS, so they must take the same
-- lifecycle lock as evidence writes. Once begin_account_deletion commits its
-- deleting state, no stale tab can update or recreate a cloud snapshot.
create or replace function public.save_workspace_snapshot(
  p_state jsonb,
  p_expected_revision bigint
)
returns table (
  state jsonb,
  revision bigint,
  updated_at timestamptz
)
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

  select lifecycle.status
  into lifecycle_status
  from public.account_lifecycle as lifecycle
  join auth.users as account on account.id = lifecycle.user_id
  where lifecycle.user_id = caller_id
  for key share of lifecycle;

  if lifecycle_status is distinct from 'active' then
    raise exception 'account_deletion_in_progress'
      using errcode = '55000';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'invalid_workspace_revision'
      using errcode = '22023';
  end if;

  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'invalid_workspace_state'
      using errcode = '22023';
  end if;

  return query
  update public.workspace_snapshots as snapshot
  set state = p_state,
      revision = snapshot.revision + 1,
      updated_at = clock_timestamp()
  where snapshot.user_id = caller_id
    and snapshot.revision = p_expected_revision
  returning snapshot.state, snapshot.revision, snapshot.updated_at;

  if found then
    return;
  end if;

  if p_expected_revision = 0 then
    return query
    insert into public.workspace_snapshots as snapshot (user_id, state, revision, updated_at)
    values (caller_id, p_state, 1, clock_timestamp())
    on conflict (user_id) do nothing
    returning snapshot.state, snapshot.revision, snapshot.updated_at;

    if found then
      return;
    end if;
  end if;

  raise exception 'workspace_revision_conflict'
    using errcode = '40001',
          detail = format('Expected workspace revision %s is stale.', p_expected_revision),
          hint = 'Reload the latest workspace before saving again.';
end;
$$;

revoke all on function public.save_workspace_snapshot(jsonb, bigint) from public;
revoke all on function public.save_workspace_snapshot(jsonb, bigint) from anon;
revoke all on function public.save_workspace_snapshot(jsonb, bigint) from authenticated;
grant execute on function public.save_workspace_snapshot(jsonb, bigint) to authenticated;

-- Trigger functions are internal implementation details, not Data API RPCs.
-- Revoking EXECUTE does not prevent their owning triggers from firing.
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Reassert the private evidence bucket contract for existing deployments. An
-- UPDATE must satisfy the path rule before and after the write, preventing an
-- owner from moving an object into another account's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'evidence',
  'evidence',
  false,
  10485760,
  array['image/jpeg','image/png','image/webp','application/pdf','text/plain']
)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "users read own evidence" on storage.objects;
drop policy if exists "users upload own evidence" on storage.objects;
drop policy if exists "users update own evidence" on storage.objects;
drop policy if exists "users delete own evidence" on storage.objects;

create policy "users read own evidence" on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
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
create policy "users delete own evidence" on storage.objects for delete to authenticated
  using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);

-- Account erasure always derives the target from the authenticated session.
-- Finalization requires the lifecycle fence and an empty evidence metadata
-- prefix. It checks storage.objects but never deletes Storage rows in SQL.
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

  -- Idempotent lost-response retry for the same authenticated JWT subject.
  if not exists (select 1 from auth.users where id = caller_id) then
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
    return;
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
