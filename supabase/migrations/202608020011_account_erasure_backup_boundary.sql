-- Bind connected-account erasure to the exact cloud snapshot and evidence
-- generation captured by a complete portable backup. Both snapshot saves and
-- Storage mutations serialize against the lifecycle row, so the final compare
-- and transition to `deleting` form one authoritative cloud fence.

alter table public.account_lifecycle
  add column if not exists evidence_revision bigint not null default 0;

-- A cleanup claim is a permanent tombstone for one immutable private object
-- path. Normal Storage deletion is allowed only after the exact account's
-- current workspace no longer references every path in an atomically claimed
-- batch. Claims intentionally survive successful deletion so a later snapshot
-- or upload can never resurrect the same path.
create table if not exists private.evidence_cleanup_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  remote_path text not null,
  claimed_at timestamptz not null default clock_timestamp(),
  primary key (user_id, remote_path),
  constraint evidence_cleanup_claim_remote_path_nonempty
    check (
      length(remote_path) between 1 and 1024
      and remote_path = btrim(remote_path)
      and split_part(remote_path, '/', 1) = user_id::text
      and cardinality(string_to_array(remote_path, '/')) = 4
      and split_part(remote_path, '/', 2) not in ('', '.', '..')
      and split_part(remote_path, '/', 3) not in ('', '.', '..')
      and split_part(remote_path, '/', 4) not in ('', '.', '..')
    )
);

revoke all privileges on table private.evidence_cleanup_claims
  from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant select on table private.evidence_cleanup_claims to service_role;

-- Lifecycle mutations remain RPC-only. The service role gets read-only access
-- for trusted operational inspection and cloud integration verification; it is
-- never exposed to the browser. Revoke first so fresh and upgraded projects
-- converge even when an older Data API default granted auxiliary privileges.
revoke all privileges on table public.account_lifecycle
  from public, anon, authenticated, service_role;
grant select on table public.account_lifecycle to service_role;

-- Snapshot mutation is compare-and-swap RPC-only. In particular, direct
-- DELETE must not let an account reset and replay its numeric revision after a
-- backup, which would make a stale erasure boundary appear current again.
revoke all privileges on table public.workspace_snapshots
  from public, anon, authenticated, service_role;
grant select on table public.workspace_snapshots to authenticated, service_role;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.account_lifecycle'::regclass
      and conname = 'account_lifecycle_evidence_revision_nonnegative'
  ) then
    alter table public.account_lifecycle
      add constraint account_lifecycle_evidence_revision_nonnegative
      check (evidence_revision >= 0);
  end if;
end;
$$;

create or replace function private.workspace_state_references_evidence_path(
  p_state jsonb,
  p_remote_path text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1
    from jsonb_array_elements(
      case
        when jsonb_typeof(p_state -> 'goals') = 'array' then p_state -> 'goals'
        else '[]'::jsonb
      end
    ) as goal(value)
    cross join lateral jsonb_array_elements(
      case
        when jsonb_typeof(goal.value -> 'evidence') = 'array'
          then goal.value -> 'evidence'
        else '[]'::jsonb
      end
    ) as evidence(value)
    where evidence.value ->> 'remotePath' = p_remote_path
  );
$$;

revoke all on function private.workspace_state_references_evidence_path(jsonb, text)
  from public, anon, authenticated;

