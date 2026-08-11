import { DEFAULT_AREAS, DEFAULT_SETTINGS, DEFAULT_STATS, EMPTY_STATE } from "@/lib/defaults";
import {
  decodeLegacyGoalEvidence,
  isAllowedEvidenceMimeType,
  isStableEvidenceId,
  isStructurallyValidRemoteEvidencePath,
  isValidEvidenceFileName,
  isValidEvidenceFileSize,
  isValidEvidenceUrl,
  MAX_EVIDENCE_NOTE_LENGTH,
  MAX_GOAL_EVIDENCE_ITEMS,
  sanitizeGoalEvidenceList,
} from "@/lib/goal-evidence";
import {
  goalProgressConfigurationIssue,
  hasConsistencyPeriodMetadata,
  hasPositiveWeightedMetric,
} from "@/lib/goal-progress";
import {
  MAX_GOAL_OUTCOME_CHECK_INS,
  MAX_GOAL_OUTCOME_METRICS,
  MAX_GOAL_OUTCOME_MILESTONES,
  MAX_REVIEW_CONTEXT_SOURCES,
  MAX_REVIEW_SOURCE_DETAIL_LENGTH,
  MAX_REVIEW_SOURCE_TITLE_LENGTH,
} from "@/lib/historical-snapshots";
import {
  assertMigratedStateCoherence,
  finalizeMigratedState,
} from "@/lib/state-migrations";
import type {
  AppState,
  Area,
  AttributionSnapshot,
  ConsistencyPeriod,
  DashboardSectionId,
  Goal,
  GoalAttributionSnapshot,
  GoalCheckIn,
  GoalModel,
  GoalOutcomeCheckInSnapshot,
  GoalOutcomeMetricSnapshot,
  GoalOutcomeMilestoneSnapshot,
  GoalOutcomeSnapshot,
  GoalStatus,
  LifeStat,
  MetricDelta,
  MetricEntry,
  Milestone,
  Priority,
  ProgressMetric,
  Quest,
  QuestKind,
  QuestCompletion,
  Review,
  ReviewCadence,
  ReviewContextSnapshot,
  ReviewSourceSnapshot,
  TimelineEvent,
  UserSettings,
} from "@/lib/types";
import { DASHBOARD_SECTION_IDS } from "@/lib/types";
import { isPeriodKey } from "@/lib/utils";
import { profileJsonValue } from "@/lib/workspace-json-profile";

export const CURRENT_STATE_VERSION = 3 as const;
export const MAX_WORKSPACE_SERIALIZED_BYTES = 5 * 1024 * 1024;
export const MAX_WORKSPACE_NESTING_DEPTH = 40;
export const MAX_WORKSPACE_NODES = 100_000;
export const MAX_WORKSPACE_STRING_BYTES = 256 * 1024;
export const WORKSPACE_TEXT_LIMITS = {
  identifier: 255,
  profileName: 120,
  profileChapter: 300,
  terminology: 40,
  areaOrQualityName: 120,
  color: 32,
  icon: 80,
  goalTitle: 200,
  goalDescription: 5_000,
  goalNotes: 20_000,
  metricLabel: 120,
  metricUnit: 32,
  milestoneTitle: 200,
  actionTitle: 200,
  actionDescription: 2_000,
  checkIn: 5_000,
  completionNote: 5_000,
  completionEvidenceItem: 4_096,
  reviewAnswerKey: 120,
  reviewAnswer: 10_000,
  timelineTitle: 300,
  timelineDetail: 5_000,
} as const;

const COLLECTION_LIMITS = {
  areas: 500,
  stats: 500,
  goals: 2_000,
  questCompletions: 50_000,
  metricEntries: 50_000,
  reviews: 10_000,
  timeline: 50_000,
  goalChildren: 2_000,
  reviewAnswers: 200,
} as const;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const stringValue = (value: unknown, fallback = "") =>
  typeof value === "string" && value.trim() ? value : fallback;

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

const boundedNumberValue = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) => typeof value === "number" && Number.isFinite(value)
  ? Math.min(maximum, Math.max(minimum, value))
  : fallback;

const positiveNumberValue = (value: unknown, fallback = 1) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, value)
    : fallback;

const booleanValue = (value: unknown, fallback = false) =>
  typeof value === "boolean" ? value : fallback;

const enumValue = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;

const validTimestamp = (value: unknown, fallback: string) => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return Number.isNaN(new Date(value).getTime()) ? fallback : value;
};

const optionalValidDate = (value: unknown) =>
  typeof value === "string" && value.trim() && isValidDateValue(value) ? value : undefined;

const optionalCalendarDate = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (isValidCalendarDateValue(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const leadingDate = /^(\d{4}-\d{2}-\d{2})(?:T|\s)/.exec(value)?.[1];
  if (leadingDate) {
    return isValidCalendarDateValue(leadingDate) ? leadingDate : undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
};

function uniqueById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))];
}

function sanitizeAttribution(value: unknown): AttributionSnapshot | null {
  if (!isRecord(value)) return null;
  const areaId = optionalString(value.areaId);
  if (!areaId) return null;
  return { areaId, statIds: stringArray(value.statIds) };
}

function sanitizeGoalAttribution(value: unknown): GoalAttributionSnapshot | null {
  if (!isRecord(value)) return null;
  const goalId = optionalString(value.goalId);
  const attribution = sanitizeAttribution(value);
  return goalId && attribution ? { goalId, ...attribution } : null;
}

function sanitizeArea(value: unknown, index: number): Area | null {
  if (!isRecord(value)) return null;
  const area: Area = {
    id: stringValue(value.id, `area-migrated-${index + 1}`),
    name: stringValue(value.name, "Untitled area"),
    color: stringValue(value.color, "#8B7CFF"),
    icon: stringValue(value.icon, "Circle"),
    order: Math.trunc(boundedNumberValue(value.order, index, 0, Number.MAX_SAFE_INTEGER)),
  };
  if (typeof value.hidden === "boolean") area.hidden = value.hidden;
  if (typeof value.archived === "boolean") area.archived = value.archived;
  return area;
}

function sanitizeStat(value: unknown, index: number): LifeStat | null {
  if (!isRecord(value)) return null;
  const stat: LifeStat = {
    id: stringValue(value.id, `stat-migrated-${index + 1}`),
    name: stringValue(value.name, "Untitled quality"),
    color: stringValue(value.color, "#8B7CFF"),
    icon: stringValue(value.icon, "Circle"),
  };
  if (typeof value.archived === "boolean") stat.archived = value.archived;
  return stat;
}

function sanitizeMetricDelta(value: unknown): MetricDelta | null {
  if (!isRecord(value)) return null;
  const metricId = optionalString(value.metricId);
  if (
    !metricId
    || typeof value.amount !== "number"
    || !Number.isFinite(value.amount)
    || Math.abs(value.amount) > Number.MAX_SAFE_INTEGER
  ) return null;
  return { metricId, amount: value.amount };
}

function mergeMetricDeltas(value: unknown): MetricDelta[] {
  if (!Array.isArray(value)) return [];
  const totals = new Map<string, number>();
  value.map(sanitizeMetricDelta).forEach((delta) => {
    if (!delta) return;
    const total = (totals.get(delta.metricId) ?? 0) + delta.amount;
    if (Number.isFinite(total) && Math.abs(total) <= Number.MAX_SAFE_INTEGER) {
      totals.set(delta.metricId, total);
    }
  });
  return [...totals].map(([metricId, amount]) => ({ metricId, amount }));
}

const CONSISTENCY_PERIODS = ["week", "month", "quarter", "year"] as const;
const GOAL_MODELS = ["numeric", "weighted", "consistency", "open"] as const;
const GOAL_PRIORITIES = ["low", "medium", "high", "critical"] as const;
const GOAL_STATUSES = ["active", "paused", "completed", "archived"] as const;
const QUEST_KINDS = ["task", "session", "challenge", "milestone"] as const;
const QUEST_REPEATS = ["none", "daily", "weekly", "monthly"] as const;
const REVIEW_CADENCES = ["daily", "weekly", "monthly"] as const;
const REVIEW_SOURCE_TYPES = ["quest", "metric", "milestone", "check-in", "goal"] as const;
const METRIC_ENTRY_SOURCES = ["manual", "quest"] as const;
const SETTINGS_THEMES = ["dark", "light", "system"] as const;
const INTERFACE_INTENSITIES = ["minimal", "balanced", "immersive"] as const;
const DASHBOARD_SECTIONS: DashboardSectionId[] = [...DASHBOARD_SECTION_IDS];
const LEGACY_FIXED_DASHBOARD_SECTIONS: DashboardSectionId[] = ["hero", "overview", "due-now"];

function sanitizeMetric(value: unknown, index: number): ProgressMetric | null {
  if (!isRecord(value)) return null;
  const metric: ProgressMetric = {
    id: stringValue(value.id, `metric-migrated-${index + 1}`),
    label: stringValue(value.label, "Progress"),
    current: boundedNumberValue(value.current, 0, 0, Number.MAX_SAFE_INTEGER),
    target: positiveNumberValue(value.target),
    unit: typeof value.unit === "string" ? value.unit : "",
    weight: boundedNumberValue(value.weight, 100, 0, 100),
  };
  if (typeof value.period === "string" && CONSISTENCY_PERIODS.includes(value.period as ConsistencyPeriod)) {
    metric.period = value.period as ConsistencyPeriod;
    const periodKey = optionalString(value.periodKey);
    if (periodKey && isPeriodKey(metric.period, periodKey)) metric.periodKey = periodKey;
  }
  return metric;
}

function sanitizeMilestone(value: unknown, index: number): Milestone | null {
  if (!isRecord(value)) return null;
  const milestone: Milestone = {
    id: stringValue(value.id, `milestone-migrated-${index + 1}`),
    title: stringValue(value.title, "Untitled milestone"),
    weight: boundedNumberValue(value.weight, 0, 0, 100),
    completed: booleanValue(value.completed),
  };
  const completedAt = optionalValidDate(value.completedAt);
  if (completedAt) milestone.completedAt = completedAt;
  const attribution = sanitizeAttribution(value.attribution);
  if (attribution) milestone.attribution = attribution;
  return milestone;
}

function sanitizeQuest(value: unknown, index: number): Quest | null {
  if (!isRecord(value)) return null;
  const quest: Quest = {
    id: stringValue(value.id, `quest-migrated-${index + 1}`),
    kind: enumValue<QuestKind>(value.kind, QUEST_KINDS, "task"),
    linkedGoalIds: stringArray(value.linkedGoalIds),
    title: stringValue(value.title, "Untitled action"),
    repeat: enumValue(value.repeat, QUEST_REPEATS, "none"),
    completed: booleanValue(value.completed),
    metricDeltas: mergeMetricDeltas(value.metricDeltas),
  };
  const description = optionalString(value.description);
  const dueDate = optionalCalendarDate(value.dueDate);
  const completedAt = optionalValidDate(value.completedAt);
  const durationMinutes = typeof value.durationMinutes === "number"
    && Number.isFinite(value.durationMinutes)
    && value.durationMinutes >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, value.durationMinutes)
    : Number.NaN;
  if (description) quest.description = description;
  if (dueDate) quest.dueDate = dueDate;
  if (quest.repeat === "monthly") {
    const suppliedAnchor = typeof value.monthlyAnchorDay === "number"
      && Number.isSafeInteger(value.monthlyAnchorDay)
      && value.monthlyAnchorDay >= 1
      && value.monthlyAnchorDay <= 31
      ? value.monthlyAnchorDay
      : undefined;
    const derivedAnchor = dueDate ? Number(dueDate.slice(8, 10)) : undefined;
    if (suppliedAnchor ?? derivedAnchor) {
      quest.monthlyAnchorDay = suppliedAnchor ?? derivedAnchor;
    }
  }
  if (completedAt) quest.completedAt = completedAt;
  if (Number.isFinite(durationMinutes) && durationMinutes >= 0) quest.durationMinutes = durationMinutes;
  return quest;
}

function sanitizeCheckIn(value: unknown, index: number, goalId: string, fallbackAt: string): GoalCheckIn | null {
  if (!isRecord(value)) return null;
  const note = optionalString(value.note);
  if (!note) return null;
  const checkIn: GoalCheckIn = {
    id: stringValue(value.id, `${goalId}-check-in-${index + 1}`),
    createdAt: validTimestamp(value.createdAt, fallbackAt),
    note,
  };
  const attribution = sanitizeAttribution(value.attribution);
  if (attribution) checkIn.attribution = attribution;
  return checkIn;
}

function legacyStatIds(value: UnknownRecord) {
  if (Array.isArray(value.statIds)) return stringArray(value.statIds);
  if (!isRecord(value.statWeights)) return [];
  return Object.entries(value.statWeights)
    .filter(([, weight]) => typeof weight === "number" && Number.isFinite(weight) && weight > 0)
    .map(([statId]) => statId);
}

