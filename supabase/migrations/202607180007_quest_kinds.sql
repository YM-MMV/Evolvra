-- Give actions an explicit semantic type without coupling type to recurrence.
-- Existing rows remain tasks; clients may opt into sessions, challenges, or
-- milestone actions independently of their one-off/repeating schedule.

alter table if exists public.quests
  add column if not exists kind text;

update public.quests
set kind = 'task'
where kind is null;

alter table if exists public.quests
  alter column kind set default 'task',
  alter column kind set not null;

alter table if exists public.quests
  drop constraint if exists quests_kind_check;

alter table if exists public.quests
  add constraint quests_kind_check
  check (kind in ('task', 'session', 'challenge', 'milestone'));
