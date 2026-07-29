import type { AppState, TimelineEvent } from "@/lib/types";
import { completionGoalIds } from "@/lib/activity-attribution";
import { terminologyForms } from "@/lib/terminology";
import { localDateKey, parseLocalDate } from "@/lib/utils";

export type ReconciledTimelineEvent = TimelineEvent;
export type TimelineRecordType = TimelineEvent["type"] | "activity";

export interface TimelineFilters {
  type?: TimelineRecordType;
  areaId?: string;
  statId?: string;
  goalId?: string;
  from?: string;
  to?: string;
  query?: string;
}

const timelineTypes: TimelineRecordType[] = ["activity", "quest", "milestone", "goal", "review", "note", "metric"];

const validLocalDate = (value: string | null): string | undefined => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseLocalDate(value)) return undefined;
  return value;
};

export function parseTimelineFilters(value: string | URLSearchParams): TimelineFilters {
  const params = typeof value === "string"
    ? new URLSearchParams(value.startsWith("?") ? value.slice(1) : value)
    : value;
  const type = params.get("type");
  const from = validLocalDate(params.get("from"));
  const to = validLocalDate(params.get("to"));
  return {
    ...(type && timelineTypes.includes(type as TimelineRecordType)
      ? { type: type as TimelineRecordType }
      : {}),
    ...(params.get("area")?.trim() ? { areaId: params.get("area")!.trim() } : {}),
    ...(params.get("stat")?.trim() ? { statId: params.get("stat")!.trim() } : {}),
    ...(params.get("goal")?.trim() ? { goalId: params.get("goal")!.trim() } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(params.get("q")?.trim() ? { query: params.get("q")!.trim() } : {}),
  };
}

export function timelineHref(filters: TimelineFilters = {}, hash?: string) {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.areaId) params.set("area", filters.areaId);
  if (filters.statId) params.set("stat", filters.statId);
  if (filters.goalId) params.set("goal", filters.goalId);
  if (filters.from && validLocalDate(filters.from)) params.set("from", filters.from);
  if (filters.to && validLocalDate(filters.to)) params.set("to", filters.to);
  if (filters.query?.trim()) params.set("q", filters.query.trim());
  const query = params.toString();
  const fragment = hash?.replace(/^#/, "");
  return `/timeline${query ? `?${query}` : ""}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`;
}

export function timelineEventMatchesFilters(
  event: ReconciledTimelineEvent,
  filters: TimelineFilters,
) {
  if (filters.type === "activity") {
    const isRecordedMoment = ["quest", "metric", "milestone"].includes(event.type)
      || event.type === "review"
      || event.id.startsWith("record-check-in-")
      || event.id.startsWith("record-goal-completed-");
    if (!isRecordedMoment) return false;
  } else if (filters.type && event.type !== filters.type) return false;
  if (filters.areaId && !(event.relatedAreaIds ?? (event.areaId ? [event.areaId] : [])).includes(filters.areaId)) return false;
  if (filters.statId && !(event.relatedStatIds ?? []).includes(filters.statId)) return false;
  if (filters.goalId && !(event.relatedGoalIds ?? (event.goalId ? [event.goalId] : [])).includes(filters.goalId)) return false;
  const date = instant(event.at);
  if (!date) return false;
  const dateKey = localDateKey(date);
  if (filters.from && dateKey < filters.from) return false;
  if (filters.to && dateKey > filters.to) return false;
  const search = filters.query?.trim().toLocaleLowerCase();
  return !search || `${event.title} ${event.detail}`.toLocaleLowerCase().includes(search);
}

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
 * Builds the permanent activity record from immutable domain history first,
 * then adds non-mirrored structural/legacy timeline records. Both the Timeline
 * UI and data export use this selector so neither can silently omit history.
 */
export function reconciledTimelineEvents(state: AppState): ReconciledTimelineEvent[] {
  const terms = terminologyForms(state.settings.terminology);
  const goals = new Map(state.goals.map((goal) => [goal.id, goal]));
  const canonical: ReconciledTimelineEvent[] = [];

  state.questCompletions.forEach((completion) => {
    const goal = goals.get(completion.goalId);
    const relatedGoalIds = completionGoalIds(completion);
    const snapshots = completion.goalSnapshots ?? relatedGoalIds.flatMap((goalId) => {
      const relatedGoal = goals.get(goalId);
      return relatedGoal ? [{ goalId, areaId: relatedGoal.areaId, statIds: relatedGoal.statIds }] : [];
    });
    const additionalGoalTitles = relatedGoalIds
      .filter((goalId) => goalId !== completion.goalId)
      .flatMap((goalId) => {
        const relatedGoal = goals.get(goalId);
        return relatedGoal ? [relatedGoal.title] : [];
      });
    const completionContext = [
      completion.durationMinutes ? `${completion.durationMinutes} minutes recorded` : null,
      completion.note?.trim() || null,
      completion.evidence.length ? `${completion.evidence.length} evidence ${completion.evidence.length === 1 ? "item" : "items"}` : null,
      additionalGoalTitles.length ? `also supports ${additionalGoalTitles.join(", ")}` : null,
    ].filter((detail): detail is string => Boolean(detail));
    canonical.push({
      id: `record-quest-${completion.id}`,
      type: "quest",
      title: completion.title,
      detail: `${terms.quests.singular} completed${completionContext.length ? ` · ${completionContext.join(" · ")}` : ""}.`,
      at: completion.completedAt,
      goalId: completion.goalId,
      areaId: snapshots.find((snapshot) => snapshot.goalId === completion.goalId)?.areaId ?? goal?.areaId,
      relatedGoalIds,
      relatedAreaIds: [...new Set(snapshots.map((snapshot) => snapshot.areaId))],
      relatedStatIds: [...new Set(snapshots.flatMap((snapshot) => snapshot.statIds))],
    });
  });

  state.metricEntries.forEach((entry) => {
    const goal = goals.get(entry.goalId);
    const metric = goal?.metrics.find((item) => item.id === entry.metricId);
    const label = entry.label || metric?.label;
    const unitValue = entry.unit ?? metric?.unit;
    const unit = unitValue ? ` ${unitValue}` : "";
    canonical.push({
      id: `record-metric-${entry.id}`,
      type: "metric",
      title: label ? `${label} updated` : "Measurement updated",
      detail: `${entry.previousValue.toLocaleString()} → ${entry.value.toLocaleString()}${unit}${entry.source === "quest" ? ` · recorded with a completed ${terms.quests.singularLower}` : ""}`,
      at: entry.recordedAt,
      goalId: entry.goalId,
      areaId: entry.attribution?.areaId ?? goal?.areaId,
      relatedGoalIds: [entry.goalId],
      relatedAreaIds: entry.attribution?.areaId ? [entry.attribution.areaId] : goal?.areaId ? [goal.areaId] : [],
      relatedStatIds: entry.attribution?.statIds ?? goal?.statIds ?? [],
    });
  });

  state.goals.forEach((goal) => {
    canonical.push({
      id: `record-goal-created-${goal.id}`,
      type: "goal",
      title: `Created ${terms.goals.singularLower}: ${goal.title}`,
      detail: `${terms.goals.singular} creation retained in the permanent record.`,
      at: goal.createdAt,
      goalId: goal.id,
      areaId: goal.areaId,
      relatedGoalIds: [goal.id],
      relatedAreaIds: [goal.areaId],
      relatedStatIds: goal.statIds,
    });
    goal.milestones.forEach((milestone) => {
      if (!milestone.completedAt) return;
      canonical.push({
        id: `record-milestone-${goal.id}-${milestone.id}`,
        type: "milestone",
        title: milestone.title,
        detail: `${terms.milestones.singular} reached and retained in the permanent record.`,
        at: milestone.completedAt,
        goalId: goal.id,
        areaId: milestone.attribution?.areaId ?? goal.areaId,
        relatedGoalIds: [goal.id],
        relatedAreaIds: [milestone.attribution?.areaId ?? goal.areaId],
        relatedStatIds: milestone.attribution?.statIds ?? goal.statIds,
      });
    });
    goal.checkIns.forEach((checkIn) => {
      canonical.push({
        id: `record-check-in-${goal.id}-${checkIn.id}`,
        type: "note",
        title: `Check-in for ${goal.title}`,
        detail: checkIn.note,
        at: checkIn.createdAt,
        goalId: goal.id,
        areaId: checkIn.attribution?.areaId ?? goal.areaId,
        relatedGoalIds: [goal.id],
        relatedAreaIds: [checkIn.attribution?.areaId ?? goal.areaId],
        relatedStatIds: checkIn.attribution?.statIds ?? goal.statIds,
      });
    });
    if (goal.completedAt) {
      canonical.push({
        id: `record-goal-completed-${goal.id}`,
        type: "goal",
        title: `${goal.title} completed`,
        detail: `${terms.goals.singular} completion retained in the permanent record.`,
        at: goal.completedAt,
        goalId: goal.id,
        areaId: goal.areaId,
        relatedGoalIds: [goal.id],
        relatedAreaIds: [goal.areaId],
        relatedStatIds: goal.statIds,
      });
    }
  });

  state.reviews.forEach((review) => {
    canonical.push({
      id: `record-review-${review.id}`,
      type: "review",
      title: `${review.cadence[0].toUpperCase()}${review.cadence.slice(1)} review completed`,
      detail: `${Object.values(review.answers).filter((answer) => answer.trim()).length} written reflections retained.`,
      at: review.createdAt,
    });
  });

  const isMirrorPair = (record: TimelineEvent, event: TimelineEvent) => {
    if (record.type !== event.type || record.goalId !== event.goalId || !sameMoment(record.at, event.at)) return false;
    if (event.type === "metric") return true;
    if (event.type === "review" || event.type === "milestone") return true;
    if (event.type === "goal") {
      if (record.id.startsWith("record-goal-created-")) return normalized(event.title).startsWith("created ");
      return normalized(event.title).endsWith(" completed");
    }
    if (event.type === "note") return normalized(record.detail) === normalized(event.detail);
    return normalized(record.title) === normalized(event.title);
  };
  const canonicalWithTimelineContext = canonical.map((record) => {
    const mirror = state.timeline.find((event) => isMirrorPair(record, event));
    if (!mirror) return record;
    const preserveOriginalTitle = ["metric", "milestone", "goal", "note"].includes(record.type);
    const preferMirrorAttribution = record.type === "goal";
    return {
      ...record,
      title: preserveOriginalTitle ? mirror.title : record.title,
      areaId: preferMirrorAttribution ? mirror.areaId ?? record.areaId : record.areaId ?? mirror.areaId,
      relatedGoalIds: preferMirrorAttribution
        ? mirror.relatedGoalIds?.length ? mirror.relatedGoalIds : record.relatedGoalIds
        : record.relatedGoalIds?.length ? record.relatedGoalIds : mirror.relatedGoalIds,
      relatedAreaIds: preferMirrorAttribution
        ? mirror.relatedAreaIds?.length ? mirror.relatedAreaIds : mirror.areaId ? [mirror.areaId] : record.relatedAreaIds
        : record.relatedAreaIds?.length ? record.relatedAreaIds : mirror.relatedAreaIds ?? (mirror.areaId ? [mirror.areaId] : undefined),
      relatedStatIds: preferMirrorAttribution
        ? mirror.relatedStatIds?.length ? mirror.relatedStatIds : record.relatedStatIds
        : record.relatedStatIds?.length ? record.relatedStatIds : mirror.relatedStatIds,
    };
  });
  const isCanonicalMirror = (event: TimelineEvent) => canonicalWithTimelineContext.some((record) => isMirrorPair(record, event));

  const seenTimeline = new Set<string>();
  const legacyAndStructural = state.timeline.filter((event) => {
    if (!instant(event.at) || isCanonicalMirror(event)) return false;
    const signature = [event.type, event.goalId ?? "", event.areaId ?? "", normalized(event.title), normalized(event.detail), event.at].join("|");
    if (seenTimeline.has(signature)) return false;
    seenTimeline.add(signature);
    return true;
  }).map((event): ReconciledTimelineEvent => {
    const goal = event.goalId ? goals.get(event.goalId) : undefined;
    return {
      ...event,
      relatedGoalIds: event.relatedGoalIds ?? (event.goalId ? [event.goalId] : undefined),
      relatedAreaIds: event.relatedAreaIds ?? (event.areaId ? [event.areaId] : goal ? [goal.areaId] : undefined),
      relatedStatIds: event.relatedStatIds ?? goal?.statIds,
    };
  });

  return [...canonicalWithTimelineContext.filter((event) => instant(event.at)), ...legacyAndStructural]
    .sort((left, right) => (instant(right.at)?.getTime() ?? 0) - (instant(left.at)?.getTime() ?? 0));
}