function repairMigratedGoalProgress(goal: Goal) {
  if (goal.model !== "numeric" && goal.model !== "consistency") return;

  // A legacy measured goal without a measurement cannot be assigned an honest
  // target. Preserve all of its content as an open reflection instead.
  if (!goal.metrics.length) {
    goal.model = "open";
    return;
  }

  // Older workspaces could persist every relative weight as zero. Retain every
  // metric and give them a neutral equal share rather than discarding history.
  if (!hasPositiveWeightedMetric(goal.metrics)) {
    const equalWeight = 100 / goal.metrics.length;
    goal.metrics = goal.metrics.map((metric) => ({ ...metric, weight: equalWeight }));
  }

  if (
    goal.model === "consistency"
    && goal.metrics.some((metric) => !hasConsistencyPeriodMetadata(metric))
  ) {
    // Legacy consistency counters were all-time current/target values. Guessing
    // a calendar window would silently reset that progress later, so retain the
    // measurement as an honest all-time numeric model instead.
    goal.model = "numeric";
    goal.metrics = goal.metrics.map((metric) => {
      const { period: _period, periodKey: _periodKey, ...unscopedMetric } = metric;
      void _period;
      void _periodKey;
      return unscopedMetric;
    });
  }
}

function sanitizeGoalOutcomeMetric(value: unknown, index: number): GoalOutcomeMetricSnapshot | null {
  if (!isRecord(value)) return null;
  const metric: GoalOutcomeMetricSnapshot = {
    id: stringValue(value.id, `outcome-metric-${index + 1}`),
    label: stringValue(value.label, "Progress"),
    current: boundedNumberValue(value.current, 0, 0, Number.MAX_SAFE_INTEGER),
    target: positiveNumberValue(value.target),
    unit: typeof value.unit === "string" ? value.unit : "",
    weight: boundedNumberValue(value.weight, 100, 0, 100),
  };
  if (
    typeof value.period === "string"
    && CONSISTENCY_PERIODS.includes(value.period as ConsistencyPeriod)
  ) {
    metric.period = value.period as ConsistencyPeriod;
    const periodKey = optionalString(value.periodKey);
    if (periodKey && isPeriodKey(metric.period, periodKey)) metric.periodKey = periodKey;
  }
  return metric;
}

function sanitizeGoalOutcomeMilestone(
  value: unknown,
  index: number,
): GoalOutcomeMilestoneSnapshot | null {
  if (!isRecord(value)) return null;
  const milestone: GoalOutcomeMilestoneSnapshot = {
    id: stringValue(value.id, `outcome-milestone-${index + 1}`),
    title: stringValue(value.title, "Untitled milestone"),
    weight: boundedNumberValue(value.weight, 0, 0, 100),
    completed: booleanValue(value.completed),
  };
  const completedAt = optionalValidDate(value.completedAt);
  if (completedAt) milestone.completedAt = completedAt;
  return milestone;
}

function sanitizeGoalOutcomeCheckIn(
  value: unknown,
  index: number,
  completedAt: string,
): GoalOutcomeCheckInSnapshot | null {
  if (!isRecord(value)) return null;
  const note = optionalString(value.note);
  if (!note) return null;
  return {
    id: stringValue(value.id, `outcome-check-in-${index + 1}`),
    createdAt: validTimestamp(value.createdAt, completedAt),
    note,
  };
}

function sanitizeGoalOutcome(value: unknown): GoalOutcomeSnapshot | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const completedAt = optionalValidDate(value.completedAt);
  const title = optionalString(value.title);
  const areaId = optionalString(value.areaId);
  if (!completedAt || !title || !areaId) return null;
  const metrics = Array.isArray(value.metrics)
    ? uniqueById(value.metrics
      .slice(0, MAX_GOAL_OUTCOME_METRICS)
      .map(sanitizeGoalOutcomeMetric)
      .filter((item): item is GoalOutcomeMetricSnapshot => Boolean(item)))
    : [];
  const milestones = Array.isArray(value.milestones)
    ? uniqueById(value.milestones
      .slice(0, MAX_GOAL_OUTCOME_MILESTONES)
      .map(sanitizeGoalOutcomeMilestone)
      .filter((item): item is GoalOutcomeMilestoneSnapshot => Boolean(item)))
    : [];
  const checkIns = Array.isArray(value.checkIns)
    ? uniqueById(value.checkIns
      .slice(0, MAX_GOAL_OUTCOME_CHECK_INS)
      .map((checkIn, index) => sanitizeGoalOutcomeCheckIn(checkIn, index, completedAt))
      .filter((item): item is GoalOutcomeCheckInSnapshot => Boolean(item)))
    : [];
  const safeCount = (candidate: unknown, retained: number) => (
    typeof candidate === "number"
    && Number.isSafeInteger(candidate)
    && candidate >= retained
    && candidate <= COLLECTION_LIMITS.goalChildren
      ? candidate
      : retained
  );
  const snapshot: GoalOutcomeSnapshot = {
    version: 1,
    completedAt,
    title,
    description: typeof value.description === "string" ? value.description : "",
    areaId,
    statIds: stringArray(value.statIds),
    model: enumValue<GoalModel>(value.model, GOAL_MODELS, "open"),
    priority: enumValue<Priority>(value.priority, GOAL_PRIORITIES, "medium"),
    metricCount: safeCount(value.metricCount, metrics.length),
    milestoneCount: safeCount(value.milestoneCount, milestones.length),
    checkInCount: safeCount(value.checkInCount, checkIns.length),
    metrics,
    milestones,
    checkIns,
  };
  const targetDate = optionalCalendarDate(value.targetDate);
  if (targetDate) snapshot.targetDate = targetDate;
  return snapshot;
}

function sanitizeGoal(value: unknown, index: number, fallbackAt: string): Goal | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id, `goal-migrated-${index + 1}`);
  const goal: Goal = {
    id,
    title: stringValue(value.title, "Untitled goal"),
    description: typeof value.description === "string" ? value.description : "",
    areaId: stringValue(value.areaId),
    model: enumValue<GoalModel>(value.model, GOAL_MODELS, "open"),
    priority: enumValue<Priority>(value.priority, GOAL_PRIORITIES, "medium"),
    status: enumValue<GoalStatus>(value.status, GOAL_STATUSES, "active"),
    createdAt: validTimestamp(value.createdAt, fallbackAt),
    metrics: Array.isArray(value.metrics)
      ? uniqueById(value.metrics.map(sanitizeMetric).filter((item): item is ProgressMetric => Boolean(item)))
      : [],
    milestones: Array.isArray(value.milestones)
      ? uniqueById(value.milestones.map(sanitizeMilestone).filter((item): item is Milestone => Boolean(item)))
      : [],
    quests: Array.isArray(value.quests)
      ? uniqueById(value.quests.map(sanitizeQuest).filter((item): item is Quest => Boolean(item)))
      : [],
    statIds: legacyStatIds(value),
    checkIns: Array.isArray(value.checkIns)
      ? uniqueById(
          value.checkIns
            .map((checkIn, checkInIndex) => sanitizeCheckIn(checkIn, checkInIndex, id, fallbackAt))
            .filter((item): item is GoalCheckIn => Boolean(item)),
        )
      : [],
    evidence: sanitizeGoalEvidenceList(value.evidence, id),
    notes: typeof value.notes === "string" ? value.notes : "",
  };
  const metricIds = new Set(goal.metrics.map((metric) => metric.id));
  goal.quests.forEach((quest) => {
    quest.metricDeltas = quest.metricDeltas.filter((delta) => metricIds.has(delta.metricId));
  });
  const milestoneWeight = goal.milestones.reduce((total, milestone) => total + milestone.weight, 0);
  if (milestoneWeight > 100) {
    goal.milestones = goal.milestones.map((milestone) => ({
      ...milestone,
      weight: (milestone.weight / milestoneWeight) * 100,
    }));
  }
  repairMigratedGoalProgress(goal);
  const targetDate = optionalCalendarDate(value.targetDate);
  const completedAt = optionalValidDate(value.completedAt);
  if (targetDate) goal.targetDate = targetDate;
  if (completedAt) goal.completedAt = completedAt;
  const completionSnapshot = sanitizeGoalOutcome(value.completionSnapshot);
  if (completionSnapshot && completionSnapshot.completedAt === completedAt) {
    goal.completionSnapshot = completionSnapshot;
  }
  if (goal.areaId) {
    const attribution = { areaId: goal.areaId, statIds: [...goal.statIds] };
    goal.milestones.forEach((milestone) => {
      if (milestone.completedAt && !milestone.attribution) milestone.attribution = clone(attribution);
    });
    goal.checkIns.forEach((checkIn) => {
      if (!checkIn.attribution) checkIn.attribution = clone(attribution);
    });
  }
  return goal;
}

function sanitizeReviewSource(value: unknown): ReviewSourceSnapshot | null {
  if (!isRecord(value)) return null;
  const sourceId = optionalString(value.sourceId);
  const title = optionalString(value.title);
  const detail = typeof value.detail === "string" ? value.detail : undefined;
  const occurredAt = optionalValidDate(value.occurredAt);
  if (
    !sourceId
    || !title
    || detail === undefined
    || !occurredAt
    || typeof value.type !== "string"
    || !REVIEW_SOURCE_TYPES.includes(value.type as ReviewSourceSnapshot["type"])
  ) return null;
  const item: ReviewSourceSnapshot = {
    sourceId,
    type: value.type as ReviewSourceSnapshot["type"],
    title: title.slice(0, MAX_REVIEW_SOURCE_TITLE_LENGTH),
    detail: detail.slice(0, MAX_REVIEW_SOURCE_DETAIL_LENGTH),
    occurredAt,
  };
  const goalId = optionalString(value.goalId);
  if (goalId) item.goalId = goalId;
  return item;
}

function sanitizeReviewContext(value: unknown): ReviewContextSnapshot | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const periodStartedAt = optionalValidDate(value.periodStartedAt);
  const periodEndedAt = optionalValidDate(value.periodEndedAt);
  if (
    !periodStartedAt
    || !periodEndedAt
    || new Date(periodStartedAt).getTime() > new Date(periodEndedAt).getTime()
  ) return null;
  const sources = Array.isArray(value.sources)
    ? value.sources
      .slice(0, MAX_REVIEW_CONTEXT_SOURCES)
      .map(sanitizeReviewSource)
      .filter((item): item is ReviewSourceSnapshot => Boolean(item))
    : [];
  const count = (candidate: unknown, fallback: number) => (
    typeof candidate === "number"
    && Number.isSafeInteger(candidate)
    && candidate >= 0
    && candidate <= MAX_WORKSPACE_NODES
      ? candidate
      : fallback
  );
  const retainedTypeCount = (type: ReviewSourceSnapshot["type"]) =>
    sources.filter((item) => item.type === type).length;
  return {
    version: 1,
    periodStartedAt,
    periodEndedAt,
    activeDays: count(value.activeDays, new Set(sources.map((item) => item.occurredAt.slice(0, 10))).size),
    questsCompleted: count(value.questsCompleted, retainedTypeCount("quest")),
    metricsUpdated: count(value.metricsUpdated, retainedTypeCount("metric")),
    milestonesReached: count(value.milestonesReached, retainedTypeCount("milestone")),
    checkInsRecorded: count(value.checkInsRecorded, retainedTypeCount("check-in")),
    goalsCompleted: count(value.goalsCompleted, retainedTypeCount("goal")),
    goalsWithActivity: count(value.goalsWithActivity, new Set(sources.flatMap((item) => item.goalId ? [item.goalId] : [])).size),
    sourceCount: count(value.sourceCount, sources.length),
    sources,
  };
}

function sanitizeReview(value: unknown, index: number, fallbackAt: string): Review | null {
  if (!isRecord(value)) return null;
  const answers: Record<string, string> = {};
  if (isRecord(value.answers)) {
    Object.entries(value.answers).forEach(([key, answer]) => {
      if (typeof answer !== "string") return;
      const migratedKey = key === "achievement" ? "meaning" : key;
      answers[migratedKey] = answer;
    });
  }
  const review: Review = {
    id: stringValue(value.id, `review-migrated-${index + 1}`),
    cadence: enumValue<ReviewCadence>(value.cadence, REVIEW_CADENCES, "weekly"),
    createdAt: validTimestamp(value.createdAt, fallbackAt),
    answers,
  };
  const context = sanitizeReviewContext(value.context);
  if (context) review.context = context;
  return review;
}

const TIMELINE_TYPES: TimelineEvent["type"][] = ["quest", "milestone", "goal", "review", "note", "metric"];

