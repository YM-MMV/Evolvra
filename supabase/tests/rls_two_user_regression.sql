\set ON_ERROR_STOP on

-- Run after all migrations with a database-owner connection, for example:
--   supabase db reset
--   psql "$DATABASE_URL" -f supabase/tests/rls_two_user_regression.sql
--
-- The entire test is transactional. It creates two temporary auth users,
-- switches to the authenticated API role, proves owner operations work, proves
-- cross-owner reads and parent references fail, verifies private evidence path
-- isolation, and finally exercises delete_my_account(). Nothing is retained.

begin;

grant usage on schema auth, storage to authenticated;
grant execute on function auth.uid() to authenticated;
grant execute on function storage.foldername(text) to authenticated;
grant select, insert, update, delete on table storage.objects to authenticated;

create function pg_temp.expect_denied(test_name text, statement text)
returns void
language plpgsql
security invoker
as $$
declare
  was_denied boolean := false;
begin
  begin
    execute statement;
  exception
    when insufficient_privilege or with_check_option_violation then
      was_denied := true;
  end;

  if not was_denied then
    raise exception 'Expected authorization failure: %', test_name;
  end if;
end;
$$;

create function pg_temp.expect_sqlstate(test_name text, statement text, expected_state text)
returns void
language plpgsql
security invoker
as $$
declare
  actual_state text;
begin
  begin
    execute statement;
  exception
    when others then
      get stacked diagnostics actual_state = returned_sqlstate;
  end;

  if actual_state is distinct from expected_state then
    raise exception 'Expected SQLSTATE % for %, received %', expected_state, test_name, coalesce(actual_state, 'no error');
  end if;
end;
$$;