create or replace function public.claim_evidence_cleanup(
  p_expected_account_id uuid,
  p_remote_paths text[]
)
returns table (
  claimed boolean,
  workspace_revision bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  lifecycle_status text;
  current_state jsonb;
  current_revision bigint := 0;
  normalized_paths text[];
  requested_path text;
  path_parts text[];
begin
  if caller_id is null then
    raise exception 'authentication_required'
      using errcode = '42501';
  end if;
  if p_expected_account_id is null or caller_id is distinct from p_expected_account_id then
    raise exception 'account_identity_mismatch'
      using errcode = '42501';
  end if;
  if p_remote_paths is null or cardinality(p_remote_paths) = 0
     or cardinality(p_remote_paths) > 1000 then
    raise exception 'invalid_evidence_cleanup_paths'
      using errcode = '22023';
  end if;

  select array_agg(path order by path)
  into normalized_paths
  from (select distinct unnest(p_remote_paths) as path) as requested;

  if cardinality(normalized_paths) is distinct from cardinality(p_remote_paths) then
    raise exception 'duplicate_evidence_cleanup_paths'
      using errcode = '22023';
  end if;

  foreach requested_path in array normalized_paths loop
    path_parts := string_to_array(requested_path, '/');
    if requested_path is null
       or length(requested_path) > 1024
       or requested_path is distinct from btrim(requested_path)
       or cardinality(path_parts) <> 4
       or path_parts[1] is distinct from caller_id::text
       or path_parts[2] in ('', '.', '..')
       or path_parts[3] in ('', '.', '..')
       or path_parts[4] in ('', '.', '..') then
      raise exception 'invalid_evidence_cleanup_path'
        using errcode = '22023';
    end if;
  end loop;

  select lifecycle.status
  into lifecycle_status
  from public.account_lifecycle as lifecycle
  join auth.users as account on account.id = lifecycle.user_id
  where lifecycle.user_id = caller_id
  for update of lifecycle;

  if lifecycle_status is distinct from 'active' then
    raise exception 'account_deletion_in_progress'
      using errcode = '55000';
  end if;

  select snapshot.state, snapshot.revision
  into current_state, current_revision
  from public.workspace_snapshots as snapshot
  where snapshot.user_id = caller_id;
  current_revision := coalesce(current_revision, 0);

  if exists (
    select 1
    from unnest(normalized_paths) as requested(path)
    where private.workspace_state_references_evidence_path(
      current_state,
      requested.path
    )
  ) then
    return query select false, current_revision;
    return;
  end if;

  insert into private.evidence_cleanup_claims (user_id, remote_path)
  select caller_id, requested.path
  from unnest(normalized_paths) as requested(path)
  on conflict (user_id, remote_path) do nothing;

  return query select true, current_revision;
end;
$$;

revoke all on function public.claim_evidence_cleanup(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.claim_evidence_cleanup(uuid, text[])
  to authenticated;

create or replace function private.evidence_owner_id(
  p_bucket_id text,
  p_name text
)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
  owner_segment text;
begin
  if p_bucket_id is distinct from 'evidence' or p_name is null then
    return null;
  end if;
  owner_segment := split_part(p_name, '/', 1);
  if owner_segment !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return owner_segment::uuid;
end;
$$;

revoke all on function private.evidence_owner_id(text, text)
  from public, anon, authenticated;

create or replace function private.bump_account_evidence_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_owner uuid;
  new_owner uuid;
begin
  if tg_op = 'UPDATE' then
    -- Storage regenerates path_tokens from name for every UPDATE, so NEW can
    -- expose a transient null before that generated column is recomputed.
    -- Access and derived timestamp/route fields do not change the backed-up
    -- object; every other present or future column remains revision-fenced.
    if (to_jsonb(new) - array[
      'last_accessed_at',
      'updated_at',
      'path_tokens'
    ]::text[])
      is not distinct from (to_jsonb(old) - array[
        'last_accessed_at',
        'updated_at',
        'path_tokens'
      ]::text[]) then
      return new;
    end if;
  end if;
  if tg_op <> 'INSERT' then
    old_owner := private.evidence_owner_id(old.bucket_id, old.name);
  end if;
  if tg_op <> 'DELETE' then
    new_owner := private.evidence_owner_id(new.bucket_id, new.name);
  end if;

  if old_owner is not null then
    update public.account_lifecycle
    set evidence_revision = evidence_revision + 1
    where user_id = old_owner;
  end if;
  if new_owner is not null and new_owner is distinct from old_owner then
    update public.account_lifecycle
    set evidence_revision = evidence_revision + 1
    where user_id = new_owner;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.bump_account_evidence_revision()
  from public, anon, authenticated;

drop trigger if exists bump_evolvra_evidence_revision on storage.objects;
create trigger bump_evolvra_evidence_revision
  before insert or update or delete on storage.objects
  for each row execute function private.bump_account_evidence_revision();

-- New writes must use the app's claimable immutable four-segment path shape.
-- Both write and delete checks take the same lifecycle key-share lock as
-- snapshot saves. A pre-fence mutation therefore finishes and advances the
-- evidence boundary before account erasure can commit its lifecycle fence.
create or replace function private.evidence_path_writes_allowed(
  p_bucket_id text,
  p_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  lifecycle_status text;
  path_parts text[];
begin
  if caller_id is null
     or private.evidence_owner_id(p_bucket_id, p_name) is distinct from caller_id then
    return false;
  end if;

  path_parts := string_to_array(p_name, '/');
  if length(p_name) > 1024
     or p_name is distinct from btrim(p_name)
     or cardinality(path_parts) <> 4
     or path_parts[2] in ('', '.', '..')
     or path_parts[3] in ('', '.', '..')
     or path_parts[4] in ('', '.', '..') then
    return false;
  end if;

  select lifecycle.status
  into lifecycle_status
  from public.account_lifecycle as lifecycle
  join auth.users as account on account.id = lifecycle.user_id
  where lifecycle.user_id = caller_id
  for key share of lifecycle;

  return lifecycle_status = 'active'
    and not exists (
      select 1
      from private.evidence_cleanup_claims as claim
      where claim.user_id = caller_id
        and claim.remote_path = p_name
    );
end;
$$;

revoke all on function private.evidence_path_writes_allowed(text, text)
  from public, anon, authenticated;
grant execute on function private.evidence_path_writes_allowed(text, text)
  to authenticated;

create or replace function private.evidence_deletes_allowed(
  p_bucket_id text,
  p_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  lifecycle_status text;
begin
  if caller_id is null
     or private.evidence_owner_id(p_bucket_id, p_name) is distinct from caller_id then
    return false;
  end if;

  select lifecycle.status
  into lifecycle_status
  from public.account_lifecycle as lifecycle
  join auth.users as account on account.id = lifecycle.user_id
  where lifecycle.user_id = caller_id
  for key share of lifecycle;

  return lifecycle_status = 'deleting'
    or (
      lifecycle_status = 'active'
      and exists (
        select 1
        from private.evidence_cleanup_claims as claim
        where claim.user_id = caller_id
          and claim.remote_path = p_name
      )
    );
end;
$$;

revoke all on function private.evidence_deletes_allowed(text, text)
  from public, anon, authenticated;
grant execute on function private.evidence_deletes_allowed(text, text)
  to authenticated;

drop policy if exists "users upload own evidence" on storage.objects;
drop policy if exists "users update own evidence" on storage.objects;
drop policy if exists "users delete own evidence" on storage.objects;
-- The retired zero-argument policy helpers could not bind authorization to an
-- exact immutable object path. Drop them after removing their policy
-- dependencies so upgraded projects expose only the path-bound contracts.
drop function if exists private.evidence_writes_allowed();
drop function if exists private.evidence_deletes_allowed();
create policy "users upload own evidence" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and private.evidence_path_writes_allowed(bucket_id, name)
  );
create policy "users update own evidence" on storage.objects for update to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and private.evidence_path_writes_allowed(bucket_id, name)
  )
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and private.evidence_path_writes_allowed(bucket_id, name)
  );

create policy "users delete own evidence" on storage.objects for delete to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = auth.uid()::text
    and private.evidence_deletes_allowed(bucket_id, name)
  );

