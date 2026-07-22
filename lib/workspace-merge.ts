import { DEFAULT_AREAS, DEFAULT_STATS } from "@/lib/defaults";
import { stableEvidenceId } from "@/lib/goal-evidence";
import { CURRENT_STATE_VERSION, parseImportedState } from "@/lib/state-schema";
import type {
  AppState,
  Area,
  AttributionSnapshot,
  Goal,
  GoalEvidence,
  GoalFileEvidence,
  GoalAttributionSnapshot,
  LifeStat,
  MetricDelta,
  QuestCompletion,
  TimelineEvent,
} from "@/lib/types";

const MERGE_ID_NAMESPACE = "evolvra-workspace-merge-v1";
const BUILT_IN_AREA_IDS = new Set(DEFAULT_AREAS.map((area) => area.id));
const BUILT_IN_STAT_IDS = new Set(DEFAULT_STATS.map((stat) => stat.id));

export interface WorkspaceEntityIdRemap {
  sourceId: string;
  mergedId: string;
  deduplicated: boolean;
}

export interface WorkspaceEvidenceIdRemap extends WorkspaceEntityIdRemap {
  sourceGoalId: string;
  mergedGoalId: string;
  sourceRemotePath?: string;
}

export interface WorkspaceGoalIdRemap extends WorkspaceEntityIdRemap {
  metrics: WorkspaceEntityIdRemap[];
  milestones: WorkspaceEntityIdRemap[];
  quests: WorkspaceEntityIdRemap[];
  checkIns: WorkspaceEntityIdRemap[];
  evidence: WorkspaceEvidenceIdRemap[];
}

export interface WorkspaceMergeIdRemap {
  areas: WorkspaceEntityIdRemap[];
  stats: WorkspaceEntityIdRemap[];
  goals: WorkspaceGoalIdRemap[];
  questCompletions: WorkspaceEntityIdRemap[];
  metricEntries: WorkspaceEntityIdRemap[];
  reviews: WorkspaceEntityIdRemap[];
  timeline: WorkspaceEntityIdRemap[];
}

export interface WorkspaceMergeResult {
  state: AppState;
  remap: WorkspaceMergeIdRemap;
}

export interface WorkspaceFileEvidenceCopy {
  sourceGoalId: string;
  sourceEvidenceId: string;
  mergedGoalId: string;
  mergedEvidenceId: string;
  source: GoalFileEvidence;
}

export class WorkspaceMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceMergeError";
  }
}

interface GoalRemapContext {
  source: Goal;
  mergedId: string;
  metricIds: Map<string, string>;
  milestoneIds: Map<string, string>;
  questIds: Map<string, string>;
  checkInIds: Map<string, string>;
  evidenceIds: Map<string, string>;
  evidencePaths: Map<string, { source?: string }>;
}

const cloneJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && jsonValuesEqual(leftRecord[key], rightRecord[key])
    ));
}

function addAttributionIds(target: Set<string>, attribution?: AttributionSnapshot) {
  if (!attribution) return;
  target.add(attribution.areaId);
  attribution.statIds.forEach((id) => target.add(id));
}

/** Reserves every declared entity and reference id from both source graphs. */
function collectWorkspaceIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  state.areas.forEach((area) => ids.add(area.id));
  state.stats.forEach((stat) => ids.add(stat.id));
  state.goals.forEach((goal) => {
    ids.add(goal.id);
    ids.add(goal.areaId);
    goal.statIds.forEach((id) => ids.add(id));
    goal.metrics.forEach((metric) => ids.add(metric.id));
    goal.milestones.forEach((milestone) => {
      ids.add(milestone.id);
      addAttributionIds(ids, milestone.attribution);
    });
    goal.quests.forEach((quest) => {
      ids.add(quest.id);
      quest.linkedGoalIds.forEach((id) => ids.add(id));
      quest.metricDeltas.forEach((delta) => ids.add(delta.metricId));
    });
    goal.checkIns.forEach((checkIn) => {
      ids.add(checkIn.id);
      addAttributionIds(ids, checkIn.attribution);
    });
    goal.evidence.forEach((evidence) => ids.add(evidence.id));
  });
  state.questCompletions.forEach((completion) => {
    ids.add(completion.id);
    ids.add(completion.goalId);
    ids.add(completion.questId);
    completion.linkedGoalIds.forEach((id) => ids.add(id));
    completion.goalSnapshots?.forEach((snapshot) => {
      ids.add(snapshot.goalId);
      addAttributionIds(ids, snapshot);
    });
    completion.metricDeltas.forEach((delta) => ids.add(delta.metricId));
  });
  state.metricEntries.forEach((entry) => {
    ids.add(entry.id);
    ids.add(entry.goalId);
    ids.add(entry.metricId);
    if (entry.sourceCompletionId) ids.add(entry.sourceCompletionId);
    addAttributionIds(ids, entry.attribution);
  });
  state.reviews.forEach((review) => ids.add(review.id));
  state.timeline.forEach((event) => {
    ids.add(event.id);
    if (event.goalId) ids.add(event.goalId);
    if (event.areaId) ids.add(event.areaId);
    event.relatedGoalIds?.forEach((id) => ids.add(id));
    event.relatedAreaIds?.forEach((id) => ids.add(id));
    event.relatedStatIds?.forEach((id) => ids.add(id));
  });
  return ids;
}

