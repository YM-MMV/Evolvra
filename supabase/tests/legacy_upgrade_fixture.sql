\set ON_ERROR_STOP on

-- Run immediately after resetting through the immutable initial migration.
-- This seeds representative records in the original schema so later migrations
-- must prove that useful data survives while retired mechanics are removed.

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
values (
  '00000000-0000-0000-0000-000000000000',
  '90000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'legacy-upgrade@example.invalid',
  crypt('not-a-real-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Legacy Upgrade User"}'::jsonb,
  now(),
  now(),
  '',
  '',
  '',
  ''
);

update public.profiles
set current_chapter = 'Legacy chapter retained',
    overall_xp = 987.5
where id = '90000000-0000-0000-0000-000000000001';

update public.user_settings
set theme = 'light',
    game_intensity = 'minimal',
    terminology = '{"goals":"Outcomes"}'::jsonb,
    scoring = '{"questCap":250}'::jsonb,
    dashboard_preferences = '{"order":["goals"]}'::jsonb,
    notifications = true
where user_id = '90000000-0000-0000-0000-000000000001';

insert into public.areas (id, user_id, name, color, icon, sort_order)
values (
  '91000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  'Legacy area',
  '#123456',
  'Compass',
  7
);

insert into public.stats (id, user_id, name, color, icon, xp)
values (
  '92000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  'Legacy quality',
  '#654321',
  'Sparkles',
  345.5
);

insert into public.goals (
  id,
  user_id,
  area_id,
  title,
  description,
  model,
  priority,
  open_check_in_score,
  notes,
  evidence
)
values (
  '93000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  'Legacy goal retained',
  'Description retained through the upgrade',
  'numeric',
  'high',
  82.5,
  'Legacy notes retained',
  '["Legacy evidence note"]'::jsonb
);

insert into public.goal_stat_weights (goal_id, stat_id, user_id, weight)
values (
  '93000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  65
);

insert into public.progress_metrics (
  id,
  user_id,
  goal_id,
  label,
  current_value,
  target_value,
  unit,
  weight
)
values (
  '94000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  'Legacy metric',
  12,
  20,
  'sessions',
  75
);

insert into public.metric_entries (id, user_id, metric_id, value, delta, note)
values (
  '94100000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  '94000000-0000-0000-0000-000000000001',
  12,
  2,
  'Legacy measurement retained'
);

insert into public.milestones (id, user_id, goal_id, title, weight, xp, completed, sort_order)
values (
  '95000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  'Legacy milestone retained',
  40,
  125,
  true,
  3
);

insert into public.quests (
  id,
  user_id,
  goal_id,
  title,
  description,
  effort,
  difficulty,
  impact,
  xp,
  repeat_rule,
  duration_minutes,
  metric_deltas,
  completed
)
values (
  '96000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  'Legacy action retained',
  'Legacy action description',
  'focused',
  'difficult',
  'important',
  200,
  'weekly',
  45,
  '[{"metricId":"94000000-0000-0000-0000-000000000001","amount":2}]'::jsonb,
  true
);

insert into public.quest_completions (
  id,
  user_id,
  quest_id,
  goal_id,
  xp_awarded,
  duration_minutes,
  note,
  evidence
)
values (
  '96100000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  '96000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  200,
  47,
  'Legacy completion note retained',
  '["Legacy completion evidence"]'::jsonb
);

insert into public.xp_transactions (
  id,
  user_id,
  goal_id,
  stat_id,
  quest_completion_id,
  source_type,
  source_id,
  amount,
  note
)
values (
  '97000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '96100000-0000-0000-0000-000000000001',
  'quest',
  '96000000-0000-0000-0000-000000000001',
  200,
  'Retired transaction removed by the upgrade'
);

insert into public.reviews (id, user_id, cadence, answers)
values (
  '98000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  'weekly',
  '{"reflection":"Legacy review retained"}'::jsonb
);

insert into public.workspace_snapshots (user_id, state)
values (
  '90000000-0000-0000-0000-000000000001',
  '{"version":3,"fixture":"legacy-upgrade-preserved"}'::jsonb
);

select 'Legacy upgrade fixture seeded' as result;
