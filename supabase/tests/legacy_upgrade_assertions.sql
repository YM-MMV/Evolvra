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
      ('workspace_snapshots', 'revision')
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
     or to_regclass('public.account_lifecycle') is null then
    raise exception 'current history or lifecycle tables are missing';
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
      and game_intensity = 'minimal'
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
  ) then
    raise exception 'existing account did not receive an active lifecycle row';
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
end;
$$;

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
  ) then
    raise exception 'legacy fixture cleanup did not cascade';
  end if;
end;
$$;

commit;

select 'Legacy upgrade preservation assertions passed' as result;