function createIdAllocator(...states: AppState[]) {
  const reserved = new Set<string>();
  states.forEach((state) => collectWorkspaceIds(state).forEach((id) => reserved.add(id)));

  return (kind: string, context: string, sourceId: string): string => {
    for (let attempt = 0; attempt <= Number.MAX_SAFE_INTEGER; attempt += 1) {
      const candidate = stableEvidenceId(JSON.stringify([
        MERGE_ID_NAMESPACE,
        kind,
        context,
        sourceId,
        attempt,
      ]));
      if (reserved.has(candidate)) continue;
      reserved.add(candidate);
      return candidate;
    }
    throw new WorkspaceMergeError(`Could not allocate a collision-free ${kind} identifier.`);
  };
}

function mappedId(map: Map<string, string>, sourceId: string, label: string): string {
  const mapped = map.get(sourceId);
  if (!mapped) throw new WorkspaceMergeError(`The anonymous ${label} reference "${sourceId}" is missing.`);
  return mapped;
}

function entityRemaps(map: Map<string, string>): WorkspaceEntityIdRemap[] {
  return [...map].map(([sourceId, mergedId]) => ({
    sourceId,
    mergedId,
    deduplicated: false,
  }));
}

function remapAttribution(
  attribution: AttributionSnapshot,
  areaIds: Map<string, string>,
  statIds: Map<string, string>,
): AttributionSnapshot {
  return {
    areaId: mappedId(areaIds, attribution.areaId, "area"),
    statIds: attribution.statIds.map((id) => mappedId(statIds, id, "quality")),
  };
}

function remapGoalAttribution(
  snapshot: GoalAttributionSnapshot,
  goalIds: Map<string, string>,
  areaIds: Map<string, string>,
  statIds: Map<string, string>,
): GoalAttributionSnapshot {
  return {
    goalId: mappedId(goalIds, snapshot.goalId, "goal"),
    ...remapAttribution(snapshot, areaIds, statIds),
  };
}

function remapMetricDeltas(
  deltas: MetricDelta[],
  metricId: (sourceId: string) => string,
): MetricDelta[] {
  return deltas.map((delta) => ({
    ...delta,
    metricId: metricId(delta.metricId),
  }));
}

function remapEvidence(
  evidence: GoalEvidence,
  mergedEvidenceId: string,
): GoalEvidence {
  if (evidence.type !== "file") return { ...evidence, id: mergedEvidenceId };
  const { remotePath: _unsafeSourcePath, ...portable } = evidence;
  void _unsafeSourcePath;
  return {
    ...portable,
    id: mergedEvidenceId,
  };
}

function assertCurrentWorkspace(state: AppState, label: string) {
  if (state.version !== CURRENT_STATE_VERSION) {
    throw new WorkspaceMergeError(`${label} workspace must already use version ${CURRENT_STATE_VERSION}.`);
  }
  parseImportedState(state, state.updatedAt);
}