function legacyTimelineDetail(value: unknown, type: TimelineEvent["type"]) {
  const detail = typeof value === "string" ? value : "";
  if (!/\bxp\b/i.test(detail)) return detail;
  const minutes = detail.match(/(\d+)\s+minutes invested/i)?.[1];
  if (type === "quest") return minutes ? `Action completed · ${minutes} minutes invested.` : "Action completed.";
  if (type === "milestone") return "Milestone reached.";
  if (type === "goal") return "Goal activity recorded.";
  return "Activity recorded.";
}

function sanitizeTimelineEvent(value: unknown, index: number, fallbackAt: string): TimelineEvent | null {
  if (!isRecord(value) || !TIMELINE_TYPES.includes(value.type as TimelineEvent["type"])) return null;
  const type = value.type as TimelineEvent["type"];
  const event: TimelineEvent = {
    id: stringValue(value.id, `event-migrated-${index + 1}`),
    type,
    title: stringValue(value.title, "Activity recorded"),
    detail: legacyTimelineDetail(value.detail, type),
    at: validTimestamp(value.at, fallbackAt),
  };
  const goalId = optionalString(value.goalId);
  const areaId = optionalString(value.areaId);
  if (goalId) event.goalId = goalId;
  if (areaId) event.areaId = areaId;
  const relatedGoalIds = stringArray(value.relatedGoalIds);
  const relatedAreaIds = stringArray(value.relatedAreaIds);
  const relatedStatIds = stringArray(value.relatedStatIds);
  if (relatedGoalIds.length) event.relatedGoalIds = [...new Set(relatedGoalIds)];
  if (relatedAreaIds.length) event.relatedAreaIds = [...new Set(relatedAreaIds)];
  if (relatedStatIds.length) event.relatedStatIds = [...new Set(relatedStatIds)];
  return event;
}

function sanitizeQuestCompletion(value: unknown, index: number, fallbackAt: string): QuestCompletion | null {
  if (!isRecord(value)) return null;
  const goalId = optionalString(value.goalId);
  const questId = optionalString(value.questId);
  if (!goalId || !questId) return null;
  const completion: QuestCompletion = {
    id: stringValue(value.id, `completion-migrated-${index + 1}`),
    goalId,
    linkedGoalIds: stringArray(value.linkedGoalIds),
    questId,
    title: stringValue(value.title, "Completed action"),
    completedAt: validTimestamp(value.completedAt, fallbackAt),
    evidence: stringArray(value.evidence),
    metricDeltas: mergeMetricDeltas(value.metricDeltas),
  };
  if (Array.isArray(value.goalSnapshots)) {
    const snapshots = [...new Map(
      value.goalSnapshots
        .map(sanitizeGoalAttribution)
        .filter((item): item is GoalAttributionSnapshot => Boolean(item))
        .map((snapshot) => [snapshot.goalId, snapshot]),
    ).values()];
    if (snapshots.length) completion.goalSnapshots = snapshots;
  }
  const durationMinutes = typeof value.durationMinutes === "number"
    && Number.isFinite(value.durationMinutes)
    && value.durationMinutes >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, value.durationMinutes)
    : Number.NaN;
  if (Number.isFinite(durationMinutes) && durationMinutes >= 0) completion.durationMinutes = durationMinutes;
  const note = optionalString(value.note);
  if (note) completion.note = note;
  return completion;
}

function sanitizeMetricEntry(value: unknown, index: number, fallbackAt: string): MetricEntry | null {
  if (!isRecord(value)) return null;
  const goalId = optionalString(value.goalId);
  const metricId = optionalString(value.metricId);
  if (!goalId || !metricId) return null;
  const entry: MetricEntry & { label?: string; unit?: string } = {
    id: stringValue(value.id, `metric-entry-migrated-${index + 1}`),
    goalId,
    metricId,
    value: boundedNumberValue(value.value, 0, 0, Number.MAX_SAFE_INTEGER),
    previousValue: boundedNumberValue(value.previousValue, 0, 0, Number.MAX_SAFE_INTEGER),
    recordedAt: validTimestamp(value.recordedAt, fallbackAt),
    source: enumValue(value.source, METRIC_ENTRY_SOURCES, "manual"),
  };
  const periodKey = optionalString(value.periodKey);
  if (periodKey && CONSISTENCY_PERIODS.some((period) => isPeriodKey(period, periodKey))) {
    entry.periodKey = periodKey;
  }
  const label = optionalString(value.label);
  const unit = optionalString(value.unit);
  const sourceCompletionId = optionalString(value.sourceCompletionId);
  if (label) entry.label = label.trim().slice(0, 120);
  if (unit) entry.unit = unit.trim().slice(0, 32);
  if (sourceCompletionId && entry.source === "quest") entry.sourceCompletionId = sourceCompletionId;
  const attribution = sanitizeAttribution(value.attribution);
  if (attribution) entry.attribution = attribution;
  return entry;
}

function sanitizeSettings(value: unknown): UserSettings {
  if (!isRecord(value)) return clone(DEFAULT_SETTINGS);
  const terminologySource = isRecord(value.terminology) ? value.terminology : {};
  const suppliedDashboardOrder = stringArray(value.dashboardOrder)
    .filter((item): item is DashboardSectionId => DASHBOARD_SECTIONS.includes(item as DashboardSectionId));
  // Hero, overview, and due-now were fixed above the configurable sections in
  // earlier workspaces. Put those newly configurable regions first when
  // migrating an old preference list, while retaining the user's established
  // order for every section they could already move.
  const migratedFixedSections = LEGACY_FIXED_DASHBOARD_SECTIONS
    .filter((item) => !suppliedDashboardOrder.includes(item));
  const dashboardOrder = [
    ...migratedFixedSections,
    ...suppliedDashboardOrder,
    ...DASHBOARD_SECTIONS.filter((item) => (
      !migratedFixedSections.includes(item)
      && !suppliedDashboardOrder.includes(item)
    )),
  ];
  const settings: UserSettings = {
    theme: enumValue(value.theme, SETTINGS_THEMES, DEFAULT_SETTINGS.theme),
    interfaceIntensity: enumValue(
      value.interfaceIntensity ?? value.gameIntensity,
      INTERFACE_INTENSITIES,
      DEFAULT_SETTINGS.interfaceIntensity,
    ),
    notifications: booleanValue(value.notifications, DEFAULT_SETTINGS.notifications),
    dashboardOrder,
    hiddenDashboardSections: stringArray(value.hiddenDashboardSections)
      .filter((item): item is DashboardSectionId => DASHBOARD_SECTIONS.includes(item as DashboardSectionId)),
    terminology: {
      goals: stringValue(terminologySource.goals, DEFAULT_SETTINGS.terminology.goals),
      quests: stringValue(terminologySource.quests, DEFAULT_SETTINGS.terminology.quests),
      areas: stringValue(terminologySource.areas, DEFAULT_SETTINGS.terminology.areas),
      milestones: stringValue(terminologySource.milestones, DEFAULT_SETTINGS.terminology.milestones),
      stats: stringValue(terminologySource.stats, DEFAULT_SETTINGS.terminology.stats),
    },
  };
  const birthDate = optionalCalendarDate(value.birthDate);
  if (birthDate) settings.birthDate = birthDate;
  const reminderTime = optionalString(value.reminderTime);
  if (reminderTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) settings.reminderTime = reminderTime;
  return settings;
}

export function migrateState(value: unknown, now = new Date().toISOString()): AppState {
  if (!isRecord(value)) {
    const empty = clone(EMPTY_STATE);
    empty.updatedAt = now;
    empty.profile.createdAt = now;
    return empty;
  }

  const areasSource = Array.isArray(value.areas) ? value.areas : DEFAULT_AREAS;
  const statsSource = Array.isArray(value.stats) ? value.stats : DEFAULT_STATS;
  const areas = uniqueById(areasSource.map(sanitizeArea).filter((item): item is Area => Boolean(item)));
  const stats = uniqueById(statsSource.map(sanitizeStat).filter((item): item is LifeStat => Boolean(item)));
  const goals = Array.isArray(value.goals)
    ? uniqueById(value.goals.map((goal, index) => sanitizeGoal(goal, index, now)).filter((item): item is Goal => Boolean(item)))
    : [];

  const profileSource = isRecord(value.profile) ? value.profile : {};
  const state: AppState = {
    version: CURRENT_STATE_VERSION,
    updatedAt: validTimestamp(value.updatedAt, now),
    profile: {
      displayName: typeof profileSource.displayName === "string" ? profileSource.displayName : "",
      chapter: stringValue(profileSource.chapter, EMPTY_STATE.profile.chapter),
      onboarded: booleanValue(profileSource.onboarded),
      createdAt: validTimestamp(profileSource.createdAt, now),
    },
    settings: sanitizeSettings(value.settings),
    areas,
    stats,
    goals,
    questCompletions: Array.isArray(value.questCompletions)
      ? uniqueById(
          value.questCompletions
            .map((completion, index) => sanitizeQuestCompletion(completion, index, now))
            .filter((item): item is QuestCompletion => Boolean(item)),
        )
      : [],
    metricEntries: Array.isArray(value.metricEntries)
      ? uniqueById(
          value.metricEntries
            .map((entry, index) => sanitizeMetricEntry(entry, index, now))
            .filter((item): item is MetricEntry => Boolean(item)),
        )
      : [],
    reviews: Array.isArray(value.reviews)
      ? uniqueById(
          value.reviews
            .map((review, index) => sanitizeReview(review, index, now))
            .filter((item): item is Review => Boolean(item)),
        )
      : [],
    timeline: Array.isArray(value.timeline)
      ? uniqueById(
          value.timeline
            .map((event, index) => sanitizeTimelineEvent(event, index, now))
            .filter((item): item is TimelineEvent => Boolean(item)),
        )
      : [],
  };

  const sourceVersion = typeof value.version === "number" && Number.isInteger(value.version)
    ? value.version
    : 1;
  return finalizeMigratedState(state, sourceVersion, CURRENT_STATE_VERSION);
}

export class UnsupportedStoredWorkspaceVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    const description = typeof version === "number" ? String(version) : "missing or invalid";
    super(`Stored workspace version ${description} is not supported by this app.`);
    this.name = "UnsupportedStoredWorkspaceVersionError";
    this.version = version;
  }
}

/**
 * Recovery boundary for device and cloud snapshots. Supported generations are
 * migrated only after the complete untrusted snapshot passes structural and
 * referential validation; unknown generations are never down-migrated.
 */
export function migrateStoredState(
  value: unknown,
  now = new Date().toISOString(),
): AppState {
  if (
    !isRecord(value)
    || typeof value.version !== "number"
    || !Number.isInteger(value.version)
    || value.version < 1
    || value.version > CURRENT_STATE_VERSION
  ) {
    throw new UnsupportedStoredWorkspaceVersionError(
      isRecord(value) ? value.version : undefined,
    );
  }
  return parseImportedState(value, now);
}

export class WorkspaceImportError extends Error {
  constructor(message: string) {
    super(`Invalid Evolvra backup: ${message}`);
    this.name = "WorkspaceImportError";
  }
}

function importFailure(message: string): never {
  throw new WorkspaceImportError(message);
}

function assertJsonCompatible(
  value: unknown,
  path = "workspace",
  ancestors = new WeakSet<object>(),
  budget = { nodes: 0 },
  depth = 0,
) {
  budget.nodes += 1;
  if (budget.nodes > MAX_WORKSPACE_NODES) importFailure(`workspace exceeds the ${MAX_WORKSPACE_NODES.toLocaleString()}-node safety limit.`);
  if (depth > MAX_WORKSPACE_NESTING_DEPTH) importFailure(`workspace exceeds the maximum nesting depth of ${MAX_WORKSPACE_NESTING_DEPTH}.`);
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_WORKSPACE_STRING_BYTES) {
      importFailure(`${path} exceeds the per-string size limit.`);
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) importFailure(`${path} contains a non-finite number.`);
    return;
  }
  if (typeof value !== "object") importFailure(`${path} contains a value that cannot exist in a JSON backup.`);
  if (ancestors.has(value)) importFailure(`${path} contains a circular reference.`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonCompatible(item, `${path}[${index}]`, ancestors, budget, depth + 1));
  } else {
    Object.entries(value).forEach(([key, item]) => assertJsonCompatible(item, `${path}.${key}`, ancestors, budget, depth + 1));
  }
  ancestors.delete(value);
}

function assertCollectionLimit(items: unknown[], path: string, maximum: number) {
  if (items.length > maximum) importFailure(`${path} cannot contain more than ${maximum.toLocaleString()} items.`);
}

function requiredArray(value: UnknownRecord, key: string, path = "workspace") {
  if (!Array.isArray(value[key])) importFailure(`${path}.${key} must be an array.`);
  return value[key] as unknown[];
}

function requiredRecord(value: UnknownRecord, key: string, path = "workspace") {
  if (!isRecord(value[key])) importFailure(`${path}.${key} must be an object.`);
  return value[key] as UnknownRecord;
}

