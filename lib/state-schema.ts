import { DEFAULT_AREAS, DEFAULT_SETTINGS, DEFAULT_STATS, EMPTY_STATE } from "@/lib/defaults";
import type {
  AppState,
  Area,
  Goal,
  GoalCheckIn,
  GoalModel,
  GoalStatus,
  LifeStat,
  MetricDelta,
  MetricEntry,
  Milestone,
  Priority,
  ProgressMetric,
  Quest,
  QuestCompletion,
  Review,
  ReviewCadence,
  TimelineEvent,
  UserSettings,
} from "@/lib/types";

export const CURRENT_STATE_VERSION = 2 as const;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const stringValue = (value: unknown, fallback = "") =>
  typeof value === "string" && value.trim() ? value : fallback;

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

const numberValue = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const booleanValue = (value: unknown, fallback = false) =>
  typeof value === "boolean" ? value : fallback;

const enumValue = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;

const validTimestamp = (value: unknown, fallback: string) => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return Number.isNaN(new Date(value).getTime()) ? fallback : value;
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

function sanitizeArea(value: unknown, index: number): Area | null {
  if (!isRecord(value)) return null;
  const area: Area = {
    id: stringValue(value.id, `area-migrated-${index + 1}`),
    name: stringValue(value.name, "Untitled area"),
    color: stringValue(value.color, "#8B7CFF"),
    icon: stringValue(value.icon, "Circle"),
    order: numberValue(value.order, index),
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
  if (!metricId) return null;
  return { metricId, amount: numberValue(value.amount) };
}

function sanitizeMetric(value: unknown, index: number): ProgressMetric | null {
  if (!isRecord(value)) return null;
  return {
    id: stringValue(value.id, `metric-migrated-${index + 1}`),
    label: stringValue(value.label, "Progress"),
    current: numberValue(value.current),
    target: numberValue(value.target),
    unit: typeof value.unit === "string" ? value.unit : "",
    weight: numberValue(value.weight, 100),
  };
}

function sanitizeMilestone(value: unknown, index: number): Milestone | null {
  if (!isRecord(value)) return null;
  const milestone: Milestone = {
    id: stringValue(value.id, `milestone-migrated-${index + 1}`),
    title: stringValue(value.title, "Untitled milestone"),
    weight: numberValue(value.weight),
    completed: booleanValue(value.completed),
  };
  const completedAt = optionalString(value.completedAt);
  if (completedAt) milestone.completedAt = completedAt;
  return milestone;
}

function sanitizeQuest(value: unknown, index: number): Quest | null {
  if (!isRecord(value)) return null;
  const quest: Quest = {
    id: stringValue(value.id, `quest-migrated-${index + 1}`),
    title: stringValue(value.title, "Untitled action"),
    repeat: enumValue(value.repeat, ["none", "daily", "weekly", "monthly"] as const, "none"),
    completed: booleanValue(value.completed),
    metricDeltas: Array.isArray(value.metricDeltas)
      ? value.metricDeltas.map(sanitizeMetricDelta).filter((item): item is MetricDelta => Boolean(item))
      : [],
  };
  const description = optionalString(value.description);
  const dueDate = optionalString(value.dueDate);
  const completedAt = optionalString(value.completedAt);
  const durationMinutes = numberValue(value.durationMinutes, Number.NaN);
  if (description) quest.description = description;
  if (dueDate) quest.dueDate = dueDate;
  if (completedAt) quest.completedAt = completedAt;
  if (Number.isFinite(durationMinutes) && durationMinutes >= 0) quest.durationMinutes = durationMinutes;
  return quest;
}

function sanitizeCheckIn(value: unknown, index: number, goalId: string, fallbackAt: string): GoalCheckIn | null {
  if (!isRecord(value)) return null;
  const note = optionalString(value.note);
  if (!note) return null;
  return {
    id: stringValue(value.id, `${goalId}-check-in-${index + 1}`),
    createdAt: validTimestamp(value.createdAt, fallbackAt),
    note,
  };
}

function legacyStatIds(value: UnknownRecord) {
  if (Array.isArray(value.statIds)) return stringArray(value.statIds);
  if (!isRecord(value.statWeights)) return [];
  return Object.entries(value.statWeights)
    .filter(([, weight]) => typeof weight === "number" && Number.isFinite(weight) && weight > 0)
    .map(([statId]) => statId);
}

function sanitizeGoal(value: unknown, index: number, fallbackAt: string): Goal | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id, `goal-migrated-${index + 1}`);
  const goal: Goal = {
    id,
    title: stringValue(value.title, "Untitled goal"),
    description: typeof value.description === "string" ? value.description : "",
    areaId: stringValue(value.areaId),
    model: enumValue<GoalModel>(value.model, ["numeric", "weighted", "consistency", "open"], "open"),
    priority: enumValue<Priority>(value.priority, ["low", "medium", "high", "critical"], "medium"),
    status: enumValue<GoalStatus>(value.status, ["active", "paused", "completed", "archived"], "active"),
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
    evidence: stringArray(value.evidence),
    notes: typeof value.notes === "string" ? value.notes : "",
  };
  const targetDate = optionalString(value.targetDate);
  const completedAt = optionalString(value.completedAt);
  if (targetDate) goal.targetDate = targetDate;
  if (completedAt) goal.completedAt = completedAt;
  return goal;
}

