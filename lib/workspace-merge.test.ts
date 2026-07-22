import { describe, expect, it } from "vitest";
import { DEFAULT_AREAS, DEFAULT_SETTINGS, DEFAULT_STATS } from "@/lib/defaults";
import { parseImportedState } from "@/lib/state-schema";
import {
  WorkspaceMergeError,
  mergeAnonymousWorkspace,
  workspaceMergeFileEvidenceCopies,
  type WorkspaceEntityIdRemap,
} from "@/lib/workspace-merge";
import type { AppState, Goal } from "@/lib/types";

const CREATED_AT = "2026-07-20T09:00:00.000Z";
const COMPLETED_AT = "2026-07-21T10:00:00.000Z";
const MERGED_AT = "2026-07-22T12:00:00.000Z";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/i;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function workspace(label: string, remoteAccount: string): AppState {
  const defaultArea = clone(DEFAULT_AREAS[0]);
  const defaultStat = clone(DEFAULT_STATS[0]);
  return {
    version: 3,
    updatedAt: COMPLETED_AT,
    profile: {
      displayName: `${label} person`,
      chapter: `${label} chapter`,
      onboarded: true,
      createdAt: CREATED_AT,
    },
    settings: {
      ...clone(DEFAULT_SETTINGS),
      theme: label === "Account" ? "light" : "dark",
      terminology: {
        goals: `${label} outcomes`,
        quests: `${label} actions`,
        areas: `${label} areas`,
        milestones: `${label} milestones`,
        stats: `${label} qualities`,
      },
    },
    areas: [
      defaultArea,
      {
        id: "area-shared",
        name: `${label} custom area`,
        color: "#123456",
        icon: "Circle",
        order: 1,
      },
    ],
    stats: [
      defaultStat,
      {
        id: "stat-shared",
        name: `${label} custom quality`,
        color: "#654321",
        icon: "Star",
      },
    ],
    goals: [
      {
        id: "goal-shared",
        title: `${label} primary goal`,
        description: `${label} primary description`,
        areaId: "area-shared",
        model: "numeric",
        priority: "high",
        status: "active",
        createdAt: CREATED_AT,
        metrics: [{
          id: "metric-shared",
          label: `${label} metric`,
          current: 5,
          target: 10,
          unit: "units",
          weight: 100,
        }],
        milestones: [{
          id: "milestone-shared",
          title: `${label} milestone`,
          weight: 50,
          completed: true,
          completedAt: COMPLETED_AT,
          attribution: {
            areaId: "area-shared",
            statIds: ["stat-shared", defaultStat.id],
          },
        }],
        quests: [{
          id: "quest-shared",
          kind: "task",
          linkedGoalIds: ["goal-linked"],
          title: `${label} action`,
          repeat: "none",
          completed: true,
          completedAt: COMPLETED_AT,
          metricDeltas: [{ metricId: "metric-shared", amount: 2 }],
        }],
        statIds: ["stat-shared", defaultStat.id],
        checkIns: [{
          id: "check-in-shared",
          createdAt: COMPLETED_AT,
          note: `${label} check-in`,
          attribution: {
            areaId: "area-shared",
            statIds: ["stat-shared", defaultStat.id],
          },
        }],
        evidence: [
          { id: "evidence-note", type: "note", text: `${label} evidence note` },
          {
            id: "evidence-file",
            type: "file",
            name: "proof.txt",
            mimeType: "text/plain",
            size: 5,
            remotePath: `${remoteAccount}/goal-shared/evidence-file/proof.txt`,
          },
        ],
        notes: `${label} notes`,
      },
      {
        id: "goal-linked",
        title: `${label} linked goal`,
        description: "",
        areaId: defaultArea.id,
        model: "open",
        priority: "medium",
        status: "active",
        createdAt: CREATED_AT,
        metrics: [],
        milestones: [],
        quests: [],
        statIds: [defaultStat.id],
        checkIns: [],
        evidence: [],
        notes: "",
      },
    ],
    questCompletions: [
      {
        id: "completion-shared",
        goalId: "goal-shared",
        linkedGoalIds: ["goal-linked"],
        goalSnapshots: [
          {
            goalId: "goal-shared",
            areaId: "area-shared",
            statIds: ["stat-shared", defaultStat.id],
          },
          {
            goalId: "goal-linked",
            areaId: defaultArea.id,
            statIds: [defaultStat.id],
          },
        ],
        questId: "quest-shared",
        title: `${label} completed action`,
        completedAt: COMPLETED_AT,
        evidence: [`${label} completion evidence`],
        metricDeltas: [{ metricId: "metric-shared", amount: 2 }],
      },
      {
        id: "completion-history",
        goalId: "goal-shared",
        linkedGoalIds: [],
        goalSnapshots: [{
          goalId: "goal-shared",
          areaId: "area-shared",
          statIds: ["stat-shared", defaultStat.id],
        }],
        questId: "deleted-quest",
        title: `${label} deleted action history`,
        completedAt: CREATED_AT,
        evidence: [],
        metricDeltas: [{ metricId: "deleted-metric", amount: 1 }],
      },
    ],
    metricEntries: [
      {
        id: "entry-shared",
        goalId: "goal-shared",
        metricId: "metric-shared",
        label: `${label} metric`,
        unit: "units",
        value: 5,
        previousValue: 3,
        recordedAt: COMPLETED_AT,
        source: "quest",
        sourceCompletionId: "completion-shared",
        attribution: {
          areaId: "area-shared",
          statIds: ["stat-shared", defaultStat.id],
        },
      },
      {
        id: "entry-history",
        goalId: "goal-shared",
        metricId: "deleted-metric",
        label: `${label} old metric`,
        unit: "units",
        value: 2,
        previousValue: 1,
        recordedAt: CREATED_AT,
        source: "manual",
        attribution: {
          areaId: "area-shared",
          statIds: ["stat-shared", defaultStat.id],
        },
      },
    ],
    reviews: [{
      id: "review-shared",
      cadence: "weekly",
      createdAt: COMPLETED_AT,
      answers: { meaning: `${label} review answer` },
    }],
    timeline: [{
      id: "timeline-shared",
      type: "quest",
      title: `${label} timeline event`,
      detail: `${label} detail`,
      at: COMPLETED_AT,
      goalId: "goal-shared",
      areaId: "area-shared",
      relatedGoalIds: ["goal-shared", "goal-linked"],
      relatedAreaIds: ["area-shared", defaultArea.id],
      relatedStatIds: ["stat-shared", defaultStat.id],
    }],
  };
}