function buildReferenceMap<T extends { id: string }>(
  accountItems: T[],
  anonymousItems: T[],
  builtInIds: Set<string>,
  allocate: (kind: string, context: string, sourceId: string) => string,
  kind: string,
): {
  ids: Map<string, string>;
  appended: T[];
  report: WorkspaceEntityIdRemap[];
} {
  const accountById = new Map(accountItems.map((item) => [item.id, item]));
  const ids = new Map<string, string>();
  const appended: T[] = [];
  const report: WorkspaceEntityIdRemap[] = [];

  anonymousItems.forEach((item) => {
    const accountItem = accountById.get(item.id);
    const deduplicated = builtInIds.has(item.id)
      && accountItem !== undefined
      && jsonValuesEqual(accountItem, item);
    const mergedId = deduplicated ? item.id : allocate(kind, "workspace", item.id);
    ids.set(item.id, mergedId);
    report.push({ sourceId: item.id, mergedId, deduplicated });
    if (!deduplicated) appended.push({ ...item, id: mergedId });
  });

  return { ids, appended, report };
}

/**
 * Losslessly combines an anonymous v3 workspace with an account v3 workspace.
 * Account identity/preferences remain authoritative. The caller supplies the
 * merge timestamp so identical arguments always produce identical output.
 */
