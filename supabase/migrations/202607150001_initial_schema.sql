-- Evolvra private application schema
-- Run with `supabase db push` or paste into the Supabase SQL editor.

create extension if not exists pgcrypto;

create type public.goal_status as enum ('active', 'paused', 'completed', 'archived');
create type public.goal_model as enum ('numeric', 'weighted', 'consistency', 'open');
create type public.review_cadence as enum ('daily', 'weekly', 'monthly');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  current_chapter text not null default 'Building a life with direction',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.areas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  color text not null default '#48A9FF',
  icon text not null default 'Compass',
  sort_order integer not null default 0,
  hidden boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  color text not null default '#55E6BD',
  icon text not null default 'Sparkles',
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  area_id uuid references public.areas(id) on delete set null,
  title text not null check (char_length(title) between 1 and 240),
  description text not null default '',
  model public.goal_model not null,
  status public.goal_status not null default 'active',
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  target_date date,
  notes text not null default '',
  evidence jsonb not null default '[]'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.goal_stats (
  goal_id uuid not null references public.goals(id) on delete cascade,
  stat_id uuid not null references public.stats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (goal_id, stat_id)
);

create table public.goal_check_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  note text not null check (char_length(note) between 1 and 5000),
  created_at timestamptz not null default now()
);

create table public.progress_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  label text not null,
  current_value numeric(16,3) not null default 0,
  target_value numeric(16,3) not null check (target_value > 0),
  unit text not null default '',
  weight numeric(5,2) not null default 100 check (weight >= 0 and weight <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.metric_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  metric_id uuid not null references public.progress_metrics(id) on delete cascade,
  value numeric(16,3) not null,
  previous_value numeric(16,3) not null,
  source text not null default 'manual' check (source in ('manual', 'quest')),
  note text,
  recorded_at timestamptz not null default now()
);

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  title text not null,
  weight numeric(5,2) not null default 0 check (weight >= 0 and weight <= 100),
  completed boolean not null default false,
  completed_at timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.quests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  title text not null,
  description text,
  due_date date,
  repeat_rule text not null default 'none' check (repeat_rule in ('none', 'daily', 'weekly', 'monthly')),
  duration_minutes integer check (duration_minutes >= 0),
  metric_deltas jsonb not null default '[]'::jsonb,
  completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.quest_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  quest_id uuid not null references public.quests(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  title text not null,
  duration_minutes integer check (duration_minutes >= 0),
  note text,
  evidence jsonb not null default '[]'::jsonb,
  completed_at timestamptz not null default now()
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cadence public.review_cadence not null,
  answers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  theme text not null default 'dark' check (theme in ('dark', 'light', 'system')),
  game_intensity text not null default 'balanced' check (game_intensity in ('minimal', 'balanced', 'immersive')),
  birth_date date,
  terminology jsonb not null default '{}'::jsonb,
  dashboard_preferences jsonb not null default '{}'::jsonb,
  notifications boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Local-first clients sync through one atomic document. Normalised tables above are
-- retained for analytics, integrations, and future server-side workflows.
create table public.workspace_snapshots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create index areas_user_idx on public.areas(user_id, sort_order);
create index stats_user_idx on public.stats(user_id);
create index goals_user_status_idx on public.goals(user_id, status);
create index goals_area_idx on public.goals(area_id);
create index goal_check_ins_goal_time_idx on public.goal_check_ins(goal_id, created_at desc);
create index metrics_goal_idx on public.progress_metrics(goal_id);
create index metric_entries_metric_time_idx on public.metric_entries(metric_id, recorded_at desc);
create index milestones_goal_idx on public.milestones(goal_id, sort_order);
create index quests_goal_due_idx on public.quests(goal_id, due_date);
create index quest_completions_user_time_idx on public.quest_completions(user_id, completed_at desc);
create index reviews_user_time_idx on public.reviews(user_id, created_at desc);

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

do $$
declare table_name text;
begin
  foreach table_name in array array['profiles','areas','stats','goals','progress_metrics','milestones','quests','reviews','user_settings']
  loop
    execute format('create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name, table_name);
  end loop;
end $$;

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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Used by the in-app account deletion control. Cascades remove every row owned by
-- the caller. The function never accepts a target user id.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;
revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

-- RLS: every exposed row is private to its owner.
alter table public.profiles enable row level security;
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

create policy "owner access" on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy "owner access" on public.areas for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.stats for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.goals for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.goal_stats for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.goal_check_ins for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.progress_metrics for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.metric_entries for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.milestones for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.quests for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.quest_completions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.reviews for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.user_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "owner access" on public.workspace_snapshots for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Optional private evidence uploads.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf','text/plain'])
on conflict (id) do nothing;

create policy "users read own evidence" on storage.objects for select to authenticated
using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users upload own evidence" on storage.objects for insert to authenticated
with check (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users update own evidence" on storage.objects for update to authenticated
using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users delete own evidence" on storage.objects for delete to authenticated
using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
