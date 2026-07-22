-- Preserve calendar-window and per-occurrence context in the optional
-- normalised analytics tables. Workspace snapshots remain authoritative.

alter table public.progress_metrics
  add column if not exists period text,
  add column if not exists period_key text;

alter table public.progress_metrics
  drop constraint if exists progress_metrics_period_check;

alter table public.progress_metrics
  add constraint progress_metrics_period_check
  check (period is null or period in ('week', 'month', 'quarter', 'year'));

alter table public.metric_entries
  add column if not exists period_key text;

alter table public.quest_completions
  add column if not exists metric_deltas jsonb not null default '[]'::jsonb;
