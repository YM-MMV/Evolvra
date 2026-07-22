import { createStarterGoals } from "@/lib/defaults";
import { validateGoalEvidenceList } from "@/lib/goal-evidence";
import { cloneWorkspaceValue } from "@/lib/provider-state";
import type {
  AppState,
  Area,
  Goal,
  GoalEvidence,
  GoalStatus,
  LifeStat,
  Quest,
  QuestCompletionInput,
  Review,
  TimelineEvent,
  UserSettings,
} from "@/lib/types";
import {
  isQuestAvailable,
  nextRepeatDate,
  rollMetricPeriod,
  singularizeTerm,
  uid,
} from "@/lib/utils";

export interface ProviderCommandRuntime {
  now: () => string;
  id: (prefix: string) => string;
}

const defaultRuntime: ProviderCommandRuntime = {
  now: () => new Date().toISOString(),
  id: uid,
};

const finiteWorkspaceNumber = (
  value: unknown,
  minimum = -Number.MAX_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number => typeof value === "number"
  && Number.isFinite(value)
  && value >= minimum
  && value <= maximum;

const attributionForGoal = (goal: Pick<Goal, "areaId" | "statIds">) => ({
  areaId: goal.areaId,
  statIds: [...goal.statIds],
});

export function addTimelineDraft(
  draft: AppState,
  event: Omit<TimelineEvent, "id" | "at">,
  runtime = defaultRuntime,
) {
  const relatedGoalIds = [...new Set([
    ...(event.goalId ? [event.goalId] : []),
    ...(event.relatedGoalIds ?? []),
  ])];
  const relatedGoals = relatedGoalIds.flatMap((goalId) => {
    const goal = draft.goals.find((item) => item.id === goalId);
    return goal ? [goal] : [];
  });
  const relatedAreaIds = [...new Set([
    ...(event.areaId ? [event.areaId] : []),
    ...(event.relatedAreaIds ?? []),
    ...relatedGoals.map((goal) => goal.areaId),
  ])];
  const relatedStatIds = [...new Set([
    ...(event.relatedStatIds ?? []),
    ...relatedGoals.flatMap((goal) => goal.statIds),
  ])];
  draft.timeline.unshift({
    ...event,
    id: runtime.id("event"),
    at: runtime.now(),
    ...(relatedGoalIds.length ? { relatedGoalIds } : {}),
    ...(relatedAreaIds.length ? { relatedAreaIds } : {}),
    ...(relatedStatIds.length ? { relatedStatIds } : {}),
  });
}

export function completeOnboardingDraft(
  draft: AppState,
  displayName: string,
  starter: boolean,
  birthDate?: string,
  runtime = defaultRuntime,
) {
  draft.profile.displayName = displayName.trim() || "Explorer";
  draft.profile.onboarded = true;
  if (birthDate) draft.settings.birthDate = birthDate;
  else delete draft.settings.birthDate;
  if (starter && !draft.goals.length) draft.goals = createStarterGoals();
  addTimelineDraft(draft, {
    type: "note",
    title: "Evolvra journey started",
    detail: "Your command centre is ready to evolve with you.",
  }, runtime);
}

export function addGoalDraft(
  draft: AppState,
  goal: Goal,
  runtime = defaultRuntime,
) {
  validateGoalEvidenceList(goal.evidence, goal.id);
  const goalTerm = singularizeTerm(draft.settings.terminology.goals);
  draft.goals.unshift(goal);
  addTimelineDraft(draft, {
    type: "goal",
    title: `Created ${goalTerm.toLowerCase()}: ${goal.title}`,
    detail: `Progress will use the ${goal.model} model.`,
    goalId: goal.id,
    areaId: goal.areaId,
  }, runtime);
}

export function updateGoalDraft(
  draft: AppState,
  goalId: string,
  patch: Partial<Goal>,
  runtime = defaultRuntime,
) {
  const goalTerm = singularizeTerm(draft.settings.terminology.goals);
  const goal = draft.goals.find((item) => item.id === goalId);
  if (!goal) return;
  if (patch.evidence) validateGoalEvidenceList(patch.evidence, goalId);
  Object.assign(goal, patch);
  addTimelineDraft(draft, {
    type: "goal",
    title: `Updated ${goal.title}`,
    detail: `${goalTerm} structure or notes were adjusted without losing progress.`,
    goalId,
    areaId: goal.areaId,
  }, runtime);
}

export function setGoalFileEvidenceDraft(
  draft: AppState,
  goalId: string,
  evidence: GoalEvidence[],
) {
  const goal = draft.goals.find((item) => item.id === goalId);
  if (goal) {
    validateGoalEvidenceList(evidence, goalId);
    goal.evidence = evidence;
  }
}

export function setGoalStatusDraft(
  draft: AppState,
  goalId: string,
  status: GoalStatus,
  runtime = defaultRuntime,
) {
  const goalTerm = singularizeTerm(draft.settings.terminology.goals);
  const goal = draft.goals.find((item) => item.id === goalId);
  if (!goal || goal.status === status) return;
  const firstCompletion = status === "completed" && !goal.completedAt;
  goal.status = status;
  if (firstCompletion) goal.completedAt = runtime.now();
  addTimelineDraft(draft, {
    type: "goal",
    title: `${goal.title} ${status}`,
    detail: firstCompletion
      ? `${goalTerm} completed and added to your permanent record.`
      : `${goalTerm} moved to ${status}.`,
    goalId,
    areaId: goal.areaId,
  }, runtime);
}

export function deleteGoalRecordsDraft(draft: AppState, goalId: string) {
  if (!draft.goals.some((item) => item.id === goalId)) return;
  draft.goals = draft.goals.filter((item) => item.id !== goalId);
  for (const goal of draft.goals) {
    for (const quest of goal.quests) {
      quest.linkedGoalIds = quest.linkedGoalIds.filter((linkedGoalId) => linkedGoalId !== goalId);
    }
  }
  draft.questCompletions = draft.questCompletions
    .filter((item) => item.goalId !== goalId)
    .map((item) => ({
      ...item,
      linkedGoalIds: item.linkedGoalIds.filter((linkedGoalId) => linkedGoalId !== goalId),
      ...(item.goalSnapshots
        ? { goalSnapshots: item.goalSnapshots.filter((snapshot) => snapshot.goalId !== goalId) }
        : {}),
    }));
  draft.metricEntries = draft.metricEntries.filter((item) => item.goalId !== goalId);
  draft.timeline = draft.timeline
    .filter((item) => item.goalId !== goalId)
    .map((item) => ({
      ...item,
      ...(item.relatedGoalIds
        ? { relatedGoalIds: item.relatedGoalIds.filter((relatedGoalId) => relatedGoalId !== goalId) }
        : {}),
    }));
}

export function addQuestDraft(
  draft: AppState,
  goalId: string,
  quest: Quest,
  runtime = defaultRuntime,
) {
  const questTerm = singularizeTerm(draft.settings.terminology.quests);
  const goal = draft.goals.find((item) => item.id === goalId);
  if (!goal) return;
  goal.quests.unshift(quest);
  addTimelineDraft(draft, {
    type: "note",
    title: `New ${questTerm.toLowerCase()}: ${quest.title}`,
    detail: quest.dueDate ? `Planned for ${quest.dueDate}.` : "Ready when it is useful.",
    goalId,
    areaId: goal.areaId,
  }, runtime);
}

export function completeQuestDraft(
  draft: AppState,
  goalId: string,
  questId: string,
  input: QuestCompletionInput = {},
  runtime = defaultRuntime,
) {
  const questTerm = singularizeTerm(draft.settings.terminology.quests);
  const goal = draft.goals.find((item) => item.id === goalId);
  const quest = goal?.quests.find((item) => item.id === questId);
  if (!goal || goal.status !== "active" || !quest || !isQuestAvailable(quest)) return;
  const completedAt = runtime.now();
  quest.completedAt = completedAt;
  quest.completed = quest.repeat === "none";
  if (quest.repeat !== "none") quest.dueDate = nextRepeatDate(quest.repeat, quest.dueDate);
  const requestedDuration = input.durationMinutes === undefined
    ? quest.durationMinutes
    : input.durationMinutes;
  const durationMinutes = finiteWorkspaceNumber(requestedDuration, 0)
    ? requestedDuration
    : undefined;
  const note = typeof input.note === "string" ? input.note.trim() : undefined;
  const evidence = [...new Set((input.evidence ?? [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
  const requestedDeltas = input.metricDeltas ?? quest.metricDeltas;
  const seenMetricIds = new Set<string>();
  const movements: Array<{
    metricId: string;
    label: string;
    unit: string;
    previousValue: number;
    value: number;
    amount: number;
    periodKey?: string;
  }> = [];
  requestedDeltas.forEach((delta) => {
    if (
      !delta
      || typeof delta.metricId !== "string"
      || seenMetricIds.has(delta.metricId)
      || !finiteWorkspaceNumber(delta.amount)
    ) return;
    const metricIndex = goal.metrics.findIndex((item) => item.id === delta.metricId);
    if (metricIndex < 0) return;
    const metric = rollMetricPeriod(goal.metrics[metricIndex]);
    if (!finiteWorkspaceNumber(metric.current, 0)) return;
    const nextValue = metric.current + delta.amount;
    if (!finiteWorkspaceNumber(nextValue)) return;
    seenMetricIds.add(delta.metricId);
    const previousValue = metric.current;
    metric.current = Math.max(0, nextValue);
    goal.metrics[metricIndex] = metric;
    const amount = metric.current - previousValue;
    if (amount === 0) return;
    movements.push({
      metricId: metric.id,
      label: metric.label,
      unit: metric.unit,
      previousValue,
      value: metric.current,
      amount,
      ...(metric.periodKey ? { periodKey: metric.periodKey } : {}),
    });
  });
  const appliedDeltas = movements.map(({ metricId, amount }) => ({ metricId, amount }));
  const completionId = runtime.id("completion");
  draft.questCompletions.unshift({
    id: completionId,
    goalId,
    linkedGoalIds: [...quest.linkedGoalIds],
    goalSnapshots: [goal.id, ...quest.linkedGoalIds].flatMap((relatedGoalId) => {
      const relatedGoal = draft.goals.find((item) => item.id === relatedGoalId);
      return relatedGoal ? [{ goalId: relatedGoal.id, ...attributionForGoal(relatedGoal) }] : [];
    }),
    questId,
    title: quest.title,
    completedAt,
    evidence,
    metricDeltas: appliedDeltas,
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(note ? { note } : {}),
  });
  movements.forEach((movement) => {
    draft.metricEntries.unshift({
      id: runtime.id("metric-entry"),
      goalId,
      metricId: movement.metricId,
      label: movement.label,
      unit: movement.unit,
      previousValue: movement.previousValue,
      value: movement.value,
      recordedAt: completedAt,
      source: "quest",
      sourceCompletionId: completionId,
      attribution: attributionForGoal(goal),
      ...(movement.periodKey ? { periodKey: movement.periodKey } : {}),
    });
  });
  addTimelineDraft(draft, {
    type: "quest",
    title: quest.title,
    detail: `${questTerm} completed${durationMinutes ? ` · ${durationMinutes} minutes invested` : ""}${note ? " · Completion note added" : ""}.`,
    goalId,
    areaId: goal.areaId,
    relatedGoalIds: [goal.id, ...quest.linkedGoalIds],
  }, runtime);
}

export function toggleMilestoneDraft(
  draft: AppState,
  goalId: string,
  milestoneId: string,
  runtime = defaultRuntime,
) {
  const milestoneTerm = singularizeTerm(draft.settings.terminology.milestones);
  const goal = draft.goals.find((item) => item.id === goalId);
  const milestone = goal?.milestones.find((item) => item.id === milestoneId);
  if (!goal || !milestone) return;
  if (milestone.completed) {
    milestone.completed = false;
    return;
  }
  milestone.completed = true;
  if (!milestone.completedAt) {
    milestone.completedAt = runtime.now();
    milestone.attribution = attributionForGoal(goal);
    addTimelineDraft(draft, {
      type: "milestone",
      title: milestone.title,
      detail: `${milestoneTerm} reached and recorded.`,
      goalId,
      areaId: goal.areaId,
    }, runtime);
  }
}

export function updateMetricDraft(
  draft: AppState,
  goalId: string,
  metricId: string,
  current: number,
  runtime = defaultRuntime,
) {
  if (!finiteWorkspaceNumber(current, 0)) return;
  const goal = draft.goals.find((item) => item.id === goalId);
  const metricIndex = goal?.metrics.findIndex((item) => item.id === metricId) ?? -1;
  if (!goal || metricIndex < 0) return;
  const metric = rollMetricPeriod(goal.metrics[metricIndex]);
  goal.metrics[metricIndex] = metric;
  const previousValue = metric.current;
  metric.current = current;
  if (metric.current === previousValue) return;
  draft.metricEntries.unshift({
    id: runtime.id("metric-entry"),
    goalId,
    metricId,
    label: metric.label,
    unit: metric.unit,
    previousValue,
    value: metric.current,
    recordedAt: runtime.now(),
    source: "manual",
    attribution: attributionForGoal(goal),
    ...(metric.periodKey ? { periodKey: metric.periodKey } : {}),
  });
  addTimelineDraft(draft, {
    type: "metric",
    title: `${metric.label} updated`,
    detail: `${metric.current} of ${metric.target} ${metric.unit}`,
    goalId,
    areaId: goal.areaId,
  }, runtime);
}

export function addCheckInDraft(
  draft: AppState,
  goalId: string,
  note: string,
  runtime = defaultRuntime,
) {
  if (!note.trim()) return;
  const goal = draft.goals.find((item) => item.id === goalId);
  if (!goal) return;
  const createdAt = runtime.now();
  goal.checkIns.unshift({
    id: runtime.id("check-in"),
    createdAt,
    note: note.trim(),
    attribution: attributionForGoal(goal),
  });
  addTimelineDraft(draft, {
    type: "note",
    title: `Check-in for ${goal.title}`,
    detail: note.trim(),
    goalId,
    areaId: goal.areaId,
  }, runtime);
}

export function addReviewDraft(
  draft: AppState,
  review: Review,
  runtime = defaultRuntime,
) {
  draft.reviews.unshift(review);
  addTimelineDraft(draft, {
    type: "review",
    title: `${review.cadence[0].toUpperCase()}${review.cadence.slice(1)} review completed`,
    detail: "A calm reflection was added to your development record.",
  }, runtime);
}

export function upsertAreaDraft(draft: AppState, area: Area) {
  const index = draft.areas.findIndex((item) => item.id === area.id);
  if (index >= 0) draft.areas[index] = area;
  else draft.areas.push(area);
}

export function reorderAreasDraft(draft: AppState, areaIds: string[]) {
  const positions = new Map(areaIds.map((id, index) => [id, index]));
  draft.areas.forEach((area) => {
    const order = positions.get(area.id);
    if (order !== undefined) area.order = order;
  });
  draft.areas.sort((left, right) => left.order - right.order);
}

export function removeAreaDraft(draft: AppState, areaId: string) {
  const inUse = draft.goals.some((goal) => goal.areaId === areaId
    || goal.milestones.some((milestone) => milestone.attribution?.areaId === areaId)
    || goal.checkIns.some((checkIn) => checkIn.attribution?.areaId === areaId))
    || draft.questCompletions.some((completion) => completion.goalSnapshots?.some((snapshot) => snapshot.areaId === areaId))
    || draft.metricEntries.some((entry) => entry.attribution?.areaId === areaId)
    || draft.timeline.some((event) => event.areaId === areaId || event.relatedAreaIds?.includes(areaId));
  const area = draft.areas.find((item) => item.id === areaId);
  if (!area) return;
  if (inUse) area.archived = true;
  else draft.areas = draft.areas.filter((item) => item.id !== areaId);
}

export function upsertStatDraft(draft: AppState, stat: LifeStat) {
  const index = draft.stats.findIndex((item) => item.id === stat.id);
  if (index >= 0) draft.stats[index] = stat;
  else draft.stats.push(stat);
}

export function reorderStatsDraft(draft: AppState, statIds: string[]) {
  const positions = new Map(statIds.map((id, index) => [id, index]));
  draft.stats.sort((left, right) =>
    (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER));
}

export function removeStatDraft(draft: AppState, statId: string) {
  const inUse = draft.goals.some((goal) => goal.statIds.includes(statId)
    || goal.milestones.some((milestone) => milestone.attribution?.statIds.includes(statId))
    || goal.checkIns.some((checkIn) => checkIn.attribution?.statIds.includes(statId)))
    || draft.questCompletions.some((completion) => completion.goalSnapshots?.some((snapshot) => snapshot.statIds.includes(statId)))
    || draft.metricEntries.some((entry) => entry.attribution?.statIds.includes(statId))
    || draft.timeline.some((event) => event.relatedStatIds?.includes(statId));
  const stat = draft.stats.find((item) => item.id === statId);
  if (!stat) return;
  if (inUse) stat.archived = true;
  else draft.stats = draft.stats.filter((item) => item.id !== statId);
}

export function normalizeSettingsPatch(settings: Partial<UserSettings>) {
  const clearBirthDate = "birthDate" in settings && settings.birthDate === undefined;
  const safeSettings = cloneWorkspaceValue(settings);
  if (safeSettings.terminology) {
    for (const key of ["goals", "quests", "areas", "milestones", "stats"] as const) {
      const term = safeSettings.terminology[key];
      if (typeof term !== "string" || !term.trim()) {
        throw new Error("Every custom terminology label must be non-empty.");
      }
      safeSettings.terminology[key] = term.trim();
    }
  }
  return { safeSettings, clearBirthDate };
}

export function updateSettingsDraft(
  draft: AppState,
  settings: Partial<UserSettings>,
  clearBirthDate: boolean,
) {
  draft.settings = { ...draft.settings, ...settings };
  if (clearBirthDate) delete draft.settings.birthDate;
}

export function updateProfileDraft(
  draft: AppState,
  patch: Partial<AppState["profile"]>,
) {
  Object.assign(draft.profile, patch);
}