function objectItems(items: unknown[], path: string) {
  return items.map((item, index) => {
    if (!isRecord(item)) importFailure(`${path}[${index}] must be an object.`);
    return item as UnknownRecord;
  });
}

function requiredId(value: UnknownRecord, path: string) {
  const id = optionalString(value.id);
  if (!id) importFailure(`${path}.id must be a non-empty string.`);
  if (id.length > WORKSPACE_TEXT_LIMITS.identifier) {
    importFailure(`${path}.id cannot exceed ${WORKSPACE_TEXT_LIMITS.identifier} characters.`);
  }
  return id;
}

function assertUniqueIds(items: UnknownRecord[], path: string) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const id = requiredId(item, `${path}[${index}]`);
    if (seen.has(id)) importFailure(`${path} contains duplicate id "${id}".`);
    seen.add(id);
  });
}

function isValidCalendarDateValue(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!dateOnly) return false;
  const year = Number(dateOnly[1]);
  const month = Number(dateOnly[2]) - 1;
  const day = Number(dateOnly[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month && parsed.getUTCDate() === day;
}

function isValidDateValue(value: unknown) {
  if (isValidCalendarDateValue(value)) return true;
  if (typeof value !== "string" || !value.trim()) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const leadingDate = /^(\d{4}-\d{2}-\d{2})(?:T|\s)/.exec(value)?.[1];
  if (leadingDate && !isValidCalendarDateValue(leadingDate)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function assertDateField(value: UnknownRecord, key: string, path: string, required = false) {
  if (!(key in value)) {
    if (required) importFailure(`${path}.${key} is required.`);
    return;
  }
  if (!isValidDateValue(value[key])) importFailure(`${path}.${key} must be a valid date.`);
}

function assertCalendarDateField(value: UnknownRecord, key: string, path: string) {
  if (!(key in value)) return;
  if (!isValidCalendarDateValue(value[key])) {
    importFailure(`${path}.${key} must use the YYYY-MM-DD calendar-date format.`);
  }
}

function assertBooleanField(value: UnknownRecord, key: string, path: string, required = false) {
  if (!(key in value)) {
    if (required) importFailure(`${path}.${key} is required.`);
    return;
  }
  if (typeof value[key] !== "boolean") importFailure(`${path}.${key} must be a boolean.`);
}

function assertEnumField(
  value: UnknownRecord,
  key: string,
  path: string,
  allowed: readonly string[],
  required = false,
) {
  if (!(key in value)) {
    if (required) importFailure(`${path}.${key} is required.`);
    return;
  }
  if (typeof value[key] !== "string" || !allowed.includes(value[key] as string)) {
    importFailure(`${path}.${key} is not supported.`);
  }
}

function assertStringField(
  value: UnknownRecord,
  key: string,
  path: string,
  allowEmpty = true,
  maximumCharacters?: number,
) {
  if (typeof value[key] !== "string" || (!allowEmpty && !value[key].trim())) {
    importFailure(`${path}.${key} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  if (maximumCharacters !== undefined && (value[key] as string).length > maximumCharacters) {
    importFailure(`${path}.${key} cannot exceed ${maximumCharacters.toLocaleString()} characters.`);
  }
  if (new TextEncoder().encode(value[key] as string).byteLength > MAX_WORKSPACE_STRING_BYTES) {
    importFailure(`${path}.${key} exceeds the per-string size limit.`);
  }
}

function assertStringItems(items: unknown[], path: string) {
  items.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) importFailure(`${path}[${index}] must be a non-empty string.`);
    if (new TextEncoder().encode(item).byteLength > MAX_WORKSPACE_STRING_BYTES) importFailure(`${path}[${index}] exceeds the per-string size limit.`);
  });
}

function assertExactKeys(value: UnknownRecord, path: string, allowed: readonly string[]) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) importFailure(`${path}.${unexpected} is not supported.`);
}

function validateGoalEvidence(items: unknown[], path: string, version: number, goalId: string) {
  if (items.length > MAX_GOAL_EVIDENCE_ITEMS) {
    importFailure(`${path} cannot contain more than ${MAX_GOAL_EVIDENCE_ITEMS} items.`);
  }
  if (version < 3) {
    assertStringItems(items, path);
    items.forEach((item, index) => {
      const decoded = decodeLegacyGoalEvidence(item as string, goalId, index);
      if (decoded.status === "invalid") {
        importFailure(`${path}[${index}] ${decoded.reason}.`);
      }
    });
    return;
  }

  const records = objectItems(items, path);
  const seen = new Set<string>();
  records.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isStableEvidenceId(item.id)) importFailure(`${itemPath}.id must be a stable evidence identifier.`);
    if (seen.has(item.id)) importFailure(`${path} contains duplicate id "${item.id}".`);
    seen.add(item.id);
    if (item.type === "note") {
      assertExactKeys(item, itemPath, ["id", "type", "text"]);
      assertStringField(item, "text", itemPath, false);
      if ((item.text as string).trim().length > MAX_EVIDENCE_NOTE_LENGTH) {
        importFailure(`${itemPath}.text cannot exceed ${MAX_EVIDENCE_NOTE_LENGTH} characters.`);
      }
      return;
    }
    if (item.type === "link") {
      assertExactKeys(item, itemPath, ["id", "type", "url"]);
      if (!isValidEvidenceUrl(item.url)) importFailure(`${itemPath}.url must be a valid HTTP or HTTPS URL within the supported length.`);
      return;
    }
    if (item.type === "file") {
      assertExactKeys(item, itemPath, ["id", "type", "name", "mimeType", "size", "remotePath"]);
      if (!isValidEvidenceFileName(item.name)) importFailure(`${itemPath}.name is invalid or too long.`);
      if (!isAllowedEvidenceMimeType(item.mimeType)) importFailure(`${itemPath}.mimeType is not supported.`);
      if (!isValidEvidenceFileSize(item.size)) importFailure(`${itemPath}.size must be a safe file size no larger than 10 MB.`);
      if ("remotePath" in item && !isStructurallyValidRemoteEvidencePath(item.remotePath, item.id as string, goalId)) {
        importFailure(`${itemPath}.remotePath is not a valid private file path.`);
      }
      return;
    }
    importFailure(`${itemPath}.type is not supported.`);
  });
}

function validateLinkedGoalIds(value: UnknownRecord, path: string) {
  if (!("linkedGoalIds" in value)) return [];
  const items = requiredArray(value, "linkedGoalIds", path);
  assertCollectionLimit(items, `${path}.linkedGoalIds`, COLLECTION_LIMITS.goalChildren);
  assertStringItems(items, `${path}.linkedGoalIds`);
  const goalIds = items as string[];
  const duplicate = goalIds.find((goalId, index) => goalIds.indexOf(goalId) !== index);
  if (duplicate) importFailure(`${path}.linkedGoalIds contains duplicate goal id "${duplicate}".`);
  return goalIds;
}

function validateAttributionSnapshot(value: unknown, path: string, includeGoalId = false) {
  if (!isRecord(value)) importFailure(`${path} must be an object.`);
  assertExactKeys(value, path, includeGoalId ? ["goalId", "areaId", "statIds"] : ["areaId", "statIds"]);
  if (includeGoalId) assertStringField(value, "goalId", path, false);
  assertStringField(value, "areaId", path, false);
  const statIds = requiredArray(value, "statIds", path);
  assertCollectionLimit(statIds, `${path}.statIds`, COLLECTION_LIMITS.stats);
  assertStringItems(statIds, `${path}.statIds`);
  if (new Set(statIds).size !== statIds.length) importFailure(`${path}.statIds contains duplicate ids.`);
  return value;
}

function validateGoalOutcomeSnapshot(value: unknown, path: string) {
  if (!isRecord(value)) importFailure(`${path} must be an object.`);
  assertExactKeys(value, path, [
    "version",
    "completedAt",
    "title",
    "description",
    "areaId",
    "statIds",
    "model",
    "priority",
    "targetDate",
    "metricCount",
    "milestoneCount",
    "checkInCount",
    "metrics",
    "milestones",
    "checkIns",
  ]);
  assertNumberField(value, "version", path, { minimum: 1, maximum: 1, integer: true });
  assertDateField(value, "completedAt", path, true);
  const completedAt = new Date(value.completedAt as string).getTime();
  assertStringField(value, "title", path, false, WORKSPACE_TEXT_LIMITS.goalTitle);
  assertStringField(value, "description", path, true, WORKSPACE_TEXT_LIMITS.goalDescription);
  assertStringField(value, "areaId", path, false, WORKSPACE_TEXT_LIMITS.identifier);
  assertEnumField(value, "model", path, GOAL_MODELS, true);
  assertEnumField(value, "priority", path, GOAL_PRIORITIES, true);
  assertCalendarDateField(value, "targetDate", path);
  const statIds = requiredArray(value, "statIds", path);
  assertCollectionLimit(statIds, `${path}.statIds`, COLLECTION_LIMITS.stats);
  assertStringItems(statIds, `${path}.statIds`);
  if (new Set(statIds).size !== statIds.length) {
    importFailure(`${path}.statIds contains duplicate ids.`);
  }

  const metrics = objectItems(requiredArray(value, "metrics", path), `${path}.metrics`);
  const milestones = objectItems(requiredArray(value, "milestones", path), `${path}.milestones`);
  const checkIns = objectItems(requiredArray(value, "checkIns", path), `${path}.checkIns`);
  assertCollectionLimit(metrics, `${path}.metrics`, MAX_GOAL_OUTCOME_METRICS);
  assertCollectionLimit(milestones, `${path}.milestones`, MAX_GOAL_OUTCOME_MILESTONES);
  assertCollectionLimit(checkIns, `${path}.checkIns`, MAX_GOAL_OUTCOME_CHECK_INS);
  assertUniqueIds(metrics, `${path}.metrics`);
  assertUniqueIds(milestones, `${path}.milestones`);
  assertUniqueIds(checkIns, `${path}.checkIns`);

  metrics.forEach((metric, index) => {
    const metricPath = `${path}.metrics[${index}]`;
    assertExactKeys(metric, metricPath, [
      "id",
      "label",
      "current",
      "target",
      "unit",
      "weight",
      "period",
      "periodKey",
    ]);
    assertStringField(metric, "label", metricPath, false, WORKSPACE_TEXT_LIMITS.metricLabel);
    assertStringField(metric, "unit", metricPath, true, WORKSPACE_TEXT_LIMITS.metricUnit);
    assertNumberField(metric, "current", metricPath, { minimum: 0 });
    assertNumberField(metric, "target", metricPath, { minimum: 0, exclusiveMinimum: true });
    assertNumberField(metric, "weight", metricPath, { minimum: 0, maximum: 100 });
    if ("period" in metric) {
      assertEnumField(metric, "period", metricPath, CONSISTENCY_PERIODS, true);
      if (
        "periodKey" in metric
        && (
          typeof metric.periodKey !== "string"
          || !isPeriodKey(metric.period as ConsistencyPeriod, metric.periodKey)
        )
      ) {
        importFailure(`${metricPath}.periodKey is not valid for ${metric.period}.`);
      }
    } else if ("periodKey" in metric) {
      importFailure(`${metricPath}.periodKey requires a period.`);
    }
  });
  milestones.forEach((milestone, index) => {
    const milestonePath = `${path}.milestones[${index}]`;
    assertExactKeys(milestone, milestonePath, [
      "id",
      "title",
      "weight",
      "completed",
      "completedAt",
    ]);
    assertStringField(milestone, "title", milestonePath, false, WORKSPACE_TEXT_LIMITS.milestoneTitle);
    assertNumberField(milestone, "weight", milestonePath, { minimum: 0, maximum: 100 });
    assertBooleanField(milestone, "completed", milestonePath, true);
    assertDateField(milestone, "completedAt", milestonePath);
    if (
      typeof milestone.completedAt === "string"
      && new Date(milestone.completedAt).getTime() > completedAt
    ) {
      importFailure(`${milestonePath}.completedAt cannot be after the goal completion.`);
    }
  });
  checkIns.forEach((checkIn, index) => {
    const checkInPath = `${path}.checkIns[${index}]`;
    assertExactKeys(checkIn, checkInPath, ["id", "createdAt", "note"]);
    assertDateField(checkIn, "createdAt", checkInPath, true);
    assertStringField(checkIn, "note", checkInPath, false, WORKSPACE_TEXT_LIMITS.checkIn);
    if (new Date(checkIn.createdAt as string).getTime() > completedAt) {
      importFailure(`${checkInPath}.createdAt cannot be after the goal completion.`);
    }
  });

  for (const [key, retained] of [
    ["metricCount", metrics.length],
    ["milestoneCount", milestones.length],
    ["checkInCount", checkIns.length],
  ] as const) {
    assertNumberField(value, key, path, {
      minimum: retained,
      maximum: COLLECTION_LIMITS.goalChildren,
      integer: true,
    });
  }
}

function validateReviewContextSnapshot(
  value: unknown,
  path: string,
  reviewCreatedAt: unknown,
) {
  if (!isRecord(value)) importFailure(`${path} must be an object.`);
  assertExactKeys(value, path, [
    "version",
    "periodStartedAt",
    "periodEndedAt",
    "activeDays",
    "questsCompleted",
    "metricsUpdated",
    "milestonesReached",
    "checkInsRecorded",
    "goalsCompleted",
    "goalsWithActivity",
    "sourceCount",
    "sources",
  ]);
  assertNumberField(value, "version", path, { minimum: 1, maximum: 1, integer: true });
  assertDateField(value, "periodStartedAt", path, true);
  assertDateField(value, "periodEndedAt", path, true);
  const periodStartedAt = new Date(value.periodStartedAt as string).getTime();
  const periodEndedAt = new Date(value.periodEndedAt as string).getTime();
  if (periodStartedAt > periodEndedAt) {
    importFailure(`${path}.periodStartedAt cannot be after periodEndedAt.`);
  }
  if (
    typeof reviewCreatedAt !== "string"
    || new Date(reviewCreatedAt).getTime() !== periodEndedAt
  ) {
    importFailure(`${path}.periodEndedAt must match the saved review time.`);
  }

  const countKeys = [
    "activeDays",
    "questsCompleted",
    "metricsUpdated",
    "milestonesReached",
    "checkInsRecorded",
    "goalsCompleted",
    "goalsWithActivity",
    "sourceCount",
  ] as const;
  countKeys.forEach((key) => assertNumberField(value, key, path, {
    minimum: 0,
    maximum: MAX_WORKSPACE_NODES,
    integer: true,
  }));

  const sources = objectItems(requiredArray(value, "sources", path), `${path}.sources`);
  assertCollectionLimit(sources, `${path}.sources`, MAX_REVIEW_CONTEXT_SOURCES);
  const seen = new Set<string>();
  const retainedCounts = new Map<string, number>();
  sources.forEach((item, index) => {
    const itemPath = `${path}.sources[${index}]`;
    assertExactKeys(item, itemPath, [
      "sourceId",
      "type",
      "title",
      "detail",
      "occurredAt",
      "goalId",
    ]);
    assertStringField(item, "sourceId", itemPath, false, WORKSPACE_TEXT_LIMITS.identifier);
    assertEnumField(item, "type", itemPath, REVIEW_SOURCE_TYPES, true);
    assertStringField(item, "title", itemPath, false, MAX_REVIEW_SOURCE_TITLE_LENGTH);
    assertStringField(item, "detail", itemPath, true, MAX_REVIEW_SOURCE_DETAIL_LENGTH);
    assertDateField(item, "occurredAt", itemPath, true);
    if ("goalId" in item) {
      assertStringField(item, "goalId", itemPath, false, WORKSPACE_TEXT_LIMITS.identifier);
    }
    const occurredAt = new Date(item.occurredAt as string).getTime();
    if (occurredAt < periodStartedAt || occurredAt > periodEndedAt) {
      importFailure(`${itemPath}.occurredAt must fall within the saved review period.`);
    }
    const uniqueKey = `${item.type}\u0000${item.sourceId}`;
    if (seen.has(uniqueKey)) {
      importFailure(`${path}.sources contains a duplicate source record.`);
    }
    seen.add(uniqueKey);
    retainedCounts.set(item.type as string, (retainedCounts.get(item.type as string) ?? 0) + 1);
  });

  const sourceCount = value.sourceCount as number;
  if (sourceCount < sources.length) {
    importFailure(`${path}.sourceCount cannot be smaller than the retained source list.`);
  }
  const typedCounts = [
    ["quest", "questsCompleted"],
    ["metric", "metricsUpdated"],
    ["milestone", "milestonesReached"],
    ["check-in", "checkInsRecorded"],
    ["goal", "goalsCompleted"],
  ] as const;
  typedCounts.forEach(([type, key]) => {
    if ((value[key] as number) < (retainedCounts.get(type) ?? 0)) {
      importFailure(`${path}.${key} cannot be smaller than its retained source records.`);
    }
  });
  const typedTotal = typedCounts.reduce((total, [, key]) => total + (value[key] as number), 0);
  if (typedTotal !== sourceCount) {
    importFailure(`${path}.sourceCount must equal the saved source-type totals.`);
  }
  if ((value.activeDays as number) > sourceCount || (value.goalsWithActivity as number) > sourceCount) {
    importFailure(`${path} activity totals cannot exceed sourceCount.`);
  }
}

function assertNumberField(
  value: UnknownRecord,
  key: string,
  path: string,
  {
    required = true,
    minimum = -Number.MAX_SAFE_INTEGER,
    maximum = Number.MAX_SAFE_INTEGER,
    exclusiveMinimum = false,
    integer = false,
  }: {
    required?: boolean;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: boolean;
    integer?: boolean;
  } = {},
) {
  if (!(key in value)) {
    if (required) importFailure(`${path}.${key} must be a finite number.`);
    return;
  }
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    importFailure(`${path}.${key} must be a finite number.`);
  }
  if (integer && !Number.isSafeInteger(candidate)) {
    importFailure(`${path}.${key} must be a safe integer.`);
  }
  if (exclusiveMinimum ? candidate <= minimum : candidate < minimum) {
    importFailure(exclusiveMinimum
      ? `${path}.${key} must be greater than ${minimum}.`
      : minimum === 0
        ? `${path}.${key} cannot be negative.`
        : `${path}.${key} cannot be less than ${minimum}.`);
  }
  if (candidate > maximum) importFailure(`${path}.${key} cannot exceed ${maximum}.`);
}

function assertOptionalBoundedString(value: UnknownRecord, key: string, path: string, maximum: number) {
  if (!(key in value)) return;
  if (typeof value[key] !== "string" || !value[key].trim()) {
    importFailure(`${path}.${key} must be a non-empty string when present.`);
  }
  if (value[key].trim().length > maximum) {
    importFailure(`${path}.${key} cannot exceed ${maximum} characters.`);
  }
}

function validateMetricDeltas(items: unknown[], path: string) {
  assertCollectionLimit(items, path, COLLECTION_LIMITS.goalChildren);
  const deltas = objectItems(items, path);
  const metricIds = new Set<string>();
  deltas.forEach((delta, index) => {
    const deltaPath = `${path}[${index}]`;
    assertStringField(delta, "metricId", deltaPath, false);
    assertNumberField(delta, "amount", deltaPath);
    const metricId = delta.metricId as string;
    if (metricIds.has(metricId)) importFailure(`${path} contains duplicate metricId "${metricId}".`);
    metricIds.add(metricId);
  });
  return deltas;
}

function validateGoalStructure(goal: UnknownRecord, goalIndex: number, version: number) {
  const path = `workspace.goals[${goalIndex}]`;
  const requireCurrentScalar = version >= CURRENT_STATE_VERSION;
  assertStringField(goal, "title", path, false, WORKSPACE_TEXT_LIMITS.goalTitle);
  assertStringField(goal, "description", path, true, WORKSPACE_TEXT_LIMITS.goalDescription);
  assertStringField(goal, "notes", path, true, WORKSPACE_TEXT_LIMITS.goalNotes);
  assertStringField(goal, "areaId", path, false);
  assertEnumField(goal, "model", path, GOAL_MODELS, requireCurrentScalar);
  assertEnumField(goal, "priority", path, GOAL_PRIORITIES, requireCurrentScalar);
  assertEnumField(goal, "status", path, GOAL_STATUSES, requireCurrentScalar);
  assertDateField(goal, "createdAt", path, true);
  if (requireCurrentScalar) assertCalendarDateField(goal, "targetDate", path);
  else assertDateField(goal, "targetDate", path);
  assertDateField(goal, "completedAt", path);
  if ("completionSnapshot" in goal) {
    validateGoalOutcomeSnapshot(goal.completionSnapshot, `${path}.completionSnapshot`);
    const snapshot = goal.completionSnapshot as UnknownRecord;
    if (
      typeof goal.completedAt !== "string"
      || new Date(snapshot.completedAt as string).getTime() !== new Date(goal.completedAt).getTime()
    ) {
      importFailure(`${path}.completionSnapshot does not match its first completion time.`);
    }
  }

  const metrics = objectItems(requiredArray(goal, "metrics", path), `${path}.metrics`);
  const milestones = objectItems(requiredArray(goal, "milestones", path), `${path}.milestones`);
  const quests = objectItems(requiredArray(goal, "quests", path), `${path}.quests`);
  assertCollectionLimit(metrics, `${path}.metrics`, COLLECTION_LIMITS.goalChildren);
  assertCollectionLimit(milestones, `${path}.milestones`, COLLECTION_LIMITS.goalChildren);
  assertCollectionLimit(quests, `${path}.quests`, COLLECTION_LIMITS.goalChildren);
  assertUniqueIds(metrics, `${path}.metrics`);
  assertUniqueIds(milestones, `${path}.milestones`);
  assertUniqueIds(quests, `${path}.quests`);
  const metricIds = new Set(metrics.map((metric) => requiredId(metric, `${path}.metrics`)));

  metrics.forEach((metric, index) => {
    const metricPath = `${path}.metrics[${index}]`;
    assertStringField(metric, "label", metricPath, false, WORKSPACE_TEXT_LIMITS.metricLabel);
    assertStringField(metric, "unit", metricPath, true, WORKSPACE_TEXT_LIMITS.metricUnit);
    assertNumberField(metric, "current", metricPath, { minimum: 0 });
    assertNumberField(metric, "target", metricPath, { minimum: 0, exclusiveMinimum: true });
    assertNumberField(metric, "weight", metricPath, { minimum: 0, maximum: 100 });
    if (!("period" in metric)) {
      if ("periodKey" in metric) importFailure(`${metricPath}.periodKey requires a period.`);
      return;
    }
    assertEnumField(metric, "period", metricPath, CONSISTENCY_PERIODS);
    if (
      "periodKey" in metric &&
      (typeof metric.periodKey !== "string" || !isPeriodKey(metric.period as ConsistencyPeriod, metric.periodKey))
    ) {
      importFailure(`${metricPath}.periodKey is not valid for ${metric.period}.`);
    }
  });
  if (version >= CURRENT_STATE_VERSION && (goal.model === "numeric" || goal.model === "consistency")) {
    if (!metrics.length) {
      importFailure(`${path}.metrics must include at least one metric for the ${goal.model} model.`);
    }
    if (!metrics.some((metric) => Number(metric.weight) > 0)) {
      importFailure(`${path}.metrics must include at least one positive relative weight.`);
    }
    if (goal.model === "consistency") {
      metrics.forEach((metric, index) => {
        const metricPath = `${path}.metrics[${index}]`;
        if (!("period" in metric)) {
          importFailure(`${metricPath}.period is required for a consistency metric.`);
        }
        if (!("periodKey" in metric)) {
          importFailure(`${metricPath}.periodKey is required for a consistency metric.`);
        }
      });
    }
  }

  let milestoneWeight = 0;
  milestones.forEach((milestone, index) => {
    const milestonePath = `${path}.milestones[${index}]`;
    assertStringField(milestone, "title", milestonePath, false, WORKSPACE_TEXT_LIMITS.milestoneTitle);
    assertBooleanField(milestone, "completed", milestonePath, requireCurrentScalar);
    assertDateField(milestone, "completedAt", milestonePath);
    assertNumberField(milestone, "weight", milestonePath, { minimum: 0, maximum: 100 });
    milestoneWeight += milestone.weight as number;
    if ("attribution" in milestone) {
      validateAttributionSnapshot(milestone.attribution, `${milestonePath}.attribution`);
    }
  });
  // Even splits such as 100 / 6 can sum a few floating-point ulps above 100.
  if (milestoneWeight > 100 + 1e-9) {
    importFailure(`${path}.milestones total weight cannot exceed 100.`);
  }
  quests.forEach((quest, questIndex) => {
    const questPath = `${path}.quests[${questIndex}]`;
    assertStringField(quest, "title", questPath, false, WORKSPACE_TEXT_LIMITS.actionTitle);
    if ("description" in quest) {
      assertStringField(quest, "description", questPath, false, WORKSPACE_TEXT_LIMITS.actionDescription);
    }
    assertEnumField(quest, "kind", questPath, QUEST_KINDS, requireCurrentScalar);
    assertEnumField(quest, "repeat", questPath, QUEST_REPEATS, requireCurrentScalar);
    assertBooleanField(quest, "completed", questPath, requireCurrentScalar);
    if (requireCurrentScalar) assertCalendarDateField(quest, "dueDate", questPath);
    else assertDateField(quest, "dueDate", questPath);
    assertDateField(quest, "completedAt", questPath);
    if ("monthlyAnchorDay" in quest) {
      assertNumberField(quest, "monthlyAnchorDay", questPath, {
        minimum: 1,
        maximum: 31,
        integer: true,
      });
      if (quest.repeat !== "monthly") {
        importFailure(`${questPath}.monthlyAnchorDay is only supported for a monthly repeat.`);
      }
    }
    validateLinkedGoalIds(quest, questPath);
    const deltas = validateMetricDeltas(
      requiredArray(quest, "metricDeltas", questPath),
      `${questPath}.metricDeltas`,
    );
    deltas.forEach((delta) => {
      if (!metricIds.has(delta.metricId as string)) {
        importFailure(`action "${requiredId(quest, questPath)}" references missing metric "${delta.metricId}".`);
      }
    });
    assertNumberField(quest, "durationMinutes", questPath, { required: false, minimum: 0 });
  });

  const evidence = requiredArray(goal, "evidence", path);
  validateGoalEvidence(evidence, `${path}.evidence`, version, requiredId(goal, path));
  if (version >= 2) {
    const statIds = requiredArray(goal, "statIds", path);
    assertCollectionLimit(statIds, `${path}.statIds`, COLLECTION_LIMITS.stats);
    assertStringItems(statIds, `${path}.statIds`);
    if (new Set(statIds).size !== statIds.length) importFailure(`${path}.statIds contains duplicate ids.`);
    const checkIns = objectItems(requiredArray(goal, "checkIns", path), `${path}.checkIns`);
    assertCollectionLimit(checkIns, `${path}.checkIns`, COLLECTION_LIMITS.goalChildren);
    assertUniqueIds(checkIns, `${path}.checkIns`);
    checkIns.forEach((checkIn, index) => {
      assertDateField(checkIn, "createdAt", `${path}.checkIns[${index}]`, true);
      assertStringField(checkIn, "note", `${path}.checkIns[${index}]`, false, WORKSPACE_TEXT_LIMITS.checkIn);
      if ("attribution" in checkIn) {
        validateAttributionSnapshot(checkIn.attribution, `${path}.checkIns[${index}].attribution`);
      }
    });
  } else {
    if ("statWeights" in goal && !isRecord(goal.statWeights)) importFailure(`${path}.statWeights must be an object.`);
    if ("checkIns" in goal && !Array.isArray(goal.checkIns)) importFailure(`${path}.checkIns must be an array.`);
  }
}

function assertLinkedGoalReferences(goals: UnknownRecord[], questCompletions: UnknownRecord[]) {
  const goalIds = new Set(goals.map((goal, goalIndex) => requiredId(goal, `workspace.goals[${goalIndex}]`)));

  goals.forEach((goal, goalIndex) => {
    const goalPath = `workspace.goals[${goalIndex}]`;
    const primaryGoalId = requiredId(goal, goalPath);
    const quests = objectItems(requiredArray(goal, "quests", goalPath), `${goalPath}.quests`);
    quests.forEach((quest, questIndex) => {
      const questPath = `${goalPath}.quests[${questIndex}]`;
      const questId = requiredId(quest, questPath);
      validateLinkedGoalIds(quest, questPath).forEach((linkedGoalId) => {
        if (linkedGoalId === primaryGoalId) {
          importFailure(`action "${questId}" cannot link primary goal "${primaryGoalId}" as an additional goal.`);
        }
        if (!goalIds.has(linkedGoalId)) {
          importFailure(`action "${questId}" references missing linked goal "${linkedGoalId}".`);
        }
      });
    });
  });

  questCompletions.forEach((completion, completionIndex) => {
    const completionPath = `workspace.questCompletions[${completionIndex}]`;
    const completionId = requiredId(completion, completionPath);
    const primaryGoalId = completion.goalId as string;
    validateLinkedGoalIds(completion, completionPath).forEach((linkedGoalId) => {
      if (linkedGoalId === primaryGoalId) {
        importFailure(`action history "${completionId}" cannot link primary goal "${primaryGoalId}" as an additional goal.`);
      }
      if (!goalIds.has(linkedGoalId)) {
        importFailure(`action history "${completionId}" references missing linked goal "${linkedGoalId}".`);
      }
    });
  });
}

/**
 * Validates a user-selected backup before it can replace the active workspace.
 * The same boundary is used for device and cloud snapshots so malformed data is
 * quarantined or recovered from a valid undo snapshot instead of silently
 * deleting nested records and being written back as if it were authoritative.
 */
export function parseImportedState(value: unknown, now = new Date().toISOString()): AppState {
  if (!isRecord(value)) importFailure("the root value must be an object.");
  assertJsonCompatible(value);
  const serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (serializedBytes > MAX_WORKSPACE_SERIALIZED_BYTES) {
    importFailure(`workspace is larger than the ${Math.round(MAX_WORKSPACE_SERIALIZED_BYTES / (1024 * 1024))} MB safety limit.`);
  }

  if (!Number.isInteger(value.version) || typeof value.version !== "number" || value.version < 1) {
    importFailure("workspace.version must be a supported positive integer.");
  }
  const version = value.version;
  if (version > CURRENT_STATE_VERSION) {
    importFailure(`workspace version ${version} is newer than this app supports.`);
  }

  assertDateField(value, "updatedAt", "workspace", true);
  const requireCurrentScalar = version >= CURRENT_STATE_VERSION;
  const profile = requiredRecord(value, "profile");
  assertStringField(profile, "displayName", "workspace.profile", true, WORKSPACE_TEXT_LIMITS.profileName);
  assertStringField(profile, "chapter", "workspace.profile", true, WORKSPACE_TEXT_LIMITS.profileChapter);
  assertBooleanField(profile, "onboarded", "workspace.profile", requireCurrentScalar);
  assertDateField(profile, "createdAt", "workspace.profile", true);

  const settings = requiredRecord(value, "settings");
  assertEnumField(settings, "theme", "workspace.settings", SETTINGS_THEMES, requireCurrentScalar);
  assertEnumField(
    settings,
    "interfaceIntensity",
    "workspace.settings",
    INTERFACE_INTENSITIES,
    requireCurrentScalar,
  );
  // The retired v1/v2 intensity alias remains importable when valid, but its
  // presence must never let a malformed scalar bypass quarantine.
  assertEnumField(settings, "gameIntensity", "workspace.settings", INTERFACE_INTENSITIES);
  assertBooleanField(settings, "notifications", "workspace.settings", requireCurrentScalar);
  const terminology = requiredRecord(settings, "terminology", "workspace.settings");
  ["goals", "quests", "areas", "milestones", "stats"].forEach((key) =>
    assertStringField(terminology, key, "workspace.settings.terminology", false, WORKSPACE_TEXT_LIMITS.terminology));
  if (requireCurrentScalar) {
    assertCalendarDateField(settings, "birthDate", "workspace.settings");
  } else {
    assertDateField(settings, "birthDate", "workspace.settings");
  }
  if ("reminderTime" in settings && (typeof settings.reminderTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.reminderTime))) {
    importFailure("workspace.settings.reminderTime must use 24-hour HH:MM format.");
  }
  for (const key of ["dashboardOrder", "hiddenDashboardSections"] as const) {
    if (!(key in settings)) continue;
    const items = requiredArray(settings, key, "workspace.settings");
    assertStringItems(items, `workspace.settings.${key}`);
    if (new Set(items).size !== items.length) importFailure(`workspace.settings.${key} contains duplicate entries.`);
    if (items.some((item) => !DASHBOARD_SECTIONS.includes(item as DashboardSectionId))) {
      importFailure(`workspace.settings.${key} contains an unsupported section.`);
    }
  }

  const areas = objectItems(requiredArray(value, "areas"), "workspace.areas");
  const stats = objectItems(requiredArray(value, "stats"), "workspace.stats");
  const goals = objectItems(requiredArray(value, "goals"), "workspace.goals");
  const reviews = objectItems(requiredArray(value, "reviews"), "workspace.reviews");
  const timeline = objectItems(requiredArray(value, "timeline"), "workspace.timeline");
  assertCollectionLimit(areas, "workspace.areas", COLLECTION_LIMITS.areas);
  assertCollectionLimit(stats, "workspace.stats", COLLECTION_LIMITS.stats);
  assertCollectionLimit(goals, "workspace.goals", COLLECTION_LIMITS.goals);
  assertCollectionLimit(reviews, "workspace.reviews", COLLECTION_LIMITS.reviews);
  assertCollectionLimit(timeline, "workspace.timeline", COLLECTION_LIMITS.timeline);
  assertUniqueIds(areas, "workspace.areas");
  assertUniqueIds(stats, "workspace.stats");
  assertUniqueIds(goals, "workspace.goals");
  assertUniqueIds(reviews, "workspace.reviews");
  assertUniqueIds(timeline, "workspace.timeline");

  areas.forEach((area, index) => {
    const path = `workspace.areas[${index}]`;
    assertStringField(area, "name", path, false, WORKSPACE_TEXT_LIMITS.areaOrQualityName);
    assertStringField(area, "color", path, false, WORKSPACE_TEXT_LIMITS.color);
    assertStringField(area, "icon", path, false, WORKSPACE_TEXT_LIMITS.icon);
    assertNumberField(area, "order", `workspace.areas[${index}]`, {
      minimum: 0,
      integer: true,
    });
    assertBooleanField(area, "hidden", path);
    assertBooleanField(area, "archived", path);
  });
  stats.forEach((stat, index) => {
    const path = `workspace.stats[${index}]`;
    assertStringField(stat, "name", path, false, WORKSPACE_TEXT_LIMITS.areaOrQualityName);
    assertStringField(stat, "color", path, false, WORKSPACE_TEXT_LIMITS.color);
    assertStringField(stat, "icon", path, false, WORKSPACE_TEXT_LIMITS.icon);
    assertBooleanField(stat, "archived", path);
  });

  goals.forEach((goal, index) => validateGoalStructure(goal, index, version));
  reviews.forEach((review, index) => {
    const path = `workspace.reviews[${index}]`;
    assertEnumField(review, "cadence", path, REVIEW_CADENCES, requireCurrentScalar);
    assertDateField(review, "createdAt", path, true);
    if (!isRecord(review.answers)) importFailure(`${path}.answers must be an object.`);
    if (Object.keys(review.answers).length > COLLECTION_LIMITS.reviewAnswers) {
      importFailure(`${path}.answers cannot contain more than ${COLLECTION_LIMITS.reviewAnswers} entries.`);
    }
    Object.entries(review.answers).forEach(([key, answer]) => {
      if (!key.trim() || key.length > WORKSPACE_TEXT_LIMITS.reviewAnswerKey) {
        importFailure(`${path}.answers contains an invalid or overlong key.`);
      }
      if (typeof answer !== "string" || answer.length > WORKSPACE_TEXT_LIMITS.reviewAnswer) {
        importFailure(`${path}.answers.${key} must be a string no longer than ${WORKSPACE_TEXT_LIMITS.reviewAnswer.toLocaleString()} characters.`);
      }
    });
    if ("context" in review) {
      validateReviewContextSnapshot(review.context, `${path}.context`, review.createdAt);
    }
  });
  timeline.forEach((event, index) => {
    const path = `workspace.timeline[${index}]`;
    assertStringField(event, "title", path, false, WORKSPACE_TEXT_LIMITS.timelineTitle);
    assertStringField(event, "detail", path, true, WORKSPACE_TEXT_LIMITS.timelineDetail);
    assertDateField(event, "at", path, true);
    const legacyRemovedType = version === 1 && event.type === "level";
    if (!TIMELINE_TYPES.includes(event.type as TimelineEvent["type"]) && !legacyRemovedType) {
      importFailure(`${path}.type is not supported.`);
    }
    for (const key of ["relatedGoalIds", "relatedAreaIds", "relatedStatIds"] as const) {
      if (!(key in event)) continue;
      const ids = requiredArray(event, key, path);
      assertCollectionLimit(ids, `${path}.${key}`, COLLECTION_LIMITS.goalChildren);
      assertStringItems(ids, `${path}.${key}`);
      if (new Set(ids).size !== ids.length) importFailure(`${path}.${key} contains duplicate ids.`);
    }
  });

  let questCompletions: UnknownRecord[] = [];
  let metricEntries: UnknownRecord[] = [];
  if (version >= 2) {
    questCompletions = objectItems(requiredArray(value, "questCompletions"), "workspace.questCompletions");
    metricEntries = objectItems(requiredArray(value, "metricEntries"), "workspace.metricEntries");
    assertUniqueIds(questCompletions, "workspace.questCompletions");
    assertUniqueIds(metricEntries, "workspace.metricEntries");
    assertCollectionLimit(questCompletions, "workspace.questCompletions", COLLECTION_LIMITS.questCompletions);
    assertCollectionLimit(metricEntries, "workspace.metricEntries", COLLECTION_LIMITS.metricEntries);
  } else {
    if ("questCompletions" in value && !Array.isArray(value.questCompletions)) {
      importFailure("workspace.questCompletions must be an array when present.");
    }
    if ("metricEntries" in value && !Array.isArray(value.metricEntries)) {
      importFailure("workspace.metricEntries must be an array when present.");
    }
  }

  questCompletions.forEach((completion, index) => {
    const path = `workspace.questCompletions[${index}]`;
    assertStringField(completion, "goalId", path, false);
    assertStringField(completion, "questId", path, false);
    assertStringField(completion, "title", path, false, WORKSPACE_TEXT_LIMITS.actionTitle);
    const linkedGoalIds = validateLinkedGoalIds(completion, path);
    if ("goalSnapshots" in completion) {
      const snapshots = objectItems(requiredArray(completion, "goalSnapshots", path), `${path}.goalSnapshots`);
      const snapshotGoalIds = snapshots.map((snapshot, snapshotIndex) => {
        validateAttributionSnapshot(snapshot, `${path}.goalSnapshots[${snapshotIndex}]`, true);
        return snapshot.goalId as string;
      });
      if (new Set(snapshotGoalIds).size !== snapshotGoalIds.length) {
        importFailure(`${path}.goalSnapshots contains duplicate goal ids.`);
      }
      const expectedGoalIds = new Set([completion.goalId as string, ...linkedGoalIds]);
      if (snapshotGoalIds.length !== expectedGoalIds.size || snapshotGoalIds.some((goalId) => !expectedGoalIds.has(goalId))) {
        importFailure(`${path}.goalSnapshots must match the completion's primary and linked goals.`);
      }
    }
    assertDateField(completion, "completedAt", path, true);
    assertNumberField(completion, "durationMinutes", path, { required: false, minimum: 0 });
    if ("note" in completion) {
      assertStringField(completion, "note", path, false, WORKSPACE_TEXT_LIMITS.completionNote);
    }
    if ("evidence" in completion) {
      const evidence = requiredArray(completion, "evidence", path);
      assertCollectionLimit(evidence, `${path}.evidence`, MAX_GOAL_EVIDENCE_ITEMS);
      assertStringItems(evidence, `${path}.evidence`);
      evidence.forEach((item, evidenceIndex) => {
        if ((item as string).length > WORKSPACE_TEXT_LIMITS.completionEvidenceItem) {
          importFailure(`${path}.evidence[${evidenceIndex}] cannot exceed ${WORKSPACE_TEXT_LIMITS.completionEvidenceItem.toLocaleString()} characters.`);
        }
      });
    }
    if ("metricDeltas" in completion) {
      validateMetricDeltas(requiredArray(completion, "metricDeltas", path), `${path}.metricDeltas`);
    }
  });
  assertLinkedGoalReferences(goals, questCompletions);
  metricEntries.forEach((entry, index) => {
    const path = `workspace.metricEntries[${index}]`;
    assertStringField(entry, "goalId", path, false);
    assertStringField(entry, "metricId", path, false);
    assertDateField(entry, "recordedAt", path, true);
    assertNumberField(entry, "value", path, { minimum: 0 });
    assertNumberField(entry, "previousValue", path, { minimum: 0 });
    assertEnumField(entry, "source", path, METRIC_ENTRY_SOURCES, requireCurrentScalar);
    assertOptionalBoundedString(entry, "label", path, 120);
    assertOptionalBoundedString(entry, "unit", path, 32);
    if ("sourceCompletionId" in entry) assertStringField(entry, "sourceCompletionId", path, false);
    if ("attribution" in entry) validateAttributionSnapshot(entry.attribution, `${path}.attribution`);
  });

  const migrated = migrateState(value, now);
  assertMigratedStateCoherence(migrated, version, importFailure);
  // Prime exact resource profiles at the untrusted boundary. Later internal
  // copy-on-write commands can reuse every untouched subtree instead of
  // serialising or walking the full workspace again.
  profileJsonValue(migrated);
  return migrated;
}

const changedCollectionItems = <T extends object>(
  previous: readonly T[],
  next: readonly T[],
) => {
  const previousReferences = new Set<object>(previous);
  return next.filter((item) => !previousReferences.has(item));
};

const removedCollectionIds = <T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
) => {
  const nextIds = new Set(next.map((item) => item.id));
  return previous.some((item) => !nextIds.has(item.id));
};

