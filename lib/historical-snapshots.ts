import type {
  AppState,
  Goal,
  GoalOutcomeSnapshot,
  Review,
  ReviewContextSnapshot,
  ReviewSourceSnapshot,
  ReviewSourceSnapshotType,
} from "@/lib/types";
import { localDateKey, rollMetricPeriod } from "@/lib/utils";

export const MAX_REVIEW_CONTEXT_SOURCES = 100;
export const MAX_REVIEW_SOURCE_TITLE_LENGTH = 300;
export const MAX_REVIEW_SOURCE_DETAIL_LENGTH = 5_000;
export const MAX_GOAL_OUTCOME_METRICS = 200;
export const MAX_GOAL_OUTCOME_MILESTONES = 200;
export const MAX_GOAL_OUTCOME_CHECK_INS = 200;

const clip = (value: string, maximum: number) => value.slice(0, maximum);

const validInstant = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

function reviewPeriodStart(cadence: Review["cadence"], endedAt: Date) {
  const startedAt = new Date(endedAt);
  startedAt.setHours(0, 0, 0, 0);
  if (cadence === "weekly") {
    startedAt.setDate(startedAt.getDate() - ((startedAt.getDay() + 6) % 7));
  } else if (cadence === "monthly") {
    startedAt.setDate(1);
  }
  return startedAt;
}

function source(
  type: ReviewSourceSnapshotType,
  sourceId: string,
  title: string,
  detail: string,
  occurredAt: string,
  goalId?: string,
): ReviewSourceSnapshot {
  return {
    type,
    sourceId,
    title: clip(title, MAX_REVIEW_SOURCE_TITLE_LENGTH),
    detail: clip(detail, MAX_REVIEW_SOURCE_DETAIL_LENGTH),
    occurredAt,
    ...(goalId ? { goalId } : {}),
  };
}

/**
 * Captures the records visible for a saved review's calendar window. The
 * display fields are copied so later edits or source deletion cannot rewrite
 * what the person reviewed.
 */