-- These UUIDs are reserved for this rolled-back test only.
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
values
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-0000000000a1',
    'authenticated',
    'authenticated',
    'rls-a@example.invalid',
    crypt('not-a-real-password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"RLS A"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-0000000000b2',
    'authenticated',
    'authenticated',
    'rls-b@example.invalid',
    crypt('not-a-real-password', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"RLS B"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

-- Seed one complete graph for each owner as the database owner. User A creates
-- a second graph through RLS below; user B's graph is the adversarial target.
insert into public.areas (id, user_id, name)
values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'A area'),
  ('10000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'B area');

insert into public.stats (id, user_id, name)
values
  ('20000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'A quality'),
  ('20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'B quality');

insert into public.goals (id, user_id, area_id, title, model)
values
  ('30000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', 'A goal', 'numeric'),
  ('30000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', '10000000-0000-0000-0000-0000000000b2', 'B goal', 'numeric');

insert into public.goal_stats (goal_id, stat_id, user_id)
values
  ('30000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1'),
  ('30000000-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2');

insert into public.goal_check_ins (id, user_id, goal_id, note)
values
  ('31000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a1', 'A check-in'),
  ('31000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', '30000000-0000-0000-0000-0000000000b2', 'B check-in');

insert into public.progress_metrics (id, user_id, goal_id, label, current_value, target_value)
values
  ('40000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a1', 'A metric', 1, 10),
  ('40000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', '30000000-0000-0000-0000-0000000000b2', 'B metric', 1, 10);

insert into public.metric_entries (id, user_id, goal_id, metric_id, value, previous_value)
values
  ('41000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000a1', 1, 0),
  ('41000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', '30000000-0000-0000-0000-0000000000b2', '40000000-0000-0000-0000-0000000000b2', 1, 0);

insert into public.milestones (id, user_id, goal_id, title)
values
  ('42000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a1', 'A milestone'),
  ('42000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', '30000000-0000-0000-0000-0000000000b2', 'B milestone');

insert into public.quests (id, user_id, goal_id, title)
values
  ('50000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a1', 'A quest'),
  ('50000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', '30000000-0000-0000-0000-0000000000b2', 'B quest');

insert into public.quest_completions (id, user_id, quest_id, goal_id, title)
values
  ('51000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a1', 'A quest'),
  ('51000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', '50000000-0000-0000-0000-0000000000b2', '30000000-0000-0000-0000-0000000000b2', 'B quest');

insert into public.reviews (id, user_id, cadence)
values
  ('60000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'weekly'),
  ('60000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b2', 'weekly');

insert into public.workspace_snapshots (user_id, state)
values
  ('00000000-0000-0000-0000-0000000000a1', '{"version":3,"owner":"a"}'::jsonb),
  ('00000000-0000-0000-0000-0000000000b2', '{"version":3,"owner":"b"}'::jsonb);

insert into storage.objects (id, bucket_id, name)
values
  ('70000000-0000-0000-0000-0000000000a1', 'evidence', '00000000-0000-0000-0000-0000000000a1/seed-a.txt'),
  ('70000000-0000-0000-0000-0000000000b2', 'evidence', '00000000-0000-0000-0000-0000000000b2/seed-b.txt');

do $$
declare
  table_name text;
begin
  if has_function_privilege('anon', 'public.delete_my_account(uuid)', 'execute') then
    raise exception 'anon must not execute delete_my_account(uuid)';
  end if;
  if has_function_privilege('anon', 'public.save_workspace_snapshot(jsonb,bigint)', 'execute') then
    raise exception 'anon must not execute save_workspace_snapshot(jsonb,bigint)';
  end if;
  if has_function_privilege('anon', 'public.begin_account_deletion(uuid)', 'execute') then
    raise exception 'anon must not execute begin_account_deletion(uuid)';
  end if;
  if has_function_privilege('anon', 'private.evidence_writes_allowed()', 'execute') then
    raise exception 'anon must not execute private.evidence_writes_allowed()';
  end if;
  if not has_function_privilege('authenticated', 'public.delete_my_account(uuid)', 'execute') then
    raise exception 'authenticated must execute delete_my_account(uuid)';
  end if;
  if not has_function_privilege('authenticated', 'public.save_workspace_snapshot(jsonb,bigint)', 'execute') then
    raise exception 'authenticated must execute save_workspace_snapshot(jsonb,bigint)';
  end if;
  if not has_function_privilege('authenticated', 'public.begin_account_deletion(uuid)', 'execute') then
    raise exception 'authenticated must execute begin_account_deletion(uuid)';
  end if;
  if not has_function_privilege('authenticated', 'private.evidence_writes_allowed()', 'execute') then
    raise exception 'authenticated must execute the internal evidence write-policy helper';
  end if;
  if has_function_privilege('authenticated', 'private.handle_new_account_lifecycle()', 'execute') then
    raise exception 'authenticated must not execute the lifecycle trigger function';
  end if;
  if has_function_privilege('authenticated', 'public.set_updated_at()', 'execute') then
    raise exception 'authenticated must not execute internal set_updated_at()';
  end if;
  if has_function_privilege('authenticated', 'public.handle_new_user()', 'execute') then
    raise exception 'authenticated must not execute internal handle_new_user()';
  end if;
  if has_function_privilege('authenticated', 'public.validate_linked_goal_ids()', 'execute') then
    raise exception 'authenticated must not execute internal validate_linked_goal_ids()';
  end if;

  if has_table_privilege('anon', 'public.workspace_snapshots', 'select')
     or has_table_privilege('anon', 'public.workspace_snapshots', 'insert')
     or has_table_privilege('anon', 'public.workspace_snapshots', 'update')
     or has_table_privilege('anon', 'public.workspace_snapshots', 'delete') then
    raise exception 'anon must have no workspace_snapshots table privileges';
  end if;
  if not has_table_privilege('authenticated', 'public.workspace_snapshots', 'select')
     or not has_table_privilege('authenticated', 'public.workspace_snapshots', 'delete')
     or has_table_privilege('authenticated', 'public.workspace_snapshots', 'insert')
     or has_table_privilege('authenticated', 'public.workspace_snapshots', 'update') then
    raise exception 'authenticated workspace_snapshots privileges are not SELECT/DELETE only';
  end if;
  if not has_table_privilege('service_role', 'public.workspace_snapshots', 'select')
     or has_table_privilege('service_role', 'public.workspace_snapshots', 'insert')
     or has_table_privilege('service_role', 'public.workspace_snapshots', 'update')
     or has_table_privilege('service_role', 'public.workspace_snapshots', 'delete') then
    raise exception 'service_role workspace_snapshots privileges are not SELECT only';
  end if;

  if has_table_privilege('anon', 'public.account_lifecycle', 'select')
     or has_table_privilege('anon', 'public.account_lifecycle', 'insert')
     or has_table_privilege('anon', 'public.account_lifecycle', 'update')
     or has_table_privilege('anon', 'public.account_lifecycle', 'delete')
     or has_table_privilege('authenticated', 'public.account_lifecycle', 'select')
     or has_table_privilege('authenticated', 'public.account_lifecycle', 'insert')
     or has_table_privilege('authenticated', 'public.account_lifecycle', 'update')
     or has_table_privilege('authenticated', 'public.account_lifecycle', 'delete') then
    raise exception 'account_lifecycle must have no direct client table privileges';
  end if;

  if (select count(*) from public.account_lifecycle where status = 'active') <> 2 then
    raise exception 'auth trigger did not create two active lifecycle rows';
  end if;

  foreach table_name in array array[
    'profiles',
    'areas',
    'stats',
    'goals',
    'goal_stats',
    'goal_check_ins',
    'progress_metrics',
    'metric_entries',
    'milestones',
    'quests',
    'quest_completions',
    'reviews',
    'user_settings'
  ]
  loop
    if has_table_privilege('anon', format('public.%I', table_name), 'select')
       or has_table_privilege('anon', format('public.%I', table_name), 'insert')
       or has_table_privilege('anon', format('public.%I', table_name), 'update')
       or has_table_privilege('anon', format('public.%I', table_name), 'delete') then
      raise exception 'anon retained privileges on public.%', table_name;
    end if;

    if not has_table_privilege('authenticated', format('public.%I', table_name), 'select')
       or not has_table_privilege('authenticated', format('public.%I', table_name), 'insert')
       or not has_table_privilege('authenticated', format('public.%I', table_name), 'update')
       or not has_table_privilege('authenticated', format('public.%I', table_name), 'delete') then
      raise exception 'authenticated lacks explicit CRUD on public.%', table_name;
    end if;
  end loop;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);

-- Every table exposes A's rows and hides B's rows.
do $$
begin
  if exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'profiles leaked'; end if;
  if exists (select 1 from public.areas where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'areas leaked'; end if;
  if exists (select 1 from public.stats where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'stats leaked'; end if;
  if exists (select 1 from public.goals where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'goals leaked'; end if;
  if exists (select 1 from public.goal_stats where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'goal_stats leaked'; end if;
  if exists (select 1 from public.goal_check_ins where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'goal_check_ins leaked'; end if;
  if exists (select 1 from public.progress_metrics where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'progress_metrics leaked'; end if;
  if exists (select 1 from public.metric_entries where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'metric_entries leaked'; end if;
  if exists (select 1 from public.milestones where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'milestones leaked'; end if;
  if exists (select 1 from public.quests where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'quests leaked'; end if;
  if exists (select 1 from public.quest_completions where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'quest_completions leaked'; end if;
  if exists (select 1 from public.reviews where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'reviews leaked'; end if;
  if exists (select 1 from public.user_settings where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'user_settings leaked'; end if;
  if exists (select 1 from public.workspace_snapshots where user_id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'workspace_snapshots leaked'; end if;
  if exists (select 1 from storage.objects where name like '00000000-0000-0000-0000-0000000000b2/%') then raise exception 'evidence leaked'; end if;
end;
$$;

-- Owner-labelled root records work; impersonating B does not.
update public.profiles set display_name = 'A updated' where id = '00000000-0000-0000-0000-0000000000a1';
update public.user_settings set notifications = true where user_id = '00000000-0000-0000-0000-0000000000a1';
do $$
declare
  affected_rows integer;
begin
  update public.profiles set display_name = 'forged' where id = '00000000-0000-0000-0000-0000000000b2';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then raise exception 'profile update crossed owner boundary'; end if;

  update public.user_settings set notifications = true where user_id = '00000000-0000-0000-0000-0000000000b2';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then raise exception 'settings update crossed owner boundary'; end if;
end;
$$;
insert into public.areas (id, user_id, name) values ('10000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', 'A second area');
insert into public.stats (id, user_id, name) values ('20000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', 'A second quality');
insert into public.reviews (id, user_id, cadence) values ('60000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', 'daily');

select pg_temp.expect_denied('area user_id', $sql$insert into public.areas (id, user_id, name) values ('10000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'forged')$sql$);
select pg_temp.expect_denied('stat user_id', $sql$insert into public.stats (id, user_id, name) values ('20000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'forged')$sql$);
select pg_temp.expect_denied('review user_id', $sql$insert into public.reviews (id, user_id, cadence) values ('60000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'daily')$sql$);

-- Goals may only reference the caller's area.
insert into public.goals (id, user_id, area_id, title, model)
values ('30000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a3', 'A second goal', 'numeric');
select pg_temp.expect_denied('goal cross-owner area', $sql$insert into public.goals (id, user_id, area_id, title, model) values ('30000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000b2', 'forged', 'numeric')$sql$);
select pg_temp.expect_denied('goal update cross-owner area', $sql$update public.goals set area_id = '10000000-0000-0000-0000-0000000000b2' where id = '30000000-0000-0000-0000-0000000000a3'$sql$);

-- Every goal child rejects a parent owned by B. Multi-parent rows also require
-- both parents to belong to A and to describe the same goal.
insert into public.goal_stats (goal_id, stat_id, user_id)
values ('30000000-0000-0000-0000-0000000000a3', '20000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_denied('goal_stats cross-owner goal', $sql$insert into public.goal_stats (goal_id, stat_id, user_id) values ('30000000-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1')$sql$);
select pg_temp.expect_denied('goal_stats cross-owner stat', $sql$insert into public.goal_stats (goal_id, stat_id, user_id) values ('30000000-0000-0000-0000-0000000000a3', '20000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1')$sql$);

insert into public.goal_check_ins (id, user_id, goal_id, note)
values ('31000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a3', 'Allowed');
select pg_temp.expect_denied('check-in cross-owner goal', $sql$insert into public.goal_check_ins (id, user_id, goal_id, note) values ('31000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000b2', 'forged')$sql$);

insert into public.progress_metrics (id, user_id, goal_id, label, target_value)
values ('40000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a3', 'Allowed', 10);
select pg_temp.expect_denied('metric cross-owner goal', $sql$insert into public.progress_metrics (id, user_id, goal_id, label, target_value) values ('40000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000b2', 'forged', 10)$sql$);

insert into public.metric_entries (id, user_id, goal_id, metric_id, value, previous_value)
values ('41000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000a3', 2, 1);
select pg_temp.expect_denied('entry cross-owner goal and metric', $sql$insert into public.metric_entries (id, user_id, goal_id, metric_id, value, previous_value) values ('41000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000b2', '40000000-0000-0000-0000-0000000000b2', 2, 1)$sql$);
select pg_temp.expect_denied('entry mismatched metric goal', $sql$insert into public.metric_entries (id, user_id, goal_id, metric_id, value, previous_value) values ('41000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a3', '40000000-0000-0000-0000-0000000000a1', 2, 1)$sql$);

insert into public.milestones (id, user_id, goal_id, title)
values ('42000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a3', 'Allowed');
select pg_temp.expect_denied('milestone cross-owner goal', $sql$insert into public.milestones (id, user_id, goal_id, title) values ('42000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000b2', 'forged')$sql$);

insert into public.quests (id, user_id, goal_id, linked_goal_ids, title)
values (
  '50000000-0000-0000-0000-0000000000a3',
  '00000000-0000-0000-0000-0000000000a1',
  '30000000-0000-0000-0000-0000000000a3',
  array['30000000-0000-0000-0000-0000000000a1'::uuid],
  'Allowed'
);
select pg_temp.expect_denied('quest cross-owner goal', $sql$insert into public.quests (id, user_id, goal_id, title) values ('50000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000b2', 'forged')$sql$);
select pg_temp.expect_sqlstate('quest cross-owner linked goal', $sql$update public.quests set linked_goal_ids = array['30000000-0000-0000-0000-0000000000b2'::uuid] where id = '50000000-0000-0000-0000-0000000000a3'$sql$, '23514');
select pg_temp.expect_sqlstate('quest primary goal repeated as linked goal', $sql$update public.quests set linked_goal_ids = array['30000000-0000-0000-0000-0000000000a3'::uuid] where id = '50000000-0000-0000-0000-0000000000a3'$sql$, '23514');
select pg_temp.expect_sqlstate('quest duplicate linked goals', $sql$update public.quests set linked_goal_ids = array['30000000-0000-0000-0000-0000000000a1'::uuid, '30000000-0000-0000-0000-0000000000a1'::uuid] where id = '50000000-0000-0000-0000-0000000000a3'$sql$, '23514');

insert into public.quest_completions (id, user_id, quest_id, goal_id, linked_goal_ids, title)
values (
  '51000000-0000-0000-0000-0000000000a3',
  '00000000-0000-0000-0000-0000000000a1',
  '50000000-0000-0000-0000-0000000000a3',
  '30000000-0000-0000-0000-0000000000a3',
  array['30000000-0000-0000-0000-0000000000a1'::uuid],
  'Allowed'
);
select pg_temp.expect_denied('completion cross-owner parents', $sql$insert into public.quest_completions (id, user_id, quest_id, goal_id, title) values ('51000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000b2', '30000000-0000-0000-0000-0000000000b2', 'forged')$sql$);
select pg_temp.expect_denied('completion mismatched quest goal', $sql$insert into public.quest_completions (id, user_id, quest_id, goal_id, title) values ('51000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-0000000000a3', 'forged')$sql$);
select pg_temp.expect_sqlstate('completion cross-owner linked goal', $sql$update public.quest_completions set linked_goal_ids = array['30000000-0000-0000-0000-0000000000b2'::uuid] where id = '51000000-0000-0000-0000-0000000000a3'$sql$, '23514');

-- Direct snapshot writes stay closed; the authenticated compare-and-swap RPC
-- can update only A's document.
select pg_temp.expect_denied('direct snapshot update', $sql$update public.workspace_snapshots set state = '{"forged":true}'::jsonb where user_id = '00000000-0000-0000-0000-0000000000a1'$sql$);
do $$
declare
  saved_state jsonb;
  saved_revision bigint;
begin
  select state, revision into saved_state, saved_revision
  from public.save_workspace_snapshot('{"version":3,"owner":"a","saved":true}'::jsonb, 0);
  if saved_revision <> 1 then
    raise exception 'workspace RPC returned revision %, expected 1', saved_revision;
  end if;
  if saved_state ->> 'version' <> '3' or saved_state ->> 'owner' <> 'a' then
    raise exception 'workspace RPC did not preserve the state-v3 snapshot';
  end if;
  if (select state ->> 'owner' from public.workspace_snapshots where user_id = '00000000-0000-0000-0000-0000000000b2') <> 'b' then
    raise exception 'workspace RPC changed the other account snapshot';
  end if;
end;
$$;
select pg_temp.expect_sqlstate(
  'stale workspace revision',
  $sql$select * from public.save_workspace_snapshot('{"version":3,"owner":"a","stale":true}'::jsonb, 0)$sql$,
  'PT409'
);

-- Evidence paths are private on select/insert/delete and cannot be moved into
-- a different account's folder through UPDATE.
insert into storage.objects (id, bucket_id, name)
values ('70000000-0000-0000-0000-0000000000a3', 'evidence', '00000000-0000-0000-0000-0000000000a1/allowed.txt');
select pg_temp.expect_denied('evidence cross-owner upload', $sql$insert into storage.objects (id, bucket_id, name) values ('70000000-0000-0000-0000-0000000000f1', 'evidence', '00000000-0000-0000-0000-0000000000b2/forged.txt')$sql$);
select pg_temp.expect_denied('evidence cross-owner move', $sql$update storage.objects set name = '00000000-0000-0000-0000-0000000000b2/moved.txt' where id = '70000000-0000-0000-0000-0000000000a3'$sql$);
select pg_temp.expect_sqlstate(
  'direct evidence metadata delete requires Storage API marker',
  $sql$delete from storage.objects where id = '70000000-0000-0000-0000-0000000000a3'$sql$,
  '42501'
);
insert into storage.objects (id, bucket_id, name)
values ('70000000-0000-0000-0000-0000000000a4', 'evidence', '00000000-0000-0000-0000-0000000000a1/delete-with-account.txt');

-- Lifecycle state cannot be forged or cleared through direct table access, and
-- the final RPC cannot skip phase one or the Storage sweep.
select pg_temp.expect_denied('direct lifecycle insert', $sql$insert into public.account_lifecycle (user_id, status) values ('00000000-0000-0000-0000-0000000000b2', 'deleting') on conflict (user_id) do update set status = excluded.status$sql$);
select pg_temp.expect_denied('direct lifecycle update', $sql$update public.account_lifecycle set status = 'active' where user_id = '00000000-0000-0000-0000-0000000000a1'$sql$);
select pg_temp.expect_sqlstate(
  'begin cannot nominate another account',
  $sql$select public.begin_account_deletion('00000000-0000-0000-0000-0000000000b2')$sql$,
  '42501'
);
select pg_temp.expect_sqlstate(
  'delete cannot nominate another account',
  $sql$select public.delete_my_account('00000000-0000-0000-0000-0000000000b2')$sql$,
  '42501'
);
select pg_temp.expect_sqlstate(
  'delete without lifecycle transition',
  $sql$select public.delete_my_account('00000000-0000-0000-0000-0000000000a1')$sql$,
  '55000'
);

-- Phase one takes a conflicting row lock, waits for existing evidence writes,
-- and commits a deleting state in production. This same-user request models a
-- second valid session after that transition: upload is denied and UPDATE can
-- no longer see a writable row, while SELECT/DELETE remain available to sweep.
select public.begin_account_deletion('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_sqlstate(
  'snapshot CAS write after deletion begins',
  $sql$select * from public.save_workspace_snapshot('{"version":3,"owner":"a","stale-tab":true}'::jsonb, 1)$sql$,
  '55000'
);
select pg_temp.expect_denied('evidence upload after deletion begins', $sql$insert into storage.objects (id, bucket_id, name) values ('70000000-0000-0000-0000-0000000000f3', 'evidence', '00000000-0000-0000-0000-0000000000a1/racing-upload.txt')$sql$);
do $$
declare
  affected_rows integer;
begin
  update storage.objects
  set name = '00000000-0000-0000-0000-0000000000a1/racing-update.txt'
  where id = '70000000-0000-0000-0000-0000000000a4';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'evidence update remained writable after deletion began';
  end if;
end;
$$;
select pg_temp.expect_sqlstate(
  'delete while evidence remains',
  $sql$select public.delete_my_account('00000000-0000-0000-0000-0000000000a1')$sql$,
  '55000'
);

-- The application removes evidence through the Storage API after the lifecycle
-- fence is committed. Supabase's Storage API sets this transaction-local marker
-- before its authenticated metadata DELETE; scope the same marker narrowly here
-- so the test still exercises the delete RLS policy without orphaning a real
-- object. The deliberately broad predicate also targets B's fixture; the final
-- assertions prove that RLS limits the delete to A. Production application SQL
-- never deletes Storage rows directly.
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects
where bucket_id = 'evidence';
select set_config('storage.allow_delete_query', 'false', true);

-- Phase two checks the prefix is empty, then removes only A's auth row and
-- cascaded application/lifecycle rows. The expected UUID is checked against
-- auth.uid(), so A cannot nominate B.
select public.delete_my_account('00000000-0000-0000-0000-0000000000a1');
reset role;
select set_config('request.jwt.claim.sub', '', true);

-- A stale JWT cannot upload after account deletion because the write guard
-- requires both an auth user and an active lifecycle row.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.expect_denied('evidence upload from stale JWT', $sql$insert into storage.objects (id, bucket_id, name) values ('70000000-0000-0000-0000-0000000000f4', 'evidence', '00000000-0000-0000-0000-0000000000a1/stale-jwt.txt')$sql$);
-- A client that lost the successful final response can safely replay both
-- phases with the same still-valid JWT subject. Both calls are idempotent.
select public.begin_account_deletion('00000000-0000-0000-0000-0000000000a1');
select public.delete_my_account('00000000-0000-0000-0000-0000000000a1');
reset role;
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  if exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A auth row survived deletion'; end if;
  if not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000b2') then raise exception 'B auth row was deleted'; end if;
  if exists (select 1 from public.profiles where id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A profile survived cascade'; end if;
  if exists (select 1 from public.areas where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A areas survived cascade'; end if;
  if exists (select 1 from public.stats where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A stats survived cascade'; end if;
  if exists (select 1 from public.goals where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A goals survived cascade'; end if;
  if exists (select 1 from public.goal_stats where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A goal_stats survived cascade'; end if;
  if exists (select 1 from public.goal_check_ins where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A check-ins survived cascade'; end if;
  if exists (select 1 from public.progress_metrics where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A metrics survived cascade'; end if;
  if exists (select 1 from public.metric_entries where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A entries survived cascade'; end if;
  if exists (select 1 from public.milestones where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A milestones survived cascade'; end if;
  if exists (select 1 from public.quests where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A quests survived cascade'; end if;
  if exists (select 1 from public.quest_completions where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A completions survived cascade'; end if;
  if exists (select 1 from public.reviews where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A reviews survived cascade'; end if;
  if exists (select 1 from public.user_settings where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A settings survived cascade'; end if;
  if exists (select 1 from public.workspace_snapshots where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A workspace survived cascade'; end if;
  if exists (select 1 from public.account_lifecycle where user_id = '00000000-0000-0000-0000-0000000000a1') then raise exception 'A lifecycle row survived cascade'; end if;
  if not exists (select 1 from public.account_lifecycle where user_id = '00000000-0000-0000-0000-0000000000b2' and status = 'active') then raise exception 'B active lifecycle row was deleted or changed'; end if;
  if exists (select 1 from storage.objects where bucket_id = 'evidence' and name like '00000000-0000-0000-0000-0000000000a1/%') then raise exception 'A evidence survived deletion'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'evidence' and name = '00000000-0000-0000-0000-0000000000b2/seed-b.txt') then raise exception 'B evidence was deleted'; end if;
end;
$$;

select 'RLS two-user regression passed' as result;
rollback;