export function mergeAnonymousWorkspace(
  accountSource: AppState,
  anonymousSource: AppState,
  updatedAt: string,
): WorkspaceMergeResult {
  assertCurrentWorkspace(accountSource, "Account");
  assertCurrentWorkspace(anonymousSource, "Anonymous");
  const account = cloneJson(accountSource);
  const anonymous = cloneJson(anonymousSource);
  const allocate = createIdAllocator(account, anonymous);

  const areas = buildReferenceMap<Area>(
    account.areas,
    anonymous.areas,
    BUILT_IN_AREA_IDS,
    allocate,
    "area",
  );
  const stats = buildReferenceMap<LifeStat>(
    account.stats,
    anonymous.stats,
    BUILT_IN_STAT_IDS,
    allocate,
    "quality",
  );

  const goalIds = new Map<string, string>();
  anonymous.goals.forEach((goal) => {
    goalIds.set(goal.id, allocate("goal", "workspace", goal.id));
  });

  const goalContexts = new Map<string, GoalRemapContext>();
  anonymous.goals.forEach((goal) => {
    const context = goal.id;
    goalContexts.set(goal.id, {
      source: goal,
      mergedId: mappedId(goalIds, goal.id, "goal"),
      metricIds: new Map(goal.metrics.map((metric) => [
        metric.id,
        allocate("metric", context, metric.id),
      ])),
      milestoneIds: new Map(goal.milestones.map((milestone) => [
        milestone.id,
        allocate("milestone", context, milestone.id),
      ])),
      questIds: new Map(goal.quests.map((quest) => [
        quest.id,
        allocate("action", context, quest.id),
      ])),
      checkInIds: new Map(goal.checkIns.map((checkIn) => [
        checkIn.id,
        allocate("check-in", context, checkIn.id),
      ])),
      evidenceIds: new Map(goal.evidence.map((evidence) => [
        evidence.id,
        allocate("evidence", context, evidence.id),
      ])),
      evidencePaths: new Map(),
    });
  });

  const goalContext = (sourceGoalId: string) => {
    const context = goalContexts.get(sourceGoalId);
    if (!context) throw new WorkspaceMergeError(`The anonymous goal reference "${sourceGoalId}" is missing.`);
    return context;
  };
  const remapMetricId = (context: GoalRemapContext, sourceId: string) => {
    const existing = context.metricIds.get(sourceId);
    if (existing) return existing;
    const merged = allocate("historical-metric", context.source.id, sourceId);
    context.metricIds.set(sourceId, merged);
    return merged;
  };
  const remapQuestId = (context: GoalRemapContext, sourceId: string) => {
    const existing = context.questIds.get(sourceId);
    if (existing) return existing;
    const merged = allocate("historical-action", context.source.id, sourceId);
    context.questIds.set(sourceId, merged);
    return merged;
  };

  const remappedGoals = anonymous.goals.map((goal): Goal => {
    const context = goalContext(goal.id);
    return {
      ...goal,
      id: context.mergedId,
      areaId: mappedId(areas.ids, goal.areaId, "area"),
      metrics: goal.metrics.map((metric) => ({
        ...metric,
        id: mappedId(context.metricIds, metric.id, "metric"),
      })),
      milestones: goal.milestones.map((milestone) => ({
        ...milestone,
        id: mappedId(context.milestoneIds, milestone.id, "milestone"),
        ...(milestone.attribution
          ? { attribution: remapAttribution(milestone.attribution, areas.ids, stats.ids) }
          : {}),
      })),
      quests: goal.quests.map((quest) => ({
        ...quest,
        id: mappedId(context.questIds, quest.id, "action"),
        linkedGoalIds: quest.linkedGoalIds.map((id) => mappedId(goalIds, id, "goal")),
        metricDeltas: remapMetricDeltas(quest.metricDeltas, (id) => remapMetricId(context, id)),
      })),
      statIds: goal.statIds.map((id) => mappedId(stats.ids, id, "quality")),
      checkIns: goal.checkIns.map((checkIn) => ({
        ...checkIn,
        id: mappedId(context.checkInIds, checkIn.id, "check-in"),
        ...(checkIn.attribution
          ? { attribution: remapAttribution(checkIn.attribution, areas.ids, stats.ids) }
          : {}),
      })),
      evidence: goal.evidence.map((evidence) => {
        const mergedEvidenceId = mappedId(context.evidenceIds, evidence.id, "evidence");
        const mapped = remapEvidence(evidence, mergedEvidenceId);
        context.evidencePaths.set(evidence.id, {
          ...(evidence.type === "file" && evidence.remotePath
            ? { source: evidence.remotePath }
            : {}),
        });
        return mapped;
      }),
    };
  });

  const completionIds = new Map(anonymous.questCompletions.map((completion) => [
    completion.id,
    allocate("action-completion", "workspace", completion.id),
  ]));
  const remappedCompletions = anonymous.questCompletions.map((completion): QuestCompletion => {
    const context = goalContext(completion.goalId);
    return {
      ...completion,
      id: mappedId(completionIds, completion.id, "action history"),
      goalId: context.mergedId,
      linkedGoalIds: completion.linkedGoalIds.map((id) => mappedId(goalIds, id, "goal")),
      ...(completion.goalSnapshots
        ? {
            goalSnapshots: completion.goalSnapshots.map((snapshot) => (
              remapGoalAttribution(snapshot, goalIds, areas.ids, stats.ids)
            )),
          }
        : {}),
      questId: remapQuestId(context, completion.questId),
      evidence: [...completion.evidence],
      metricDeltas: remapMetricDeltas(
        completion.metricDeltas,
        (id) => remapMetricId(context, id),
      ),
    };
  });

  const metricEntryIds = new Map(anonymous.metricEntries.map((entry) => [
    entry.id,
    allocate("metric-entry", "workspace", entry.id),
  ]));
  const remappedMetricEntries = anonymous.metricEntries.map((entry) => {
    const context = goalContext(entry.goalId);
    return {
      ...entry,
      id: mappedId(metricEntryIds, entry.id, "metric history"),
      goalId: context.mergedId,
      metricId: remapMetricId(context, entry.metricId),
      ...(entry.sourceCompletionId
        ? {
            sourceCompletionId: mappedId(
              completionIds,
              entry.sourceCompletionId,
              "source action completion",
            ),
          }
        : {}),
      ...(entry.attribution
        ? { attribution: remapAttribution(entry.attribution, areas.ids, stats.ids) }
        : {}),
    };
  });

  const reviewIds = new Map(anonymous.reviews.map((review) => [
    review.id,
    allocate("review", "workspace", review.id),
  ]));
  const remappedReviews = anonymous.reviews.map((review) => ({
    ...review,
    id: mappedId(reviewIds, review.id, "review"),
    answers: { ...review.answers },
  }));

  const timelineIds = new Map(anonymous.timeline.map((event) => [
    event.id,
    allocate("timeline-event", "workspace", event.id),
  ]));
  const remappedTimeline = anonymous.timeline.map((event): TimelineEvent => ({
    ...event,
    id: mappedId(timelineIds, event.id, "timeline event"),
    ...(event.goalId ? { goalId: mappedId(goalIds, event.goalId, "goal") } : {}),
    ...(event.areaId ? { areaId: mappedId(areas.ids, event.areaId, "area") } : {}),
    ...(event.relatedGoalIds
      ? { relatedGoalIds: event.relatedGoalIds.map((id) => mappedId(goalIds, id, "goal")) }
      : {}),
    ...(event.relatedAreaIds
      ? { relatedAreaIds: event.relatedAreaIds.map((id) => mappedId(areas.ids, id, "area")) }
      : {}),
    ...(event.relatedStatIds
      ? { relatedStatIds: event.relatedStatIds.map((id) => mappedId(stats.ids, id, "quality")) }
      : {}),
  }));

  const state: AppState = {
    ...account,
    version: CURRENT_STATE_VERSION,
    updatedAt,
    profile: cloneJson(account.profile),
    settings: cloneJson(account.settings),
    areas: [...account.areas, ...areas.appended],
    stats: [...account.stats, ...stats.appended],
    goals: [...account.goals, ...remappedGoals],
    questCompletions: [...account.questCompletions, ...remappedCompletions],
    metricEntries: [...account.metricEntries, ...remappedMetricEntries],
    reviews: [...account.reviews, ...remappedReviews],
    timeline: [...account.timeline, ...remappedTimeline],
  };

  // The strict importer verifies collection limits and every remapped edge.
  // Its migrated return value is intentionally discarded so no valid source
  // value is coerced or inferred by the merge itself.
  parseImportedState(state, updatedAt);

  const goalReport: WorkspaceGoalIdRemap[] = anonymous.goals.map((goal) => {
    const context = goalContext(goal.id);
    return {
      sourceId: goal.id,
      mergedId: context.mergedId,
      deduplicated: false,
      metrics: entityRemaps(context.metricIds),
      milestones: entityRemaps(context.milestoneIds),
      quests: entityRemaps(context.questIds),
      checkIns: entityRemaps(context.checkInIds),
      evidence: [...context.evidenceIds].map(([sourceId, mergedId]) => {
        const paths = context.evidencePaths.get(sourceId);
        return {
          sourceId,
          mergedId,
          deduplicated: false,
          sourceGoalId: goal.id,
          mergedGoalId: context.mergedId,
          ...(paths?.source ? { sourceRemotePath: paths.source } : {}),
        };
      }),
    };
  });

  return {
    state,
    remap: {
      areas: areas.report,
      stats: stats.report,
      goals: goalReport,
      questCompletions: entityRemaps(completionIds),
      metricEntries: entityRemaps(metricEntryIds),
      reviews: entityRemaps(reviewIds),
      timeline: entityRemaps(timelineIds),
    },
  };
}

