-- Return stale workspace revisions as an explicit HTTP conflict instead of a
-- PostgreSQL serialization failure. SQLSTATE class 40 is retryable transport
-- machinery; a compare-and-swap miss is a durable product decision that the
-- client must surface immediately.
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
    using errcode = 'PT409',
          detail = format('Expected workspace revision %s is stale.', p_expected_revision),
          hint = 'Reload the latest workspace before saving again.';
end;
$$;

revoke all on function public.save_workspace_snapshot(jsonb, bigint) from public;
revoke all on function public.save_workspace_snapshot(jsonb, bigint) from anon;
revoke all on function public.save_workspace_snapshot(jsonb, bigint) from authenticated;
grant execute on function public.save_workspace_snapshot(jsonb, bigint) to authenticated;