function validateCurrentSettingsStructure(settings: UnknownRecord) {
  assertEnumField(settings, "theme", "workspace.settings", SETTINGS_THEMES, true);
  assertEnumField(
    settings,
    "interfaceIntensity",
    "workspace.settings",
    INTERFACE_INTENSITIES,
    true,
  );
  assertBooleanField(settings, "notifications", "workspace.settings", true);
  const terminology = requiredRecord(settings, "terminology", "workspace.settings");
  ["goals", "quests", "areas", "milestones", "stats"].forEach((key) =>
    assertStringField(
      terminology,
      key,
      "workspace.settings.terminology",
      false,
      WORKSPACE_TEXT_LIMITS.terminology,
    ));
  assertCalendarDateField(settings, "birthDate", "workspace.settings");
  if (
    "reminderTime" in settings
    && (
      typeof settings.reminderTime !== "string"
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.reminderTime)
    )
  ) {
    importFailure("workspace.settings.reminderTime must use 24-hour HH:MM format.");
  }
  for (const key of ["dashboardOrder", "hiddenDashboardSections"] as const) {
    const items = requiredArray(settings, key, "workspace.settings");
    assertStringItems(items, `workspace.settings.${key}`);
    if (new Set(items).size !== items.length) {
      importFailure(`workspace.settings.${key} contains duplicate entries.`);
    }
    if (items.some((item) => !DASHBOARD_SECTIONS.includes(item as DashboardSectionId))) {
      importFailure(`workspace.settings.${key} contains an unsupported section.`);
    }
    if (
      key === "dashboardOrder"
      && (
        items.length !== DASHBOARD_SECTIONS.length
        || DASHBOARD_SECTIONS.some((section) => !items.includes(section))
      )
    ) {
      importFailure("workspace.settings.dashboardOrder must contain every dashboard section exactly once.");
    }
  }
}