-- A browser can change accounts while a Supabase request is still resolving
-- its access token. Bind every snapshot save to the account that owned the
-- client state at enqueue time so a delayed request cannot write that state
-- into whichever account happens to be authenticated at dispatch time.
drop function if exists public.save_workspace_snapshot(jsonb, bigint);

create or replace function public.save_workspace_snapshot(
  p_expected_account_id uuid,
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
  if p_expected_account_id is null or caller_id is distinct from p_expected_account_id then
    raise exception 'account_identity_mismatch'
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
  if exists (
    select 1
    from private.evidence_cleanup_claims as claim
    where claim.user_id = caller_id
      and private.workspace_state_references_evidence_path(
        p_state,
        claim.remote_path
      )
  ) then
    raise exception 'evidence_cleanup_path_claimed'
      using errcode = 'PT409',
            hint = 'Use a fresh immutable evidence identifier and object path.';
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
    using errcode = 'PT409',
          detail = format('Expected workspace revision %s is stale.', p_expected_revision),
          hint = 'Reload the latest workspace before saving again.';
end;
$$;

revoke all on function public.save_workspace_snapshot(uuid, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.save_workspace_snapshot(uuid, jsonb, bigint)
  to authenticated;

-- The old signature cannot distinguish an account handoff that occurs before
-- token resolution. Keep a clear, fail-closed compatibility endpoint during
-- the coordinated rollout instead of allowing an old tab to mutate cloud
-- state under the wrong identity.
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
begin
  if auth.uid() is null then
    raise exception 'authentication_required'
      using errcode = '42501';
  end if;
  raise exception 'workspace_client_update_required'
    using errcode = '55000',
          hint = 'Reload Evolvra to use the account-bound snapshot save contract.';
end;
$$;

revoke all on function public.save_workspace_snapshot(jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.save_workspace_snapshot(jsonb, bigint)
  to authenticated;

create or replace function public.read_account_erasure_backup_boundary(
  p_expected_account_id uuid
)
returns table (
  workspace_revision bigint,
  evidence_revision bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  lifecycle_status text;
  current_evidence_revision bigint;
begin
  if caller_id is null then
    raise exception 'authentication_required'
      using errcode = '42501';
  end if;
  if p_expected_account_id is null or caller_id is distinct from p_expected_account_id then
    raise exception 'account_identity_mismatch'
      using errcode = '42501';
  end if;

  select lifecycle.status, lifecycle.evidence_revision
  into lifecycle_status, current_evidence_revision
  from public.account_lifecycle as lifecycle
  join auth.users as account on account.id = lifecycle.user_id
  where lifecycle.user_id = caller_id
  for update of lifecycle;

  if lifecycle_status is distinct from 'active' then
    raise exception 'account_deletion_in_progress'
      using errcode = '55000';
  end if;

  return query
  select
    coalesce(snapshot.revision, 0)::bigint,
    current_evidence_revision
  from (select 1) as singleton
  left join public.workspace_snapshots as snapshot
    on snapshot.user_id = caller_id;
end;
$$;

revoke all on function public.read_account_erasure_backup_boundary(uuid)
  from public, anon, authenticated;
grant execute on function public.read_account_erasure_backup_boundary(uuid)
  to authenticated;

-- The retired one-argument function must not remain callable by an old bundle:
-- it would bypass the backup boundary during a rolling client deployment.
drop function if exists public.begin_account_deletion(uuid);

create or replace function public.begin_account_deletion(
  p_expected_account_id uuid,
  p_expected_workspace_revision bigint,
  p_expected_evidence_revision bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  lifecycle_status text;
  current_workspace_revision bigint;
  current_evidence_revision bigint;
begin
  if caller_id is null then
    raise exception 'authentication_required'
      using errcode = '42501';
  end if;
  if p_expected_account_id is null or caller_id is distinct from p_expected_account_id then
    raise exception 'account_identity_mismatch'
      using errcode = '42501';
  end if;

  -- A stale signed token can outlive the successfully deleted auth row. The
  -- exact caller is already terminal, so device cleanup may continue.
  if not exists (select 1 from auth.users where id = caller_id) then
    return;
  end if;

  insert into public.account_lifecycle (user_id)
  values (caller_id)
  on conflict (user_id) do nothing;

  select lifecycle.status, lifecycle.evidence_revision
  into lifecycle_status, current_evidence_revision
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = caller_id
  for update;

  -- Retrying an already durable server fence is idempotent. No active account
  -- can enter this branch without first passing the boundary comparison.
  if lifecycle_status = 'deleting' then
    return;
  end if;
  if lifecycle_status is distinct from 'active' then
    raise exception 'account_deletion_in_progress'
      using errcode = '55000';
  end if;
  if (
    p_expected_workspace_revision is null
    or p_expected_workspace_revision < 0
    or p_expected_evidence_revision is null
    or p_expected_evidence_revision < 0
  ) then
    raise exception 'invalid_account_erasure_backup_boundary'
      using errcode = '22023';
  end if;

  select coalesce(snapshot.revision, 0)
  into current_workspace_revision
  from (select 1) as singleton
  left join public.workspace_snapshots as snapshot
    on snapshot.user_id = caller_id;

  if (
    current_workspace_revision is distinct from p_expected_workspace_revision
    or current_evidence_revision is distinct from p_expected_evidence_revision
  ) then
    raise exception 'account_erasure_backup_stale'
      using errcode = 'PT409',
            detail = format(
              'Expected workspace/evidence revisions %s/%s but found %s/%s.',
              p_expected_workspace_revision,
              p_expected_evidence_revision,
              current_workspace_revision,
              current_evidence_revision
            ),
            hint = 'Reconcile the account and download a fresh complete backup before erasing anything.';
  end if;

  update public.account_lifecycle
  set status = 'deleting',
      deletion_started_at = coalesce(deletion_started_at, clock_timestamp())
  where user_id = caller_id;
end;
$$;

revoke all on function public.begin_account_deletion(uuid, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid, bigint, bigint)
  to authenticated;

-- Keep the old signature resume-only during rolling deployment. An old client
-- can finish a server fence already created by the boundary-aware RPC, but it
-- can never move an active account into deleting without a verified backup.
create or replace function public.begin_account_deletion(
  p_expected_account_id uuid
)
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
  if not exists (select 1 from auth.users where id = caller_id) then
    return;
  end if;

  select lifecycle.status
  into lifecycle_status
  from public.account_lifecycle as lifecycle
  where lifecycle.user_id = caller_id
  for update;

  if lifecycle_status = 'deleting' then
    return;
  end if;
  raise exception 'account_erasure_backup_required'
    using errcode = 'PT409',
          hint = 'Update Evolvra and download a fresh complete backup before erasing this active account.';
end;
$$;

revoke all on function public.begin_account_deletion(uuid)
  from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid)
  to authenticated;