function bySource(items: WorkspaceEntityIdRemap[], sourceId: string) {
  const match = items.find((item) => item.sourceId === sourceId);
  if (!match) throw new Error(`Missing remap for ${sourceId}.`);
  return match;
}

describe("anonymous workspace merge", () => {
  it("preserves account identity, both source orders, and exact built-in references", () => {
    const account = workspace("Account", "account-owner");
    const anonymous = workspace("Anonymous", "anonymous-owner");
    const accountBefore = JSON.stringify(account);
    const anonymousBefore = JSON.stringify(anonymous);

    const first = mergeAnonymousWorkspace(account, anonymous, MERGED_AT);
    const second = mergeAnonymousWorkspace(account, anonymous, MERGED_AT);

    expect(first).toEqual(second);
    expect(first.state.updatedAt).toBe(MERGED_AT);
    expect(first.state.profile).toEqual(account.profile);
    expect(first.state.settings).toEqual(account.settings);
    expect(first.state.areas).toHaveLength(3);
    expect(first.state.stats).toHaveLength(3);
    expect(first.state.goals).toHaveLength(4);
    expect(first.state.questCompletions).toHaveLength(4);
    expect(first.state.metricEntries).toHaveLength(4);
    expect(first.state.reviews).toHaveLength(2);
    expect(first.state.timeline).toHaveLength(2);
    expect(first.state.goals.slice(0, account.goals.length)).toEqual(account.goals);
    expect(first.state.questCompletions[0].title).toBe("Account completed action");
    expect(first.state.questCompletions[2].title).toBe("Anonymous completed action");
    expect(bySource(first.remap.areas, DEFAULT_AREAS[0].id)).toEqual({
      sourceId: DEFAULT_AREAS[0].id,
      mergedId: DEFAULT_AREAS[0].id,
      deduplicated: true,
    });
    expect(bySource(first.remap.stats, DEFAULT_STATS[0].id)).toEqual({
      sourceId: DEFAULT_STATS[0].id,
      mergedId: DEFAULT_STATS[0].id,
      deduplicated: true,
    });
    expect(() => parseImportedState(first.state, MERGED_AT)).not.toThrow();
    expect(JSON.stringify(account)).toBe(accountBefore);
    expect(JSON.stringify(anonymous)).toBe(anonymousBefore);
  });

  it("remaps every anonymous entity and declared cross-reference", () => {
    const account = workspace("Account", "account-owner");
    const anonymous = workspace("Anonymous", "anonymous-owner");
    const { state, remap } = mergeAnonymousWorkspace(account, anonymous, MERGED_AT);
    const areaId = bySource(remap.areas, "area-shared").mergedId;
    const statId = bySource(remap.stats, "stat-shared").mergedId;
    const defaultAreaId = bySource(remap.areas, DEFAULT_AREAS[0].id).mergedId;
    const defaultStatId = bySource(remap.stats, DEFAULT_STATS[0].id).mergedId;
    const primaryReport = remap.goals.find((item) => item.sourceId === "goal-shared");
    const linkedReport = remap.goals.find((item) => item.sourceId === "goal-linked");
    if (!primaryReport || !linkedReport) throw new Error("Goal remaps were missing.");
    const metricId = bySource(primaryReport.metrics, "metric-shared").mergedId;
    const deletedMetricId = bySource(primaryReport.metrics, "deleted-metric").mergedId;
    const milestoneId = bySource(primaryReport.milestones, "milestone-shared").mergedId;
    const questId = bySource(primaryReport.quests, "quest-shared").mergedId;
    const deletedQuestId = bySource(primaryReport.quests, "deleted-quest").mergedId;
    const checkInId = bySource(primaryReport.checkIns, "check-in-shared").mergedId;
    const noteEvidence = bySource(primaryReport.evidence, "evidence-note");
    const fileEvidence = bySource(primaryReport.evidence, "evidence-file");
    const completionId = bySource(remap.questCompletions, "completion-shared").mergedId;
    const historicalCompletionId = bySource(remap.questCompletions, "completion-history").mergedId;
    const entryId = bySource(remap.metricEntries, "entry-shared").mergedId;
    const historyEntryId = bySource(remap.metricEntries, "entry-history").mergedId;

    const primary = state.goals.find((goal) => goal.id === primaryReport.mergedId);
    if (!primary) throw new Error("Merged primary goal was missing.");
    expect(primary.areaId).toBe(areaId);
    expect(primary.statIds).toEqual([statId, defaultStatId]);
    expect(primary.metrics[0].id).toBe(metricId);
    expect(primary.milestones[0]).toMatchObject({
      id: milestoneId,
      attribution: { areaId, statIds: [statId, defaultStatId] },
    });
    expect(primary.quests[0]).toMatchObject({
      id: questId,
      linkedGoalIds: [linkedReport.mergedId],
      metricDeltas: [{ metricId, amount: 2 }],
    });
    expect(primary.checkIns[0]).toMatchObject({
      id: checkInId,
      attribution: { areaId, statIds: [statId, defaultStatId] },
    });
    expect(primary.evidence.map((item) => item.id)).toEqual([
      noteEvidence.mergedId,
      fileEvidence.mergedId,
    ]);
    expect(primary.evidence[1]).not.toHaveProperty("remotePath");
    expect(fileEvidence).toMatchObject({
      sourceRemotePath: "anonymous-owner/goal-shared/evidence-file/proof.txt",
    });
    expect(workspaceMergeFileEvidenceCopies(anonymous, { state, remap })).toEqual([{
      sourceGoalId: "goal-shared",
      sourceEvidenceId: "evidence-file",
      mergedGoalId: primary.id,
      mergedEvidenceId: fileEvidence.mergedId,
      source: anonymous.goals[0].evidence[1],
    }]);

    const completion = state.questCompletions.find((item) => item.id === completionId);
    expect(completion).toMatchObject({
      goalId: primary.id,
      linkedGoalIds: [linkedReport.mergedId],
      questId,
      evidence: ["Anonymous completion evidence"],
      metricDeltas: [{ metricId, amount: 2 }],
      goalSnapshots: [
        { goalId: primary.id, areaId, statIds: [statId, defaultStatId] },
        { goalId: linkedReport.mergedId, areaId: defaultAreaId, statIds: [defaultStatId] },
      ],
    });
    expect(state.questCompletions.find((item) => item.id === historicalCompletionId)).toMatchObject({
      goalId: primary.id,
      questId: deletedQuestId,
      metricDeltas: [{ metricId: deletedMetricId, amount: 1 }],
    });
    expect(state.metricEntries.find((item) => item.id === entryId)).toMatchObject({
      goalId: primary.id,
      metricId,
      sourceCompletionId: completionId,
      attribution: { areaId, statIds: [statId, defaultStatId] },
    });
    expect(state.metricEntries.find((item) => item.id === historyEntryId)).toMatchObject({
      goalId: primary.id,
      metricId: deletedMetricId,
    });
    expect(state.reviews.find((item) => item.id === bySource(remap.reviews, "review-shared").mergedId)).toMatchObject({
      answers: { meaning: "Anonymous review answer" },
    });
    expect(state.timeline.find((item) => item.id === bySource(remap.timeline, "timeline-shared").mergedId)).toMatchObject({
      goalId: primary.id,
      areaId,
      relatedGoalIds: [primary.id, linkedReport.mergedId],
      relatedAreaIds: [areaId, defaultAreaId],
      relatedStatIds: [statId, defaultStatId],
    });

    const generated = [
      ...remap.areas.filter((item) => !item.deduplicated),
      ...remap.stats.filter((item) => !item.deduplicated),
      ...remap.goals.flatMap((goal) => [
        goal,
        ...goal.metrics,
        ...goal.milestones,
        ...goal.quests,
        ...goal.checkIns,
        ...goal.evidence,
      ]),
      ...remap.questCompletions,
      ...remap.metricEntries,
      ...remap.reviews,
      ...remap.timeline,
    ].map((item) => item.mergedId);
    expect(new Set(generated).size).toBe(generated.length);
    generated.forEach((id) => expect(id).toMatch(UUID_PATTERN));
    expect(() => parseImportedState(state, MERGED_AT)).not.toThrow();
  });

  it("deterministically retries when the first generated id is already reserved", () => {
    const account = workspace("Account", "account-owner");
    const anonymous = workspace("Anonymous", "anonymous-owner");
    const firstCandidate = mergeAnonymousWorkspace(account, anonymous, MERGED_AT)
      .remap.goals[0].mergedId;
    const occupied: Goal = {
      id: firstCandidate,
      title: "Occupied deterministic id",
      description: "",
      areaId: "area-shared",
      model: "open",
      priority: "low",
      status: "active",
      createdAt: CREATED_AT,
      metrics: [],
      milestones: [],
      quests: [],
      statIds: [],
      checkIns: [],
      evidence: [],
      notes: "",
    };
    const accountWithCollision = clone(account);
    accountWithCollision.goals.push(occupied);

    const first = mergeAnonymousWorkspace(accountWithCollision, anonymous, MERGED_AT);
    const second = mergeAnonymousWorkspace(accountWithCollision, anonymous, MERGED_AT);
    const remappedId = first.remap.goals[0].mergedId;

    expect(remappedId).not.toBe(firstCandidate);
    expect(remappedId).toBe(second.remap.goals[0].mergedId);
    expect(remappedId).toMatch(UUID_PATTERN);
    expect(() => parseImportedState(first.state, MERGED_AT)).not.toThrow();
  });

  it("does not deduplicate a built-in reference after either source changes it", () => {
    const account = workspace("Account", "account-owner");
    const anonymous = workspace("Anonymous", "anonymous-owner");
    anonymous.areas[0] = { ...anonymous.areas[0], name: "Renamed university" };
    anonymous.stats[0] = { ...anonymous.stats[0], archived: true };

    const { state, remap } = mergeAnonymousWorkspace(account, anonymous, MERGED_AT);
    const area = bySource(remap.areas, DEFAULT_AREAS[0].id);
    const stat = bySource(remap.stats, DEFAULT_STATS[0].id);
    const linkedGoalId = remap.goals.find((item) => item.sourceId === "goal-linked")?.mergedId;
    const linkedGoal = state.goals.find((goal) => goal.id === linkedGoalId);

    expect(area.deduplicated).toBe(false);
    expect(stat.deduplicated).toBe(false);
    expect(area.mergedId).toMatch(UUID_PATTERN);
    expect(stat.mergedId).toMatch(UUID_PATTERN);
    expect(state.areas).toHaveLength(4);
    expect(state.stats).toHaveLength(4);
    expect(linkedGoal).toMatchObject({
      areaId: area.mergedId,
      statIds: [stat.mergedId],
    });
    expect(() => parseImportedState(state, MERGED_AT)).not.toThrow();
  });

  it("rejects malformed, non-v3, or invalidly timestamped merges without coercion", () => {
    const account = workspace("Account", "account-owner");
    const anonymous = workspace("Anonymous", "anonymous-owner");
    const malformed = clone(anonymous);
    malformed.goals[0].areaId = "missing-area";
    const oldVersion = { ...clone(anonymous), version: 2 } as unknown as AppState;

    expect(() => mergeAnonymousWorkspace(account, malformed, MERGED_AT)).toThrow(/missing area/i);
    expect(() => mergeAnonymousWorkspace(account, oldVersion, MERGED_AT)).toThrow(WorkspaceMergeError);
    expect(() => mergeAnonymousWorkspace(account, anonymous, "not-a-date")).toThrow(/valid date/i);
  });
});