function validateCurrentReviewStructure(review: UnknownRecord, index: number) {
  const path = `workspace.reviews[${index}]`;
  assertEnumField(review, "cadence", path, REVIEW_CADENCES, true);
  assertDateField(review, "createdAt", path, true);
  if (!isRecord(review.answers)) importFailure(`${path}.answers must be an object.`);
  if (Object.keys(review.answers).length > COLLECTION_LIMITS.reviewAnswers) {
    importFailure(`${path}.answers cannot contain more than ${COLLECTION_LIMITS.reviewAnswers} entries.`);
  }
  Object.entries(review.answers).forEach(([key, answer]) => {
    if (!key.trim() || key.length > WORKSPACE_TEXT_LIMITS.reviewAnswerKey) {
      importFailure(`${path}.answers contains an invalid or overlong key.`);
    }
    if (typeof answer !== "string" || answer.length > WORKSPACE_TEXT_LIMITS.reviewAnswer) {
      importFailure(`${path}.answers.${key} must be a string no longer than ${WORKSPACE_TEXT_LIMITS.reviewAnswer.toLocaleString()} characters.`);
    }
  });
  if ("context" in review) {
    validateReviewContextSnapshot(review.context, `${path}.context`, review.createdAt);
  }
}

function validateCurrentTimelineStructure(event: UnknownRecord, index: number) {
  const path = `workspace.timeline[${index}]`;
  assertStringField(event, "title", path, false, WORKSPACE_TEXT_LIMITS.timelineTitle);
  assertStringField(event, "detail", path, true, WORKSPACE_TEXT_LIMITS.timelineDetail);
  assertDateField(event, "at", path, true);
  assertEnumField(event, "type", path, TIMELINE_TYPES, true);
  if ("goalId" in event) assertStringField(event, "goalId", path, false);
  if ("areaId" in event) assertStringField(event, "areaId", path, false);
  for (const key of ["relatedGoalIds", "relatedAreaIds", "relatedStatIds"] as const) {
    if (!(key in event)) continue;
    const ids = requiredArray(event, key, path);
    assertCollectionLimit(ids, `${path}.${key}`, COLLECTION_LIMITS.goalChildren);
    assertStringItems(ids, `${path}.${key}`);
    if (new Set(ids).size !== ids.length) {
      importFailure(`${path}.${key} contains duplicate ids.`);
    }
  }
}