export function createReviewContextSnapshot(
  state: AppState,
  review: Pick<Review, "cadence" | "createdAt">,
): ReviewContextSnapshot {
  const endedAt = validInstant(review.createdAt) ?? new Date();
  const startedAt = reviewPeriodStart(review.cadence, endedAt);
  const withinPeriod = (value: string) => {
    const instant = validInstant(value);
    return Boolean(instant && instant >= startedAt && instant <= endedAt);
  };

  const canonical: ReviewSourceSnapshot[] = [
    ...state.questCompletions
      .filter((completion) => withinPeriod(completion.completedAt))
      .map((completion) => source(
        "quest",
        completion.id,
        completion.title,
        [
          completion.durationMinutes === undefined
            ? "Action completed"
            : `${completion.durationMinutes} minutes recorded`,
          completion.note ? "Completion note saved" : null,
          completion.evidence.length ? `${completion.evidence.length} evidence ${completion.evidence.length === 1 ? "item" : "items"}` : null,
        ].filter(Boolean).join(" · "),
        completion.completedAt,
        completion.goalId,
      )),
    ...state.metricEntries
      .filter((entry) => withinPeriod(entry.recordedAt))
      .map((entry) => source(
        "metric",
        entry.id,
        entry.label ? `${entry.label} updated` : "Measurement updated",
        `${entry.previousValue.toLocaleString()} → ${entry.value.toLocaleString()}${entry.unit ? ` ${entry.unit}` : ""}`,
        entry.recordedAt,
        entry.goalId,
      )),
    ...state.goals.flatMap((goal) => goal.milestones
      .filter((milestone) => Boolean(milestone.completedAt && withinPeriod(milestone.completedAt)))
      .map((milestone) => source(
        "milestone",
        milestone.id,
        milestone.title,
        `Milestone reached for ${goal.title}`,
        milestone.completedAt!,
        goal.id,
      ))),
    ...state.goals.flatMap((goal) => goal.checkIns
      .filter((checkIn) => withinPeriod(checkIn.createdAt))
      .map((checkIn) => source(
        "check-in",
        checkIn.id,
        `Check-in for ${goal.title}`,
        checkIn.note,
        checkIn.createdAt,
        goal.id,
      ))),
    ...state.goals
      .filter((goal) => Boolean(goal.completedAt && withinPeriod(goal.completedAt)))
      .map((goal) => source(
        "goal",
        goal.id,
        goal.completionSnapshot?.title ?? goal.title,
        "Goal completed",
        goal.completedAt!,
        goal.id,
      )),
  ];

  // Migrated workspaces may have timeline-only history. Include those records
  // only when a canonical record at the same moment does not already exist.
  const legacy = state.timeline
    .filter((event) => (
      (event.type === "quest" || event.type === "metric" || event.type === "milestone")
      && withinPeriod(event.at)
      && !canonical.some((item) => (
        item.type === event.type
        && item.goalId === event.goalId
        && Math.abs(new Date(item.occurredAt).getTime() - new Date(event.at).getTime()) <= 1_000
      ))
    ))
    .map((event) => source(
      event.type as "quest" | "metric" | "milestone",
      event.id,
      event.title,
      event.detail,
      event.at,
      event.goalId,
    ));

  const allSources = [...canonical, ...legacy].sort((left, right) => (
    right.occurredAt.localeCompare(left.occurredAt)
      || left.type.localeCompare(right.type)
      || left.sourceId.localeCompare(right.sourceId)
  ));
  const goalIds = new Set(allSources.flatMap((item) => item.goalId ? [item.goalId] : []));

  return {
    version: 1,
    periodStartedAt: startedAt.toISOString(),
    periodEndedAt: endedAt.toISOString(),
    activeDays: new Set(allSources.map((item) => localDateKey(new Date(item.occurredAt)))).size,
    questsCompleted: allSources.filter((item) => item.type === "quest").length,
    metricsUpdated: allSources.filter((item) => item.type === "metric").length,
    milestonesReached: allSources.filter((item) => item.type === "milestone").length,
    checkInsRecorded: allSources.filter((item) => item.type === "check-in").length,
    goalsCompleted: allSources.filter((item) => item.type === "goal").length,
    goalsWithActivity: goalIds.size,
    sourceCount: allSources.length,
    sources: allSources.slice(0, MAX_REVIEW_CONTEXT_SOURCES),
  };
}

/** Captures the first-completion result without retaining mutable references. */
export function createGoalOutcomeSnapshot(
  goal: Goal,
  completedAt: string,
): GoalOutcomeSnapshot {
  const completionDate = validInstant(completedAt) ?? new Date();
  const metricsAtCompletion = goal.model === "consistency"
    ? goal.metrics.map((metric) => rollMetricPeriod(metric, completionDate))
    : goal.metrics;
  return {
    version: 1,
    completedAt,
    title: goal.title,
    description: goal.description,
    areaId: goal.areaId,
    statIds: [...goal.statIds],
    model: goal.model,
    priority: goal.priority,
    ...(goal.targetDate ? { targetDate: goal.targetDate } : {}),
    metricCount: metricsAtCompletion.length,
    milestoneCount: goal.milestones.length,
    checkInCount: goal.checkIns.length,
    metrics: metricsAtCompletion.slice(0, MAX_GOAL_OUTCOME_METRICS).map((metric) => ({
      id: metric.id,
      label: metric.label,
      current: metric.current,
      target: metric.target,
      unit: metric.unit,
      weight: metric.weight,
      ...(metric.period ? { period: metric.period } : {}),
      ...(metric.periodKey ? { periodKey: metric.periodKey } : {}),
    })),
    milestones: goal.milestones.slice(0, MAX_GOAL_OUTCOME_MILESTONES).map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      weight: milestone.weight,
      completed: milestone.completed,
      ...(milestone.completedAt ? { completedAt: milestone.completedAt } : {}),
    })),
    checkIns: goal.checkIns.slice(0, MAX_GOAL_OUTCOME_CHECK_INS).map((checkIn) => ({
      id: checkIn.id,
      createdAt: checkIn.createdAt,
      note: checkIn.note,
    })),
  };
}
