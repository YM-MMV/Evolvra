-- Align existing normalised records with the non-points v2 activity history.

create table if not exists public.goal_check_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  note text not null check (char_length(note) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index if not exists goal_check_ins_goal_time_idx
  on public.goal_check_ins(goal_id, created_at desc);

alter table public.goal_check_ins enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'goal_check_ins'
      and policyname = 'owner access'
  ) then
    create policy "owner access" on public.goal_check_ins
      for all using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end
$$;

alter table if exists public.metric_entries
  add column if not exists goal_id uuid references public.goals(id) on delete cascade,
  add column if not exists previous_value numeric(16,3),
  add column if not exists source text not null default 'manual';

update public.metric_entries as entries
set goal_id = metrics.goal_id
from public.progress_metrics as metrics
where entries.metric_id = metrics.id
  and entries.goal_id is null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'metric_entries'
      and column_name = 'delta'
  ) then
    execute 'update public.metric_entries set previous_value = coalesce(value - delta, value) where previous_value is null';
  else
    update public.metric_entries set previous_value = value where previous_value is null;
  end if;
end
$$;

alter table if exists public.metric_entries
  alter column goal_id set not null,
  alter column previous_value set not null,
  drop column if exists delta;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'metric_entries_source_check'
      and conrelid = 'public.metric_entries'::regclass
  ) then
    alter table public.metric_entries
      add constraint metric_entries_source_check check (source in ('manual', 'quest'));
  end if;
end
$$;

alter table if exists public.quest_completions
  add column if not exists title text;

update public.quest_completions as completions
set title = quests.title
from public.quests as quests
where completions.quest_id = quests.id
  and completions.title is null;

alter table if exists public.quest_completions
  alter column title set not null;