function validateCurrentCompletionStructure(
  completion: UnknownRecord,
  index: number,
) {
  const path = `workspace.questCompletions[${index}]`;
  assertStringField(completion, "goalId", path, false);
  assertStringField(completion, "questId", path, false);
  assertStringField(completion, "title", path, false, WORKSPACE_TEXT_LIMITS.actionTitle);
  const linkedGoalIds = validateLinkedGoalIds(completion, path);
  if ("goalSnapshots" in completion) {
    const snapshots = objectItems(
      requiredArray(completion, "goalSnapshots", path),
      `${path}.goalSnapshots`,
    );
    const snapshotGoalIds = snapshots.map((snapshot, snapshotIndex) => {
      validateAttributionSnapshot(
        snapshot,
        `${path}.goalSnapshots[${snapshotIndex}]`,
        true,
      );
      return snapshot.goalId as string;
    });
    if (new Set(snapshotGoalIds).size !== snapshotGoalIds.length) {
      importFailure(`${path}.goalSnapshots contains duplicate goal ids.`);
    }
    const expectedGoalIds = new Set([
      completion.goalId as string,
      ...linkedGoalIds,
    ]);
    if (
      snapshotGoalIds.length !== expectedGoalIds.size
      || snapshotGoalIds.some((goalId) => !expectedGoalIds.has(goalId))
    ) {
      importFailure(`${path}.goalSnapshots must match the completion's primary and linked goals.`);
    }
  }
  assertDateField(completion, "completedAt", path, true);
  assertNumberField(completion, "durationMinutes", path, {
    required: false,
    minimum: 0,
  });
  if ("note" in completion) {
    assertStringField(
      completion,
      "note",
      path,
      false,
      WORKSPACE_TEXT_LIMITS.completionNote,
    );
  }
  const evidence = requiredArray(completion, "evidence", path);
  assertCollectionLimit(evidence, `${path}.evidence`, MAX_GOAL_EVIDENCE_ITEMS);
  assertStringItems(evidence, `${path}.evidence`);
  evidence.forEach((item, evidenceIndex) => {
    if ((item as string).length > WORKSPACE_TEXT_LIMITS.completionEvidenceItem) {
      importFailure(`${path}.evidence[${evidenceIndex}] cannot exceed ${WORKSPACE_TEXT_LIMITS.completionEvidenceItem.toLocaleString()} characters.`);
    }
  });
  validateMetricDeltas(
    requiredArray(completion, "metricDeltas", path),
    `${path}.metricDeltas`,
  );
}

function validateCurrentMetricEntryStructure(entry: UnknownRecord, index: number) {
  const path = `workspace.metricEntries[${index}]`;
  assertStringField(entry, "goalId", path, false);
  assertStringField(entry, "metricId", path, false);
  assertDateField(entry, "recordedAt", path, true);
  assertNumberField(entry, "value", path, { minimum: 0 });
  assertNumberField(entry, "previousValue", path, { minimum: 0 });
  assertEnumField(entry, "source", path, METRIC_ENTRY_SOURCES, true);
  assertOptionalBoundedString(entry, "label", path, 120);
  assertOptionalBoundedString(entry, "unit", path, 32);
  if ("sourceCompletionId" in entry) {
    assertStringField(entry, "sourceCompletionId", path, false);
  }
  if ("periodKey" in entry) {
    if (
      typeof entry.periodKey !== "string"
      || !CONSISTENCY_PERIODS.some((period) => isPeriodKey(period, entry.periodKey as string))
    ) {
      importFailure(`${path}.periodKey is not valid.`);
    }
  }
  if ("attribution" in entry) {
    validateAttributionSnapshot(entry.attribution, `${path}.attribution`);
  }
}

/**
 * Validates a trusted in-memory command result without migrating, cloning, or
 * serialising the complete workspace. Only newly allocated records need full
 * structural validation because provider transactions preserve references for
 * every untouched record. Collection limits, identifiers, and affected
 * cross-record invariants are still checked before the state can reach React.
 */
