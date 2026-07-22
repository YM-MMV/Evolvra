-- Allow one action to support additional goals while retaining a single
-- primary goal for ownership, scheduling, metric updates, and display order.
-- Completion rows snapshot the same connections so later action edits cannot
-- rewrite historical context.

alter table if exists public.quests
  add column if not exists linked_goal_ids uuid[] not null default '{}'::uuid[];

alter table if exists public.quest_completions
  add column if not exists linked_goal_ids uuid[] not null default '{}'::uuid[];

comment on column public.quests.linked_goal_ids is
  'Additional same-owner goals supported by this action; goal_id remains primary.';

comment on column public.quest_completions.linked_goal_ids is
  'Immutable snapshot of additional goal connections when the action was completed.';

create or replace function public.validate_linked_goal_ids()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  distinct_goal_count integer;
  owned_goal_count integer;
begin
  if array_position(new.linked_goal_ids, null) is not null then
    raise exception using
      errcode = '23514',
      message = 'linked_goal_ids cannot contain null values';
  end if;

  if new.goal_id = any(new.linked_goal_ids) then
    raise exception using
      errcode = '23514',
      message = 'linked_goal_ids cannot contain the primary goal';
  end if;

  select count(*)
    into distinct_goal_count
  from (
    select distinct linked_goal_id
    from unnest(new.linked_goal_ids) as linked_goal(linked_goal_id)
  ) as unique_linked_goals;

  if distinct_goal_count <> cardinality(new.linked_goal_ids) then
    raise exception using
      errcode = '23514',
      message = 'linked_goal_ids cannot contain duplicate goals';
  end if;

  select count(*)
    into owned_goal_count
  from public.goals as linked_goal
  where linked_goal.id = any(new.linked_goal_ids)
    and linked_goal.user_id = new.user_id;

  if owned_goal_count <> cardinality(new.linked_goal_ids) then
    raise exception using
      errcode = '23514',
      message = 'linked_goal_ids must reference goals owned by the same user';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_linked_goal_ids() from public, anon, authenticated;

drop trigger if exists validate_quest_linked_goal_ids on public.quests;
create trigger validate_quest_linked_goal_ids
  before insert or update of linked_goal_ids, goal_id, user_id
  on public.quests
  for each row execute function public.validate_linked_goal_ids();

drop trigger if exists validate_completion_linked_goal_ids on public.quest_completions;
create trigger validate_completion_linked_goal_ids
  before insert or update of linked_goal_ids, goal_id, user_id
  on public.quest_completions
  for each row execute function public.validate_linked_goal_ids();
