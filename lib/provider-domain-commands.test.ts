import { describe, expect, it } from "vitest";
import { createStarterGoals, EMPTY_STATE } from "@/lib/defaults";
import {
  addQuestDraft,
  completeQuestDraft,
  deleteGoalRecordsDraft,
  normalizeSettingsPatch,
  setGoalFileEvidenceDraft,
  toggleMilestoneDraft,
  updateGoalDraft,
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
});