function sanitizeReview(value: unknown, index: number, fallbackAt: string): Review | null {
  if (!isRecord(value)) return null;
  const answers: Record<string, string> = {};
  if (isRecord(value.answers)) {
    Object.entries(value.answers).forEach(([key, answer]) => {
      if (typeof answer === "string") answers[key] = answer;
    });
  }
  return {
    id: stringValue(value.id, `review-migrated-${index + 1}`),
    cadence: enumValue<ReviewCadence>(value.cadence, ["daily", "weekly", "monthly"], "weekly"),
    createdAt: validTimestamp(value.createdAt, fallbackAt),
    answers,
  };
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
    questId,
    title: stringValue(value.title, "Completed action"),
    completedAt: validTimestamp(value.completedAt, fallbackAt),
  };
  const durationMinutes = numberValue(value.durationMinutes, Number.NaN);
  if (Number.isFinite(durationMinutes) && durationMinutes >= 0) completion.durationMinutes = durationMinutes;
  return completion;
}

function sanitizeMetricEntry(value: unknown, index: number, fallbackAt: string): MetricEntry | null {
  if (!isRecord(value)) return null;
  const goalId = optionalString(value.goalId);
  const metricId = optionalString(value.metricId);
  if (!goalId || !metricId) return null;
  return {
    id: stringValue(value.id, `metric-entry-migrated-${index + 1}`),
    goalId,
    metricId,
    value: numberValue(value.value),
    previousValue: numberValue(value.previousValue),
    recordedAt: validTimestamp(value.recordedAt, fallbackAt),
    source: enumValue(value.source, ["manual", "quest"] as const, "manual"),
  };
}

function sanitizeSettings(value: unknown): UserSettings {
  if (!isRecord(value)) return clone(DEFAULT_SETTINGS);
  const terminologySource = isRecord(value.terminology) ? value.terminology : {};
  const settings: UserSettings = {
    theme: enumValue(value.theme, ["dark", "light", "system"] as const, DEFAULT_SETTINGS.theme),
    gameIntensity: enumValue(
      value.gameIntensity,
      ["minimal", "balanced", "immersive"] as const,
      DEFAULT_SETTINGS.gameIntensity,
    ),
    notifications: booleanValue(value.notifications, DEFAULT_SETTINGS.notifications),
    terminology: {
      goals: stringValue(terminologySource.goals, DEFAULT_SETTINGS.terminology.goals),
      quests: stringValue(terminologySource.quests, DEFAULT_SETTINGS.terminology.quests),
      areas: stringValue(terminologySource.areas, DEFAULT_SETTINGS.terminology.areas),
      milestones: stringValue(terminologySource.milestones, DEFAULT_SETTINGS.terminology.milestones),
      stats: stringValue(terminologySource.stats, DEFAULT_SETTINGS.terminology.stats),
    },
  };
  const birthDate = optionalString(value.birthDate);
  if (birthDate) settings.birthDate = birthDate;
  return settings;
}

function addInferredCompletions(state: AppState) {
  const seen = new Set(
    state.questCompletions.map((completion) => `${completion.goalId}\u0000${completion.questId}\u0000${completion.completedAt}`),
  );

  const add = (completion: QuestCompletion) => {
    const key = `${completion.goalId}\u0000${completion.questId}\u0000${completion.completedAt}`;
    if (seen.has(key)) return;
    seen.add(key);
    state.questCompletions.push(completion);
  };

  state.timeline.forEach((event) => {
    if (event.type !== "quest" || !event.goalId) return;
    const goal = state.goals.find((item) => item.id === event.goalId);
    const quest = goal?.quests.find((item) => item.title === event.title);
    if (!goal || !quest) return;
    add({
      id: `completion-${event.id}`,
      goalId: goal.id,
      questId: quest.id,
      title: quest.title,
      completedAt: event.at,
      ...(quest.durationMinutes === undefined ? {} : { durationMinutes: quest.durationMinutes }),
    });
  });

  state.goals.forEach((goal) => {
    goal.quests.forEach((quest) => {
      if (!quest.completedAt) return;
      add({
        id: `completion-${goal.id}-${quest.id}`,
        goalId: goal.id,
        questId: quest.id,
        title: quest.title,
        completedAt: quest.completedAt,
        ...(quest.durationMinutes === undefined ? {} : { durationMinutes: quest.durationMinutes }),
      });
    });
  });

  state.questCompletions.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
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
  const statIds = new Set(stats.map((stat) => stat.id));
  const goals = Array.isArray(value.goals)
    ? uniqueById(value.goals.map((goal, index) => sanitizeGoal(goal, index, now)).filter((item): item is Goal => Boolean(item)))
    : [];
  goals.forEach((goal) => {
    goal.statIds = goal.statIds.filter((statId) => statIds.has(statId));
  });

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

  addInferredCompletions(state);
  return state;
}

