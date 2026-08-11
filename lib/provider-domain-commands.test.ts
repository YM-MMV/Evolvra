import { describe, expect, it } from "vitest";
import { createStarterGoals, EMPTY_STATE } from "@/lib/defaults";
import {
  addCheckInDraft,
  addGoalDraft,
  addQuestDraft,
  addReviewDraft,
  completeQuestDraft,
  deleteGoalRecordsDraft,
  normalizeSettingsPatch,
  setGoalFileEvidenceDraft,
  setGoalStatusDraft,
  toggleMilestoneDraft,
  updateGoalDraft,
  updateMetricDraft,
  updateSettingsDraft,
  type ProviderCommandRuntime,
} from "@/lib/provider-domain-commands";
import { cloneWorkspaceValue } from "@/lib/provider-state";
import { parseImportedState } from "@/lib/state-schema";

function runtime(): ProviderCommandRuntime {
  let sequence = 0;
  return {
    now: () => "2026-07-18T12:00:00.000Z",
    id: (prefix) => `${prefix}-${++sequence}`,
  };
}

describe("provider domain commands", () => {
  it("records one recurring occurrence, its linked goals, and metric ledger once", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals.find((item) => item.model === "consistency")!;
    const quest = goal.quests[0];
    const linkedGoalId = draft.goals.find((item) => item.id !== goal.id)!.id;
    quest.linkedGoalIds = [linkedGoalId];
    const commandRuntime = runtime();

    completeQuestDraft(draft, goal.id, quest.id, {
      durationMinutes: 31,
      note: "  Calm effort  ",
    }, commandRuntime);

    expect(draft.questCompletions).toHaveLength(1);
    expect(draft.questCompletions[0]).toMatchObject({
      goalId: goal.id,
      linkedGoalIds: [linkedGoalId],
      questId: quest.id,
      durationMinutes: 31,
      note: "Calm effort",
    });
    expect(draft.metricEntries).toHaveLength(1);
    expect(draft.metricEntries[0]).toMatchObject({
      goalId: goal.id,
      source: "quest",
    });
    expect(draft.timeline.filter((event) => event.type === "quest")).toHaveLength(1);
    expect(() => parseImportedState(draft)).not.toThrow();

    completeQuestDraft(draft, goal.id, quest.id, {}, commandRuntime);
    expect(draft.questCompletions).toHaveLength(1);
    expect(draft.metricEntries).toHaveLength(1);
  });

  it("applies every finite default metric change from one reusable action", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals.find((item) => item.model === "consistency")!;
    const quest = goal.quests[0];
    goal.metrics.push({
      id: "metric-distance",
      label: "Distance this month",
      current: 10,
      target: 50,
      unit: "km",
      weight: 50,
      period: "month",
      periodKey: goal.metrics[0].periodKey,
    });
    goal.metrics[0].weight = 50;
    quest.metricDeltas = [
      { metricId: goal.metrics[0].id, amount: 1 },
      { metricId: "metric-distance", amount: 4.5 },
    ];

    completeQuestDraft(draft, goal.id, quest.id, {}, runtime());

    expect(draft.questCompletions[0].metricDeltas).toEqual([
      { metricId: goal.metrics[0].id, amount: 1 },
      { metricId: "metric-distance", amount: 4.5 },
    ]);
    expect(goal.metrics.map((metric) => metric.current)).toEqual([4, 14.5]);
    expect(draft.metricEntries).toHaveLength(2);
    expect(draft.metricEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricId: goal.metrics[0].id, previousValue: 3, value: 4 }),
      expect.objectContaining({ metricId: "metric-distance", previousValue: 10, value: 14.5 }),
    ]));
    expect(() => parseImportedState(draft)).not.toThrow();
  });

  it("keeps a newly added shared action and its completion canonical", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const sourceGoal = draft.goals.find((item) => item.model === "weighted")!;
    const linkedGoal = draft.goals.find((item) => item.model === "consistency")!;
    const quest = {
      id: "quest-shared-reflection",
      kind: "session" as const,
      linkedGoalIds: [linkedGoal.id],
      title: "Reflect while walking",
      repeat: "none" as const,
      completed: false,
      durationMinutes: 25,
      metricDeltas: [],
    };

    let timestampOffset = 0;
    let idSequence = 0;
    const changingRuntime: ProviderCommandRuntime = {
      now: () => new Date(Date.parse("2026-07-18T12:00:00.000Z") + timestampOffset++).toISOString(),
      id: (prefix) => `${prefix}-changing-${++idSequence}`,
    };

    addQuestDraft(draft, sourceGoal.id, quest, changingRuntime);
    expect(() => parseImportedState(draft)).not.toThrow();
    completeQuestDraft(draft, sourceGoal.id, quest.id, {
      durationMinutes: 28,
      note: "The walk clarified the next release decision.",
      evidence: ["Shared with both goals"],
    }, changingRuntime);

    expect(() => parseImportedState(draft)).not.toThrow();
  });

  it("records a milestone only on its first lifetime completion", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals[0];
    const milestone = goal.milestones.find((item) => !item.completed)!;
    const commandRuntime = runtime();

    toggleMilestoneDraft(draft, goal.id, milestone.id, commandRuntime);
    toggleMilestoneDraft(draft, goal.id, milestone.id, commandRuntime);
    toggleMilestoneDraft(draft, goal.id, milestone.id, commandRuntime);

    expect(milestone.completed).toBe(true);
    expect(milestone.completedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(draft.timeline.filter((event) => event.type === "milestone")).toHaveLength(1);
  });

  it("retains one immutable first-completion outcome after later edits and reopening", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals.find((item) => item.model === "consistency")!;
    goal.metrics[0].periodKey = "month:2026-07";
    const metric = goal.metrics[0];
    const milestone = goal.milestones[0];
    const commandRuntime = runtime();
    addCheckInDraft(draft, goal.id, "Ready to close this chapter.", commandRuntime);

    setGoalStatusDraft(draft, goal.id, "completed", commandRuntime);
    const firstSnapshot = structuredClone(goal.completionSnapshot);

    expect(firstSnapshot).toMatchObject({
      version: 1,
      completedAt: "2026-07-18T12:00:00.000Z",
      title: goal.title,
      model: "consistency",
      metricCount: goal.metrics.length,
      milestoneCount: goal.milestones.length,
      checkInCount: 1,
    });
    expect(firstSnapshot?.metrics[0]).toMatchObject({
      id: metric.id,
      current: metric.current,
      target: metric.target,
    });
    expect(firstSnapshot?.milestones[0]).toMatchObject({
      id: milestone.id,
      completed: false,
    });
    expect(firstSnapshot?.checkIns[0].note).toBe("Ready to close this chapter.");

    setGoalStatusDraft(draft, goal.id, "active", commandRuntime);
    updateMetricDraft(draft, goal.id, metric.id, metric.current + 5, commandRuntime);
    toggleMilestoneDraft(draft, goal.id, milestone.id, commandRuntime);
    addCheckInDraft(draft, goal.id, "This happened after reopening.", commandRuntime);
    updateGoalDraft(draft, goal.id, {
      title: "A later title",
      completedAt: "2030-01-01T00:00:00.000Z",
      completionSnapshot: {
        ...goal.completionSnapshot!,
        title: "Rewritten outcome",
      },
    }, commandRuntime);
    setGoalStatusDraft(draft, goal.id, "completed", commandRuntime);

    expect(goal.completedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(goal.completionSnapshot).toEqual(firstSnapshot);
    expect(goal.title).toBe("A later title");
    expect(() => parseImportedState(draft)).not.toThrow();
  });

  it("rolls stale consistency windows before recording the first-completion outcome", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals.find((item) => item.model === "consistency")!;
    goal.metrics[0] = {
      ...goal.metrics[0],
      current: 9,
      period: "month",
      periodKey: "month:2026-06",
    };
    const commandRuntime: ProviderCommandRuntime = {
      now: () => "2026-07-18T12:00:00.000Z",
      id: (prefix) => `${prefix}-period-roll`,
    };

    setGoalStatusDraft(draft, goal.id, "completed", commandRuntime);

    expect(goal.metrics[0]).toMatchObject({
      current: 0,
      period: "month",
      periodKey: "month:2026-07",
    });
    expect(goal.completionSnapshot?.metrics[0]).toMatchObject({
      current: 0,
      period: "month",
      periodKey: "month:2026-07",
    });
    expect(() => parseImportedState(draft)).not.toThrow();
  });

  it("saves a bounded review context that survives deletion of its source goal", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals[0];
    const quest = goal.quests[0];
    const commandRuntime = runtime();

    completeQuestDraft(draft, goal.id, quest.id, {
      durationMinutes: 20,
      note: "A useful source detail.",
    }, commandRuntime);
    addCheckInDraft(draft, goal.id, "A source check-in.", commandRuntime);
    addReviewDraft(draft, {
      id: "review-one",
      cadence: "weekly",
      createdAt: "2026-07-18T12:00:00.000Z",
      answers: { movement: "The next step is clearer." },
    }, commandRuntime);

    const savedContext = structuredClone(draft.reviews[0].context);
    expect(savedContext).toMatchObject({
      version: 1,
      periodEndedAt: "2026-07-18T12:00:00.000Z",
      questsCompleted: 1,
      checkInsRecorded: 1,
      sourceCount: 2,
    });
    expect(savedContext?.sources.map((item) => item.title)).toEqual(
      expect.arrayContaining([quest.title, `Check-in for ${goal.title}`]),
    );

    deleteGoalRecordsDraft(draft, goal.id);
    expect(draft.reviews[0].context).toEqual(savedContext);
    expect(() => parseImportedState(draft)).not.toThrow();
  });

  it("keeps a monthly action anchored after February clamps its due date", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals[0];
    goal.quests = [{
      id: "monthly-close",
      kind: "task",
      linkedGoalIds: [],
      title: "Month-end close",
      dueDate: "2028-01-31",
      repeat: "monthly",
      monthlyAnchorDay: 31,
      completed: false,
      metricDeltas: [],
    }];
    const dates = [
      "2028-01-31T12:00:00.000Z",
      "2028-01-31T12:00:00.000Z",
      "2028-02-29T12:00:00.000Z",
      "2028-02-29T12:00:00.000Z",
    ];
    const commandRuntime: ProviderCommandRuntime = {
      now: () => dates.shift()!,
      id: (prefix) => `${prefix}-${dates.length}`,
    };

    completeQuestDraft(draft, goal.id, "monthly-close", {}, commandRuntime);
    expect(goal.quests[0]).toMatchObject({
      dueDate: "2028-02-29",
      monthlyAnchorDay: 31,
    });
    completeQuestDraft(draft, goal.id, "monthly-close", {}, commandRuntime);
    expect(goal.quests[0]).toMatchObject({
      dueDate: "2028-03-31",
      monthlyAnchorDay: 31,
    });
  });

  it("records the actual clamped metric movement and its causal completion", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals.find((item) => item.metrics.length && item.quests.length)!;
    const metric = goal.metrics[0];
    const quest = goal.quests[0];
    metric.current = 5;
    delete metric.period;
    delete metric.periodKey;

    completeQuestDraft(draft, goal.id, quest.id, {
      metricDeltas: [{ metricId: metric.id, amount: -10 }],
    }, runtime());

    expect(goal.metrics[0].current).toBe(0);
    expect(draft.questCompletions[0].metricDeltas).toEqual([{ metricId: metric.id, amount: -5 }]);
    expect(draft.questCompletions[0].goalSnapshots?.[0]).toEqual({
      goalId: goal.id,
      areaId: goal.areaId,
      statIds: goal.statIds,
    });
    expect(draft.metricEntries[0]).toMatchObject({
      previousValue: 5,
      value: 0,
      sourceCompletionId: draft.questCompletions[0].id,
      attribution: { areaId: goal.areaId, statIds: goal.statIds },
    });
  });

  it("rolls a stale consistency period before applying the requested delta", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals.find((item) => item.model === "consistency")!;
    const metric = goal.metrics[0];
    const quest = goal.quests[0];
    metric.current = 5;
    metric.period = "month";
    metric.periodKey = "month:2020-01";

    completeQuestDraft(draft, goal.id, quest.id, {
      metricDeltas: [{ metricId: metric.id, amount: 2 }],
    }, runtime());

    expect(draft.questCompletions[0].metricDeltas).toEqual([{ metricId: metric.id, amount: 2 }]);
    expect(draft.metricEntries[0]).toMatchObject({ previousValue: 0, value: 2 });
  });

  it("removes a deleted goal from retained quest and completion links", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const sourceGoal = draft.goals.find((item) => item.model === "consistency")!;
    const deletedGoal = draft.goals.find((item) => item.id !== sourceGoal.id)!;
    const retainedGoal = draft.goals.find(
      (item) => item.id !== sourceGoal.id && item.id !== deletedGoal.id,
    )!;
    const quest = sourceGoal.quests[0];
    quest.linkedGoalIds = [deletedGoal.id, retainedGoal.id];

    completeQuestDraft(draft, sourceGoal.id, quest.id, {}, runtime());
    expect(draft.questCompletions[0].linkedGoalIds).toEqual([
      deletedGoal.id,
      retainedGoal.id,
    ]);

    deleteGoalRecordsDraft(draft, deletedGoal.id);

    expect(draft.goals.some((goal) => goal.id === deletedGoal.id)).toBe(false);
    expect(quest.linkedGoalIds).toEqual([retainedGoal.id]);
    expect(draft.questCompletions).toHaveLength(1);
    expect(draft.questCompletions[0].goalId).toBe(sourceGoal.id);
    expect(draft.questCompletions[0].linkedGoalIds).toEqual([retainedGoal.id]);
    expect(() => parseImportedState(draft)).not.toThrow();
  });

  it("normalizes terminology atomically and rejects empty labels", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    const normalized = normalizeSettingsPatch({
      terminology: {
        ...draft.settings.terminology,
        goals: "  Outcomes  ",
      },
    });
    updateSettingsDraft(draft, normalized.safeSettings, normalized.clearBirthDate);
    expect(draft.settings.terminology.goals).toBe("Outcomes");

    expect(() => normalizeSettingsPatch({
      terminology: { ...draft.settings.terminology, goals: "   " },
    })).toThrow(/non-empty/i);
  });

  it("rejects invalid evidence before mutating goal state or timeline", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const goal = draft.goals[0];
    const beforeTimeline = draft.timeline.length;
    const overLimit = Array.from({ length: 101 }, (_, index) => ({
      id: `legacy-${index}`,
      type: "note" as const,
      text: "Proof",
    }));

    expect(() => setGoalFileEvidenceDraft(draft, goal.id, overLimit)).toThrow(/at most 100/i);
    expect(goal.evidence).toEqual([]);
    expect(() => updateGoalDraft(draft, goal.id, {
      evidence: [{ id: "same", type: "note", text: "One" }, { id: "same", type: "note", text: "Two" }],
    }, runtime())).toThrow(/unique/i);
    expect(goal.evidence).toEqual([]);
    expect(draft.timeline).toHaveLength(beforeTimeline);
  });

  it("rejects measured goals without a positively weighted metric before adding or editing", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    const [weightedGoal, consistencyGoal] = createStarterGoals();
    const invalidNumeric = {
      ...weightedGoal,
      id: "goal-invalid-numeric",
      model: "numeric" as const,
      metrics: [],
    };

    expect(() => addGoalDraft(draft, invalidNumeric, runtime())).toThrow(
      /needs at least one metric/i,
    );
    expect(draft.goals).toEqual([]);
    expect(draft.timeline).toEqual([]);

    draft.goals = [weightedGoal, consistencyGoal];
    const originalTimeline = draft.timeline.length;
    expect(() => updateGoalDraft(draft, weightedGoal.id, {
      model: "numeric",
      metrics: [],
    }, runtime())).toThrow(/needs at least one metric/i);
    expect(weightedGoal.model).toBe("weighted");
    expect(weightedGoal.metrics).toEqual([]);
    expect(draft.timeline).toHaveLength(originalTimeline);

    expect(() => updateGoalDraft(draft, consistencyGoal.id, {
      metrics: consistencyGoal.metrics.map((metric) => ({ ...metric, weight: 0 })),
    }, runtime())).toThrow(/positive relative weight/i);
    expect(consistencyGoal.metrics[0].weight).toBe(100);
    expect(draft.timeline).toHaveLength(originalTimeline);
  });

  it("rejects consistency edits without complete period metadata atomically", () => {
    const draft = cloneWorkspaceValue(EMPTY_STATE);
    draft.goals = createStarterGoals();
    const numericGoal = draft.goals.find((goal) => goal.model === "numeric")!;
    const metricsWithoutPeriods = numericGoal.metrics.map((metric) => ({ ...metric }));
    const before = cloneWorkspaceValue(numericGoal);

    expect(() => updateGoalDraft(draft, numericGoal.id, {
      model: "consistency",
      metrics: metricsWithoutPeriods,
    }, runtime())).toThrow(/valid period and matching period key/i);

    expect(numericGoal).toEqual(before);
    expect(draft.timeline).toEqual([]);
  });
});
