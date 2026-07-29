-- Add optimistic concurrency to the local-first workspace snapshot document.
-- Existing rows start at revision 0; the first successful RPC save advances
-- them to revision 1.

alter table public.workspace_snapshots
  add column if not exists revision bigint;

update public.workspace_snapshots
set revision = 0
where revision is null or revision < 0;

alter table public.workspace_snapshots
  alter column revision set default 0,
  alter column revision set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.workspace_snapshots'::regclass
      and conname = 'workspace_snapshots_revision_nonnegative'
  ) then
    alter table public.workspace_snapshots
      add constraint workspace_snapshots_revision_nonnegative
      check (revision >= 0);
  end if;
end;
$$;

-- Re-declare the shared trigger function so this migration is safe to apply to
-- an older installation where it may not yet exist.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_workspace_snapshots_updated_at on public.workspace_snapshots;
create trigger set_workspace_snapshots_updated_at
  before update on public.workspace_snapshots
  for each row execute function public.set_updated_at();

-- This trigger function is internal and must not be exposed as a Data API RPC.
revoke all on function public.set_updated_at() from public, anon, authenticated;

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
begin
  if caller_id is null then
    raise exception 'authentication_required'
      using errcode = '42501';
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
grant execute on function public.save_workspace_snapshot(jsonb, bigint) to authenticated;

-- Prevent direct REST writes from bypassing the compare-and-swap RPC. Existing
-- owner RLS continues to protect reads and explicit snapshot deletion.
revoke all privileges on table public.workspace_snapshots from public, anon, authenticated;
grant select, delete on table public.workspace_snapshots to authenticated;
