\set ON_ERROR_STOP on

-- Run after every forward migration has been applied to the seeded original
-- schema. Assertions prove both preservation and deliberate retirement, then
-- remove the fixture account so the independent two-user RLS test starts clean.

begin;

do $$
declare
  unexpected_retired_columns integer;
  missing_current_columns integer;
begin
  if to_regclass('public.xp_transactions') is not null then
    raise exception 'retired xp_transactions table survived the upgrade';
  end if;

  if to_regclass('public.goal_stat_weights') is not null
     or to_regclass('public.goal_stats') is null then
    raise exception 'goal_stat_weights did not converge to goal_stats';
  end if;

  select count(*)
  into unexpected_retired_columns
  from information_schema.columns
  where table_schema = 'public'
    and (
      (table_name = 'profiles' and column_name = 'overall_xp')
      or (table_name = 'stats' and column_name = 'xp')
      or (table_name = 'goals' and column_name = 'open_check_in_score')
      or (table_name = 'goal_stats' and column_name = 'weight')
      or (table_name = 'metric_entries' and column_name = 'delta')
      or (table_name = 'milestones' and column_name = 'xp')
      or (table_name = 'quests' and column_name in ('effort', 'difficulty', 'impact', 'xp'))
      or (table_name = 'quest_completions' and column_name = 'xp_awarded')
      or (table_name = 'user_settings' and column_name = 'scoring')
      or (table_name = 'user_settings' and column_name = 'game_intensity')
    );

  if unexpected_retired_columns <> 0 then
    raise exception '% retired columns survived the upgrade', unexpected_retired_columns;
  end if;

  select count(*)
  into missing_current_columns
  from (
    values
      ('progress_metrics', 'period'),
      ('progress_metrics', 'period_key'),
      ('metric_entries', 'goal_id'),
      ('metric_entries', 'previous_value'),
      ('metric_entries', 'source'),
      ('metric_entries', 'period_key'),
      ('quests', 'kind'),
      ('quests', 'linked_goal_ids'),
      ('quest_completions', 'title'),
      ('quest_completions', 'metric_deltas'),
      ('quest_completions', 'linked_goal_ids'),
      ('user_settings', 'interface_intensity'),
      ('workspace_snapshots', 'revision'),
      ('account_lifecycle', 'evidence_revision')
  ) as expected(table_name, column_name)
  where not exists (
    select 1
    from information_schema.columns as actual
    where actual.table_schema = 'public'
      and actual.table_name = expected.table_name
      and actual.column_name = expected.column_name
  );

  if missing_current_columns <> 0 then
    raise exception '% required current columns are missing after the upgrade', missing_current_columns;
  end if;

  if to_regclass('public.goal_check_ins') is null
     or to_regclass('public.account_lifecycle') is null
     or to_regclass('private.evidence_cleanup_claims') is null then
    raise exception 'current history, lifecycle, or evidence cleanup claim tables are missing';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = '90000000-0000-0000-0000-000000000001'
      and display_name = 'Legacy Upgrade User'
      and current_chapter = 'Legacy chapter retained'
  ) then
    raise exception 'legacy profile fields were not preserved';
  end if;

  if not exists (
    select 1
    from public.areas
    where id = '91000000-0000-0000-0000-000000000001'
      and user_id = '90000000-0000-0000-0000-000000000001'
      and name = 'Legacy area'
      and sort_order = 7
  ) then
    raise exception 'legacy area was not preserved';
  end if;

  if not exists (
    select 1
    from public.stats
    where id = '92000000-0000-0000-0000-000000000001'
      and user_id = '90000000-0000-0000-0000-000000000001'
      and name = 'Legacy quality'
  ) then
    raise exception 'legacy quality was not preserved';
  end if;

  if not exists (
    select 1
    from public.goals
    where id = '93000000-0000-0000-0000-000000000001'
      and user_id = '90000000-0000-0000-0000-000000000001'
      and area_id = '91000000-0000-0000-0000-000000000001'
      and title = 'Legacy goal retained'
      and description = 'Description retained through the upgrade'
      and priority = 'high'
      and notes = 'Legacy notes retained'
      and evidence = '["Legacy evidence note"]'::jsonb
  ) then
    raise exception 'legacy goal fields were not preserved';
  end if;

  if not exists (
    select 1
    from public.goal_stats
    where goal_id = '93000000-0000-0000-0000-000000000001'
      and stat_id = '92000000-0000-0000-0000-000000000001'
      and user_id = '90000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'legacy goal-quality connection was not preserved';
  end if;

  if not exists (
    select 1
    from public.progress_metrics
    where id = '94000000-0000-0000-0000-000000000001'
      and goal_id = '93000000-0000-0000-0000-000000000001'
      and label = 'Legacy metric'
      and current_value = 12
      and target_value = 20
      and unit = 'sessions'
      and weight = 75
      and period is null
      and period_key is null
  ) then
    raise exception 'legacy metric was not preserved';
  end if;

  if not exists (
    select 1
    from public.metric_entries
    where id = '94100000-0000-0000-0000-000000000001'
      and user_id = '90000000-0000-0000-0000-000000000001'
      and goal_id = '93000000-0000-0000-0000-000000000001'
      and metric_id = '94000000-0000-0000-0000-000000000001'
      and value = 12
      and previous_value = 10
      and source = 'manual'
      and period_key is null
      and note = 'Legacy measurement retained'
  ) then
    raise exception 'legacy metric entry was not backfilled correctly';
  end if;

  if not exists (
    select 1
    from public.milestones
    where id = '95000000-0000-0000-0000-000000000001'
      and goal_id = '93000000-0000-0000-0000-000000000001'
      and title = 'Legacy milestone retained'
      and weight = 40
      and completed
      and sort_order = 3
  ) then
    raise exception 'legacy milestone was not preserved';
  end if;

  if not exists (
    select 1
    from public.quests
    where id = '96000000-0000-0000-0000-000000000001'
      and goal_id = '93000000-0000-0000-0000-000000000001'
      and title = 'Legacy action retained'
      and description = 'Legacy action description'
      and kind = 'task'
      and cardinality(linked_goal_ids) = 0
      and repeat_rule = 'weekly'
      and duration_minutes = 45
      and metric_deltas = '[{"metricId":"94000000-0000-0000-0000-000000000001","amount":2}]'::jsonb
      and completed
  ) then
    raise exception 'legacy action was not preserved or defaulted correctly';
  end if;

  if not exists (
    select 1
    from public.quest_completions
    where id = '96100000-0000-0000-0000-000000000001'
      and quest_id = '96000000-0000-0000-0000-000000000001'
      and goal_id = '93000000-0000-0000-0000-000000000001'
      and title = 'Legacy action retained'
      and duration_minutes = 47
      and note = 'Legacy completion note retained'
      and evidence = '["Legacy completion evidence"]'::jsonb
      and metric_deltas = '[]'::jsonb
      and cardinality(linked_goal_ids) = 0
  ) then
    raise exception 'legacy completion was not preserved or backfilled correctly';
  end if;

  if not exists (
    select 1
    from public.reviews
    where id = '98000000-0000-0000-0000-000000000001'
      and cadence = 'weekly'
      and answers ->> 'reflection' = 'Legacy review retained'
  ) then
    raise exception 'legacy review was not preserved';
  end if;

  if not exists (
    select 1
    from public.user_settings
    where user_id = '90000000-0000-0000-0000-000000000001'
      and theme = 'light'
      and interface_intensity = 'minimal'
      and terminology ->> 'goals' = 'Outcomes'
      and dashboard_preferences -> 'order' = '["goals"]'::jsonb
      and notifications
  ) then
    raise exception 'legacy non-scoring settings were not preserved';
  end if;

  if not exists (
    select 1
    from public.workspace_snapshots
    where user_id = '90000000-0000-0000-0000-000000000001'
      and state = '{"version":3,"fixture":"legacy-upgrade-preserved"}'::jsonb
      and revision = 0
  ) then
    raise exception 'legacy workspace snapshot was not preserved or revisioned';
  end if;

  if not exists (
    select 1
    from public.account_lifecycle
    where user_id = '90000000-0000-0000-0000-000000000001'
      and status = 'active'
      and deletion_started_at is null
      and evidence_revision = 0
  ) then
    raise exception 'existing account did not receive an active lifecycle row and evidence boundary';
  end if;

  if not exists (
    select 1
    from storage.buckets
    where id = 'evidence'
      and name = 'evidence'
      and not public
      and file_size_limit = 10485760
      and allowed_mime_types @> array['image/jpeg','image/png','image/webp','application/pdf','text/plain']::text[]
  ) then
    raise exception 'private evidence bucket contract did not converge';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.workspace_snapshots'::regclass
      and tgname = 'set_workspace_snapshots_updated_at'
      and not tgisinternal
  ) then
    raise exception 'workspace updated-at trigger is missing';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'storage.objects'::regclass
      and tgname = 'bump_evolvra_evidence_revision'
      and not tgisinternal
  ) then
    raise exception 'evidence revision trigger is missing after the upgrade';
  end if;

  if to_regprocedure('public.read_account_erasure_backup_boundary(uuid)') is null
     or to_regprocedure('public.begin_account_deletion(uuid,bigint,bigint)') is null
     or to_regprocedure('public.begin_account_deletion(uuid)') is null
     or to_regprocedure('public.claim_evidence_cleanup(uuid,text[])') is null
     or to_regprocedure('public.save_workspace_snapshot(uuid,jsonb,bigint)') is null
     or to_regprocedure('public.save_workspace_snapshot(jsonb,bigint)') is null
     or to_regprocedure('private.evidence_path_writes_allowed(text,text)') is null
     or to_regprocedure('private.evidence_deletes_allowed(text,text)') is null
     or to_regprocedure('private.workspace_state_references_evidence_path(jsonb,text)') is null then
    raise exception 'account-bound snapshot, cleanup claim, erasure boundary, or policy helper is missing after the upgrade';
  end if;

  if to_regprocedure('private.evidence_writes_allowed()') is not null
     or to_regprocedure('private.evidence_deletes_allowed()') is not null then
    raise exception 'retired zero-argument evidence policy helpers survived the upgrade';
  end if;

  if has_table_privilege('anon', 'private.evidence_cleanup_claims', 'select')
     or has_table_privilege('authenticated', 'private.evidence_cleanup_claims', 'select')
     or has_table_privilege('authenticated', 'private.evidence_cleanup_claims', 'insert')
     or has_table_privilege('authenticated', 'private.evidence_cleanup_claims', 'update')
     or has_table_privilege('authenticated', 'private.evidence_cleanup_claims', 'delete') then
    raise exception 'upgraded evidence cleanup claims are not RPC-only for clients';
  end if;

  if not has_table_privilege('service_role', 'private.evidence_cleanup_claims', 'select')
     or has_table_privilege('service_role', 'private.evidence_cleanup_claims', 'insert')
     or has_table_privilege('service_role', 'private.evidence_cleanup_claims', 'update')
     or has_table_privilege('service_role', 'private.evidence_cleanup_claims', 'delete')
     or has_table_privilege('service_role', 'private.evidence_cleanup_claims', 'truncate')
     or has_table_privilege('service_role', 'private.evidence_cleanup_claims', 'references')
     or has_table_privilege('service_role', 'private.evidence_cleanup_claims', 'trigger') then
    raise exception 'upgraded service-role evidence cleanup claim privileges are not SELECT only';
  end if;

  if has_function_privilege('anon', 'public.claim_evidence_cleanup(uuid,text[])', 'execute')
     or not has_function_privilege('authenticated', 'public.claim_evidence_cleanup(uuid,text[])', 'execute')
     or has_function_privilege('authenticated', 'private.workspace_state_references_evidence_path(jsonb,text)', 'execute') then
    raise exception 'upgraded cleanup claim function privileges did not converge';
  end if;

  if exists (
    select 1
    from private.evidence_cleanup_claims
    where user_id = '90000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'the legacy fixture unexpectedly received an evidence cleanup claim';
  end if;
end;
$$;

insert into private.evidence_cleanup_claims (user_id, remote_path)
values (
  '90000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001/legacy-goal/legacy-evidence/proof.txt'
);

delete from auth.users
where id = '90000000-0000-0000-0000-000000000001';

do $$
begin
  if exists (
    select 1
    from public.profiles
    where id = '90000000-0000-0000-0000-000000000001'
  ) or exists (
    select 1
    from public.workspace_snapshots
    where user_id = '90000000-0000-0000-0000-000000000001'
  ) or exists (
    select 1
    from public.account_lifecycle
    where user_id = '90000000-0000-0000-0000-000000000001'
  ) or exists (
    select 1
    from private.evidence_cleanup_claims
    where user_id = '90000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'legacy fixture cleanup did not cascade';
  end if;
end;
$$;

commit;

select 'Legacy upgrade preservation assertions passed' as result;