export function assertInternalWorkspaceTransition(
  previous: AppState,
  next: AppState,
) {
  const nextRecord = next as unknown as UnknownRecord;
  if (next.version !== CURRENT_STATE_VERSION) {
    importFailure(`workspace.version must remain ${CURRENT_STATE_VERSION}.`);
  }
  assertDateField(nextRecord, "updatedAt", "workspace", true);

  if (next.profile !== previous.profile) {
    const profile = requiredRecord(nextRecord, "profile");
    assertStringField(
      profile,
      "displayName",
      "workspace.profile",
      true,
      WORKSPACE_TEXT_LIMITS.profileName,
    );
    assertStringField(
      profile,
      "chapter",
      "workspace.profile",
      true,
      WORKSPACE_TEXT_LIMITS.profileChapter,
    );
    assertBooleanField(profile, "onboarded", "workspace.profile", true);
    assertDateField(profile, "createdAt", "workspace.profile", true);
  }
  if (next.settings !== previous.settings) {
    validateCurrentSettingsStructure(requiredRecord(nextRecord, "settings"));
  }
  if (
    next.areas === previous.areas
    && next.stats === previous.stats
    && next.goals === previous.goals
    && next.questCompletions === previous.questCompletions
    && next.metricEntries === previous.metricEntries
    && next.reviews === previous.reviews
    && next.timeline === previous.timeline
  ) {
    return;
  }

  const changedAreas = next.areas !== previous.areas;
  if (changedAreas) {
    const areas = objectItems(requiredArray(nextRecord, "areas"), "workspace.areas");
    assertCollectionLimit(areas, "workspace.areas", COLLECTION_LIMITS.areas);
    assertUniqueIds(areas, "workspace.areas");
    const changed = changedCollectionItems(previous.areas, next.areas);
    changed.forEach((area) => {
      const index = next.areas.indexOf(area);
      const path = `workspace.areas[${index}]`;
      const record = area as unknown as UnknownRecord;
      assertStringField(record, "name", path, false, WORKSPACE_TEXT_LIMITS.areaOrQualityName);
      assertStringField(record, "color", path, false, WORKSPACE_TEXT_LIMITS.color);
      assertStringField(record, "icon", path, false, WORKSPACE_TEXT_LIMITS.icon);
      assertNumberField(record, "order", path, { minimum: 0, integer: true });
      assertBooleanField(record, "hidden", path);
      assertBooleanField(record, "archived", path);
    });
  }

  const changedStats = next.stats !== previous.stats;
  if (changedStats) {
    const stats = objectItems(requiredArray(nextRecord, "stats"), "workspace.stats");
    assertCollectionLimit(stats, "workspace.stats", COLLECTION_LIMITS.stats);
    assertUniqueIds(stats, "workspace.stats");
    const changed = changedCollectionItems(previous.stats, next.stats);
    changed.forEach((stat) => {
      const index = next.stats.indexOf(stat);
      const path = `workspace.stats[${index}]`;
      const record = stat as unknown as UnknownRecord;
      assertStringField(record, "name", path, false, WORKSPACE_TEXT_LIMITS.areaOrQualityName);
      assertStringField(record, "color", path, false, WORKSPACE_TEXT_LIMITS.color);
      assertStringField(record, "icon", path, false, WORKSPACE_TEXT_LIMITS.icon);
      assertBooleanField(record, "archived", path);
    });
  }

  const changedGoals = next.goals === previous.goals
    ? []
    : changedCollectionItems(previous.goals, next.goals);
  if (next.goals !== previous.goals) {
    const goals = objectItems(requiredArray(nextRecord, "goals"), "workspace.goals");
    assertCollectionLimit(goals, "workspace.goals", COLLECTION_LIMITS.goals);
    assertUniqueIds(goals, "workspace.goals");
    changedGoals.forEach((goal) => {
      validateGoalStructure(
        goal as unknown as UnknownRecord,
        next.goals.indexOf(goal),
        CURRENT_STATE_VERSION,
      );
    });
  }

  const changedReviews = next.reviews === previous.reviews
    ? []
    : changedCollectionItems(previous.reviews, next.reviews);
  if (next.reviews !== previous.reviews) {
    const reviews = objectItems(requiredArray(nextRecord, "reviews"), "workspace.reviews");
    assertCollectionLimit(reviews, "workspace.reviews", COLLECTION_LIMITS.reviews);
    assertUniqueIds(reviews, "workspace.reviews");
    changedReviews.forEach((review) =>
      validateCurrentReviewStructure(
        review as unknown as UnknownRecord,
        next.reviews.indexOf(review),
      ));
  }

  const changedTimeline = next.timeline === previous.timeline
    ? []
    : changedCollectionItems(previous.timeline, next.timeline);
  if (next.timeline !== previous.timeline) {
    const timeline = objectItems(requiredArray(nextRecord, "timeline"), "workspace.timeline");
    assertCollectionLimit(timeline, "workspace.timeline", COLLECTION_LIMITS.timeline);
    assertUniqueIds(timeline, "workspace.timeline");
    changedTimeline.forEach((event) =>
      validateCurrentTimelineStructure(
        event as unknown as UnknownRecord,
        next.timeline.indexOf(event),
      ));
  }

  const changedCompletions = next.questCompletions === previous.questCompletions
    ? []
    : changedCollectionItems(previous.questCompletions, next.questCompletions);
  if (next.questCompletions !== previous.questCompletions) {
    const completions = objectItems(
      requiredArray(nextRecord, "questCompletions"),
      "workspace.questCompletions",
    );
    assertCollectionLimit(
      completions,
      "workspace.questCompletions",
      COLLECTION_LIMITS.questCompletions,
    );
    assertUniqueIds(completions, "workspace.questCompletions");
    changedCompletions.forEach((completion) =>
      validateCurrentCompletionStructure(
        completion as unknown as UnknownRecord,
        next.questCompletions.indexOf(completion),
      ));
  }

  const changedMetricEntries = next.metricEntries === previous.metricEntries
    ? []
    : changedCollectionItems(previous.metricEntries, next.metricEntries);
  if (next.metricEntries !== previous.metricEntries) {
    const entries = objectItems(
      requiredArray(nextRecord, "metricEntries"),
      "workspace.metricEntries",
    );
    assertCollectionLimit(
      entries,
      "workspace.metricEntries",
      COLLECTION_LIMITS.metricEntries,
    );
    assertUniqueIds(entries, "workspace.metricEntries");
    changedMetricEntries.forEach((entry) =>
      validateCurrentMetricEntryStructure(
        entry as unknown as UnknownRecord,
        next.metricEntries.indexOf(entry),
      ));
  }

  const removedReferenceTarget = removedCollectionIds(previous.areas, next.areas)
    || removedCollectionIds(previous.stats, next.stats)
    || removedCollectionIds(previous.goals, next.goals)
    || removedCollectionIds(previous.questCompletions, next.questCompletions);
  if (removedReferenceTarget) {
    assertMigratedStateCoherence(next, CURRENT_STATE_VERSION, importFailure);
    return;
  }

  const areaIds = new Set(next.areas.map((area) => area.id));
  const statIds = new Set(next.stats.map((stat) => stat.id));
  const goals = new Map(next.goals.map((goal) => [goal.id, goal]));
  const completions = new Map(
    next.questCompletions.map((completion) => [completion.id, completion]),
  );
  const assertAttribution = (attribution: AttributionSnapshot, label: string) => {
    if (!areaIds.has(attribution.areaId)) {
      importFailure(`${label} references missing area "${attribution.areaId}".`);
    }
    attribution.statIds.forEach((statId) => {
      if (!statIds.has(statId)) {
        importFailure(`${label} references missing quality "${statId}".`);
      }
    });
  };

  changedGoals.forEach((goal) => {
    if (!areaIds.has(goal.areaId)) {
      importFailure(`goal "${goal.id}" references missing area "${goal.areaId}".`);
    }
    if (
      goal.completionSnapshot
      && (
        !goal.completedAt
        || new Date(goal.completionSnapshot.completedAt).getTime() !== new Date(goal.completedAt).getTime()
      )
    ) {
      importFailure(`goal "${goal.id}" completion snapshot does not match its first completion time.`);
    }
    const issue = goalProgressConfigurationIssue(goal);
    if (issue) importFailure(`goal "${goal.id}" is inconsistent: ${issue}`);
    goal.statIds.forEach((statId) => {
      if (!statIds.has(statId)) {
        importFailure(`goal "${goal.id}" references missing quality "${statId}".`);
      }
    });
    const metricIds = new Set(goal.metrics.map((metric) => metric.id));
    goal.quests.forEach((quest) => {
      quest.metricDeltas.forEach((delta) => {
        if (!metricIds.has(delta.metricId)) {
          importFailure(`action "${quest.id}" references missing metric "${delta.metricId}".`);
        }
      });
      quest.linkedGoalIds.forEach((linkedGoalId) => {
        if (linkedGoalId === goal.id) {
          importFailure(`action "${quest.id}" cannot link primary goal "${goal.id}" as an additional goal.`);
        }
        if (!goals.has(linkedGoalId)) {
          importFailure(`action "${quest.id}" references missing linked goal "${linkedGoalId}".`);
        }
      });
    });
    goal.milestones.forEach((milestone) => {
      if (milestone.attribution) {
        assertAttribution(
          milestone.attribution,
          `milestone "${milestone.id}" attribution`,
        );
      }
    });
    goal.checkIns.forEach((checkIn) => {
      if (checkIn.attribution) {
        assertAttribution(
          checkIn.attribution,
          `check-in "${checkIn.id}" attribution`,
        );
      }
    });
  });

  changedCompletions.forEach((completion) => {
    if (!goals.has(completion.goalId)) {
      importFailure(`action history "${completion.id}" references missing goal "${completion.goalId}".`);
    }
    completion.linkedGoalIds.forEach((linkedGoalId) => {
      if (linkedGoalId === completion.goalId) {
        importFailure(`action history "${completion.id}" cannot link primary goal "${completion.goalId}" as an additional goal.`);
      }
      if (!goals.has(linkedGoalId)) {
        importFailure(`action history "${completion.id}" references missing linked goal "${linkedGoalId}".`);
      }
    });
    completion.goalSnapshots?.forEach((snapshot) => {
      if (!goals.has(snapshot.goalId)) {
        importFailure(`action history "${completion.id}" attribution references missing goal "${snapshot.goalId}".`);
      }
      assertAttribution(snapshot, `action history "${completion.id}" attribution`);
    });
  });

  const completionIdsRequiringMetricChecks = new Set(
    changedCompletions.map((completion) => completion.id),
  );
  const entriesRequiringCoherence = new Set<MetricEntry>(changedMetricEntries);
  if (completionIdsRequiringMetricChecks.size) {
    next.metricEntries.forEach((entry) => {
      if (
        entry.sourceCompletionId
        && completionIdsRequiringMetricChecks.has(entry.sourceCompletionId)
      ) {
        entriesRequiringCoherence.add(entry);
      }
    });
  }
  const linkedMetricSources = new Set<string>();
  next.metricEntries.forEach((entry) => {
    if (!entry.sourceCompletionId) return;
    const key = `${entry.sourceCompletionId}\u0000${entry.metricId}`;
    if (linkedMetricSources.has(key)) {
      importFailure("metric history contains a duplicate source completion and metric link.");
    }
    linkedMetricSources.add(key);
  });
  entriesRequiringCoherence.forEach((entry) => {
    if (!goals.has(entry.goalId)) {
      importFailure(`metric history "${entry.id}" references missing goal "${entry.goalId}".`);
    }
    if (entry.sourceCompletionId) {
      const completion = completions.get(entry.sourceCompletionId);
      if (
        !completion
        || completion.goalId !== entry.goalId
        || entry.source !== "quest"
      ) {
        importFailure(`metric history "${entry.id}" has an invalid source completion link.`);
      }
      const sourceDelta = completion.metricDeltas.find(
        (delta) => delta.metricId === entry.metricId,
      );
      if (!sourceDelta || sourceDelta.amount !== entry.value - entry.previousValue) {
        importFailure(`metric history "${entry.id}" does not match its source completion delta.`);
      }
    }
    if (entry.attribution) {
      assertAttribution(entry.attribution, `metric history "${entry.id}" attribution`);
    }
  });

  changedTimeline.forEach((event) => {
    if (event.goalId && !goals.has(event.goalId)) {
      importFailure(`timeline event "${event.id}" references missing goal "${event.goalId}".`);
    }
    if (event.areaId && !areaIds.has(event.areaId)) {
      importFailure(`timeline event "${event.id}" references missing area "${event.areaId}".`);
    }
    event.relatedGoalIds?.forEach((goalId) => {
      if (!goals.has(goalId)) {
        importFailure(`timeline event "${event.id}" attribution references missing goal "${goalId}".`);
      }
    });
    event.relatedAreaIds?.forEach((areaId) => {
      if (!areaIds.has(areaId)) {
        importFailure(`timeline event "${event.id}" attribution references missing area "${areaId}".`);
      }
    });
    event.relatedStatIds?.forEach((statId) => {
      if (!statIds.has(statId)) {
        importFailure(`timeline event "${event.id}" attribution references missing quality "${statId}".`);
      }
    });
  });
}
