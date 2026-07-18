-- Remove legacy gamification persistence while preserving goals, progress,
-- completions, reviews, settings, and every other non-gamification record.

drop index if exists public.xp_transactions_user_time_idx;
drop table if exists public.xp_transactions;

alter table if exists public.profiles
  drop column if exists overall_xp;

alter table if exists public.stats
  drop column if exists xp;

alter table if exists public.milestones
  drop column if exists xp;

alter table if exists public.quests
  drop column if exists xp;

alter table if exists public.quest_completions
  drop column if exists xp_awarded;

alter table if exists public.user_settings
  drop column if exists scoring;

alter table if exists public.goals
  drop column if exists open_check_in_score;

alter table if exists public.quests
  drop column if exists effort,
  drop column if exists difficulty,
  drop column if exists impact;

do $$
begin
  if to_regclass('public.goal_stat_weights') is not null
     and to_regclass('public.goal_stats') is null then
    alter table public.goal_stat_weights rename to goal_stats;
  end if;
end
$$;

alter table if exists public.goal_stats
  drop column if exists weight;