/**
 * Returns every file copy required by a merge in anonymous source order. The
 * merged metadata intentionally has no remotePath until bytes are uploaded to
 * a path owned by the target account.
 */
export function workspaceMergeFileEvidenceCopies(
  anonymousSource: AppState,
  result: WorkspaceMergeResult,
): WorkspaceFileEvidenceCopy[] {
  const goalRemaps = new Map(result.remap.goals.map((goal) => [goal.sourceId, goal]));
  const copies: WorkspaceFileEvidenceCopy[] = [];
  for (const goal of anonymousSource.goals) {
    const goalRemap = goalRemaps.get(goal.id);
    if (!goalRemap) throw new WorkspaceMergeError(`The evidence merge is missing goal "${goal.id}".`);
    const evidenceRemaps = new Map(goalRemap.evidence.map((item) => [item.sourceId, item]));
    const mergedGoal = result.state.goals.find((item) => item.id === goalRemap.mergedId);
    if (!mergedGoal) throw new WorkspaceMergeError(`The merged evidence goal "${goalRemap.mergedId}" is missing.`);
    for (const evidence of goal.evidence) {
      if (evidence.type !== "file") continue;
      const evidenceRemap = evidenceRemaps.get(evidence.id);
      if (!evidenceRemap) {
        throw new WorkspaceMergeError(`The evidence merge is missing file "${evidence.id}".`);
      }
      const mergedEvidence = mergedGoal.evidence.find((item) => item.id === evidenceRemap.mergedId);
      if (!mergedEvidence || mergedEvidence.type !== "file" || mergedEvidence.remotePath) {
        throw new WorkspaceMergeError(`The merged file metadata "${evidenceRemap.mergedId}" is unsafe.`);
      }
      copies.push({
        sourceGoalId: goal.id,
        sourceEvidenceId: evidence.id,
        mergedGoalId: goalRemap.mergedId,
        mergedEvidenceId: evidenceRemap.mergedId,
        source: cloneJson(evidence),
      });
    }
  }
  return copies;
}
