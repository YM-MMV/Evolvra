import type { Goal, MetricEntry, QuestCompletion, TimelineEvent } from "@/lib/types";

const instant = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const sameMoment = (left: string, right: string) => {
  const leftDate = instant(left);
  const rightDate = instant(right);
  return Boolean(leftDate && rightDate && Math.abs(leftDate.getTime() - rightDate.getTime()) <= 1_000);
};

const normalized = (value: string) => value.trim().toLocaleLowerCase();

/**
 * Return the stable set of goals a shared action supports. The containing goal
 * remains first because it is the canonical home for editing and deep links.
 */
export function relatedGoalIds(primaryGoalId: string, linkedGoalIds: readonly string[] = []) {
  return [...new Set([primaryGoalId, ...linkedGoalIds].filter(Boolean))];
}

export function completionGoalIds(completion: Pick<QuestCompletion, "goalId" | "linkedGoalIds" | "goalSnapshots">) {
  return completion.goalSnapshots?.length
    ? relatedGoalIds(completion.goalId, completion.goalSnapshots.map((snapshot) => snapshot.goalId))
    : relatedGoalIds(completion.goalId, completion.linkedGoalIds);
}

export interface ActivityAttribution {
  goalIds: string[];
  areaIds: string[];
  statIds: string[];
}

/**
 * Resolve historical completion links from the strongest immutable source that
 * exists. Current v3 records carry per-goal snapshots; legacy records can use
 * their mirrored timeline event; only records predating both fall back to the
 * goal's current organisation.
 */
export function completionAttribution(
  completion: Pick<QuestCompletion, "goalId" | "linkedGoalIds" | "goalSnapshots" | "completedAt" | "title">,
  goals: readonly Pick<Goal, "id" | "areaId" | "statIds">[],
  timeline: readonly TimelineEvent[] = [],
): ActivityAttribution {
  if (completion.goalSnapshots?.length) {
    return {
      goalIds: completionGoalIds(completion),
      areaIds: [...new Set(completion.goalSnapshots.map((snapshot) => snapshot.areaId))],
      statIds: [...new Set(completion.goalSnapshots.flatMap((snapshot) => snapshot.statIds))],
    };
  }

  const candidates = timeline.filter((event) => event.type === "quest"
    && event.goalId === completion.goalId
    && sameMoment(event.at, completion.completedAt));
  const mirror = candidates.find((event) => normalized(event.title) === normalized(completion.title))
    ?? candidates[0];
  const goalIds = relatedGoalIds(completion.goalId, [
    ...completion.linkedGoalIds,
    ...(mirror?.relatedGoalIds ?? []),
  ]);
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const areaIds = [...new Set(
    mirror?.relatedAreaIds?.length
      ? mirror.relatedAreaIds
      : mirror?.areaId
        ? [mirror.areaId]
        : goalIds.flatMap((goalId) => goalsById.get(goalId)?.areaId ?? []),
  )];
  const statIds = [...new Set(
    mirror?.relatedStatIds?.length
      ? mirror.relatedStatIds
      : goalIds.flatMap((goalId) => goalsById.get(goalId)?.statIds ?? []),
  )];
  return { goalIds, areaIds, statIds };
}

/** Preserve the organisation captured when a goal was first completed. */
export function goalCompletionAttribution(
  goal: Pick<Goal, "id" | "title" | "areaId" | "statIds" | "completedAt">,
  timeline: readonly TimelineEvent[],
): ActivityAttribution {
  const candidates = goal.completedAt
    ? timeline.filter((event) => event.type === "goal"
      && event.goalId === goal.id
      && sameMoment(event.at, goal.completedAt!))
    : [];
  const mirror = candidates.find((event) => normalized(event.title).endsWith(" completed")
    || normalized(event.detail).includes(" completed")) ?? candidates[0];
  return {
    goalIds: [goal.id],
    areaIds: [...new Set(
      mirror?.relatedAreaIds?.length
        ? mirror.relatedAreaIds
        : mirror?.areaId
          ? [mirror.areaId]
          : [goal.areaId],
    )],
    statIds: [...new Set(mirror?.relatedStatIds?.length ? mirror.relatedStatIds : goal.statIds)],
  };
}

export function momentSupportsAnyGoal(momentGoalIds: readonly string[], goalIds: ReadonlySet<string>) {
  return momentGoalIds.some((goalId) => goalIds.has(goalId));
}

/**
 * Attribute one completion to each distinct life area it supported. Duration is
 * split evenly across those areas so a shared action never inflates total time.
 */
export function completionAreaShares(
  completion: Pick<QuestCompletion, "goalId" | "linkedGoalIds" | "goalSnapshots" | "durationMinutes" | "completedAt" | "title">,
  goals: readonly Pick<Goal, "id" | "areaId">[],
  timeline: readonly TimelineEvent[] = [],
) {
  const attribution = completionAttribution(
    completion,
    goals.map((goal) => ({ ...goal, statIds: [] })),
    timeline,
  );
  const minutes = Math.max(0, completion.durationMinutes ?? 0);
  const minutesPerArea = attribution.areaIds.length ? minutes / attribution.areaIds.length : 0;

  return attribution.areaIds.map((areaId) => ({
    areaId,
    goalId: completion.goalSnapshots?.find((snapshot) => snapshot.areaId === areaId)?.goalId
      ?? goals.find((goal) => attribution.goalIds.includes(goal.id) && goal.areaId === areaId)?.id
      ?? completion.goalId,
    minutes: minutesPerArea,
  }));
}

export function completionStatIds(
  completion: Pick<QuestCompletion, "goalId" | "linkedGoalIds" | "goalSnapshots" | "completedAt" | "title">,
  goals: readonly Pick<Goal, "id" | "statIds">[],
  timeline: readonly TimelineEvent[] = [],
) {
  return completionAttribution(
    completion,
    goals.map((goal) => ({ ...goal, areaId: "" })),
    timeline,
  ).statIds;
}

export function metricEntryStatIds(
  entry: Pick<MetricEntry, "goalId" | "attribution">,
  goals: readonly Pick<Goal, "id" | "statIds">[],
) {
  if (entry.attribution) return [...entry.attribution.statIds];
  return goals.find((goal) => goal.id === entry.goalId)?.statIds ?? [];
}
