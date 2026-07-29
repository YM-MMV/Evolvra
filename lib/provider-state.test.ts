import { describe, expect, it, vi } from "vitest";
import { createStarterGoals, EMPTY_STATE } from "@/lib/defaults";
import {
  completeQuestDraft,
  deleteGoalRecordsDraft,
  reorderAreasDraft,
} from "@/lib/provider-domain-commands";
import {
  adoptAuthoritativeWorkspaceState,
  runNonUndoableWorkspaceMutation,
  runUndoableWorkspaceMutation,
  trimWorkspaceHistory,
  workspaceStatesEqual,
} from "@/lib/provider-state";
import {
  MAX_WORKSPACE_NESTING_DEPTH,
  MAX_WORKSPACE_NODES,
  MAX_WORKSPACE_SERIALIZED_BYTES,
  MAX_WORKSPACE_STRING_BYTES,
  parseImportedState,
} from "@/lib/state-schema";
import { profileJsonValue } from "@/lib/workspace-json-profile";

const FIXED_NOW = "2026-07-18T12:00:00.000Z";

function nearLimitWorkspace(eventCount = 1_010) {
  const state = structuredClone(EMPTY_STATE);
  state.updatedAt = FIXED_NOW;
  state.profile.createdAt = FIXED_NOW;
  state.timeline = Array.from({ length: eventCount }, (_, index) => ({
    id: `near-limit-event-${String(index).padStart(4, "0")}`,
    type: "note" as const,
    title: "Near-limit profile fixture",
    detail: "x".repeat(5_000),
    at: FIXED_NOW,
  }));
  return parseImportedState(state, FIXED_NOW);
}

describe("provider workspace transitions", () => {
  it("profiles JSON bytes exactly across escaping and Unicode", () => {
    const value = {
      text: "Line one\n\"quoted\" · café · 🚀",
      values: [true, false, null, -0, 1.25],
    };
    const serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;

    expect(profileJsonValue(value).bytes).toBe(serializedBytes);
  });

  it("creates one immutable undo snapshot for one logical command", () => {
    const current = structuredClone(EMPTY_STATE);
    const priorHistory = Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(EMPTY_STATE),
      updatedAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    const result = runUndoableWorkspaceMutation(current, priorHistory, (draft) => {
      draft.profile.displayName = "Changed once";
      draft.profile.chapter = "One command";
    }, "2026-07-18T12:00:00.000Z");

    expect(result.history).toHaveLength(10);
    expect(result.history.at(-1)).toEqual(current);
    expect(result.history.at(-1)).toBe(current);
    expect(result.state.profile).toMatchObject({
      displayName: "Changed once",
      chapter: "One command",
    });
    expect(result.state.updatedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(current.profile.displayName).toBe(EMPTY_STATE.profile.displayName);
  });

  it("retains the established timestamped-command semantics for an empty recipe", () => {
    const current = structuredClone(EMPTY_STATE);
    const result = runUndoableWorkspaceMutation(
      current,
      [],
      () => {},
      "2026-07-18T12:00:01.000Z",
    );

    expect(result.state).not.toBe(current);
    expect(result.state.updatedAt).toBe("2026-07-18T12:00:01.000Z");
    expect(result.history).toEqual([current]);
  });

  it("rejects an invalid transition before changing current state or history", () => {
    const current = structuredClone(EMPTY_STATE);
    const history = [structuredClone(EMPTY_STATE)];

    expect(() => runUndoableWorkspaceMutation(current, history, (draft) => {
      draft.settings.terminology.goals = "";
    })).toThrow();
    expect(current.settings.terminology.goals).toBe("Goals");
    expect(history).toHaveLength(1);
    expect(history[0].settings.terminology.goals).toBe("Goals");
  });

  it("clears undo history for file-backed destructive transitions", () => {
    const result = runNonUndoableWorkspaceMutation(
      structuredClone(EMPTY_STATE),
      (draft) => { draft.profile.displayName = "Current only"; },
      "2026-07-18T12:00:00.000Z",
    );

    expect(result.history).toEqual([]);
    expect(result.state.profile.displayName).toBe("Current only");
  });

  it("starts a new undo boundary when a cloud snapshot becomes authoritative", () => {
    const cloudState = structuredClone(EMPTY_STATE);
    cloudState.profile.displayName = "Cloud authority";
    const preCloudHistory = [structuredClone(EMPTY_STATE)];
    preCloudHistory[0].profile.displayName = "Device snapshot that must not return";

    const result = adoptAuthoritativeWorkspaceState(cloudState);

    expect(result.history).toEqual([]);
    expect(result.state).toEqual(cloudState);
    expect(result.state).not.toBe(cloudState);
    expect(preCloudHistory[0].profile.displayName).toBe("Device snapshot that must not return");
  });

  it("compares object keys semantically while preserving array order", () => {
    const reordered = Object.fromEntries(Object.entries(EMPTY_STATE).reverse());
    expect(workspaceStatesEqual(
      EMPTY_STATE,
      reordered as unknown as typeof EMPTY_STATE,
    )).toBe(true);
    expect(workspaceStatesEqual(
      EMPTY_STATE,
      { ...EMPTY_STATE, areas: [...EMPTY_STATE.areas].reverse() },
    )).toBe(false);
  });

  it("retains newest undo snapshots within an explicit byte budget", () => {
    const snapshots = ["old", "middle", "new"].map((displayName, index) => ({
      ...structuredClone(EMPTY_STATE),
      updatedAt: `2026-07-18T00:00:0${index}.000Z`,
      profile: { ...structuredClone(EMPTY_STATE.profile), displayName },
    }));
    const newestBytes = new TextEncoder().encode(JSON.stringify(snapshots[2])).byteLength;

    expect(trimWorkspaceHistory(snapshots, 10, newestBytes)).toEqual([snapshots[2]]);
    expect(trimWorkspaceHistory(snapshots, 10, newestBytes - 1)).toEqual([]);
  });

  it("honours zero and exact item boundaries without slice(-0) retaining everything", () => {
    const snapshots = Array.from({ length: 3 }, (_, index) => ({
      ...structuredClone(EMPTY_STATE),
      updatedAt: `2026-07-18T00:00:0${index}.000Z`,
    }));

    expect(trimWorkspaceHistory(snapshots, 0)).toEqual([]);
    expect(trimWorkspaceHistory(snapshots, 1)).toEqual([snapshots[2]]);
    expect(trimWorkspaceHistory(snapshots, 2)).toEqual(snapshots.slice(-2));
    expect(trimWorkspaceHistory(snapshots, -1)).toEqual([]);
    expect(trimWorkspaceHistory(snapshots, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("copy-on-write isolates nested changes and shares every untouched branch", () => {
    const current = parseImportedState({
      ...structuredClone(EMPTY_STATE),
      goals: createStarterGoals(),
    }, FIXED_NOW);
    const targetGoal = current.goals.find((goal) => goal.metrics.length > 0)!;
    const targetIndex = current.goals.indexOf(targetGoal);
    const untouchedGoal = current.goals.find((goal) => goal.id !== targetGoal.id)!;
    const originalMetric = targetGoal.metrics[0];
    const external = {
      id: "area-external",
      name: "External input",
      color: "#123456",
      icon: "Circle",
      order: current.areas.length,
    };

    const result = runUndoableWorkspaceMutation(current, [], (draft) => {
      draft.goals[targetIndex].metrics[0].current += 1;
      draft.areas.push(external);
    }, "2026-07-18T12:01:00.000Z");
    external.name = "Mutated after the command";

    expect(result.state).not.toBe(current);
    expect(result.state.goals).not.toBe(current.goals);
    expect(result.state.goals[targetIndex]).not.toBe(targetGoal);
    expect(result.state.goals[targetIndex].metrics).not.toBe(targetGoal.metrics);
    expect(result.state.goals[targetIndex].metrics[0]).not.toBe(originalMetric);
    expect(result.state.goals.find((goal) => goal.id === untouchedGoal.id)).toBe(untouchedGoal);
    expect(result.state.goals[targetIndex].milestones).toBe(targetGoal.milestones);
    expect(result.state.timeline).toBe(current.timeline);
    expect(result.state.settings).toBe(current.settings);
    expect(result.state.areas.at(-1)?.name).toBe("External input");
    expect(current.goals[targetIndex].metrics[0].current).toBe(originalMetric.current);
    expect(current.areas).toHaveLength(EMPTY_STATE.areas.length);
    expect(result.history).toEqual([current]);
    expect(result.history[0]).toBe(current);
  });

  it("supports multi-domain command writes and in-place array ordering safely", () => {
    const current = parseImportedState({
      ...structuredClone(EMPTY_STATE),
      goals: createStarterGoals(),
    }, FIXED_NOW);
    const goal = current.goals.find((item) => item.model === "consistency")!;
    const quest = goal.quests[0];
    let idSequence = 0;

    const completed = runUndoableWorkspaceMutation(current, [], (draft) => {
      completeQuestDraft(draft, goal.id, quest.id, {
        note: "A real session",
      }, {
        now: () => FIXED_NOW,
        id: (prefix) => `${prefix}-${++idSequence}`,
      });
    }, "2026-07-18T12:01:00.000Z");

    expect(completed.state.questCompletions).toHaveLength(1);
    expect(completed.state.metricEntries).toHaveLength(1);
    expect(completed.state.timeline).toHaveLength(1);
    expect(current.questCompletions).toEqual([]);
    expect(current.metricEntries).toEqual([]);
    expect(current.timeline).toEqual([]);
    expect(completed.state.goals.find((item) => item.id !== goal.id)).toBe(
      current.goals.find((item) => item.id !== goal.id),
    );

    const deleted = runNonUndoableWorkspaceMutation(
      completed.state,
      (draft) => deleteGoalRecordsDraft(draft, goal.id),
      "2026-07-18T12:01:30.000Z",
    );
    expect(deleted.state.goals.some((item) => item.id === goal.id)).toBe(false);
    expect(deleted.state.questCompletions).toEqual([]);
    expect(deleted.state.metricEntries).toEqual([]);
    expect(deleted.state.timeline).toEqual([]);
    expect(completed.state.goals.some((item) => item.id === goal.id)).toBe(true);

    const reversedIds = [...current.areas].reverse().map((area) => area.id);
    const reordered = runUndoableWorkspaceMutation(current, [], (draft) => {
      reorderAreasDraft(draft, reversedIds);
    }, "2026-07-18T12:02:00.000Z");

    expect(reordered.state.areas.map((area) => area.id)).toEqual(reversedIds);
    expect(current.areas.map((area) => area.id)).not.toEqual(reversedIds);
    expect(reordered.state.areas.map((area) => area.order)).toEqual(
      reversedIds.map((_, index) => index),
    );
    expect(current.areas[0].order).toBe(0);
  });

  it("rejects referential and resource-invalid commands before exposing any state", () => {
    const current = parseImportedState({
      ...structuredClone(EMPTY_STATE),
      goals: createStarterGoals(),
    }, FIXED_NOW);
    const history = [current];

    expect(() => runUndoableWorkspaceMutation(current, history, (draft) => {
      draft.goals[0].areaId = "missing-area";
    }, "2026-07-18T12:01:00.000Z")).toThrow(/references missing area/i);
    expect(current.goals[0].areaId).not.toBe("missing-area");
    expect(history).toEqual([current]);

    const nearLimit = nearLimitWorkspace();
    expect(profileJsonValue(nearLimit).bytes).toBeLessThan(MAX_WORKSPACE_SERIALIZED_BYTES);
    expect(() => runUndoableWorkspaceMutation(nearLimit, [], (draft) => {
      draft.timeline.unshift(...Array.from({ length: 100 }, (_, index) => ({
        id: `overflow-event-${index}`,
        type: "note" as const,
        title: "Overflow",
        detail: "y".repeat(5_000),
        at: FIXED_NOW,
      })));
    }, "2026-07-18T12:01:00.000Z")).toThrow(/larger than the 5 MB safety limit/i);
    expect(nearLimit.timeline).toHaveLength(1_010);
  });

  it("rejects a changed goal whose action still references a removed metric", () => {
    const goals = createStarterGoals();
    const seededGoal = goals.find((goal) =>
      goal.quests.some((quest) => quest.metricDeltas.length > 0))!;
    seededGoal.metrics.push({
      ...seededGoal.metrics[0],
      id: "40000000-0000-4000-8000-000000000099",
      label: "Unreferenced fallback metric",
    });
    const current = parseImportedState({
      ...structuredClone(EMPTY_STATE),
      goals,
    }, FIXED_NOW);
    const goalIndex = current.goals.findIndex((goal) =>
      goal.quests.some((quest) => quest.metricDeltas.length > 0));
    const goal = current.goals[goalIndex];
    const referencedMetricId = goal.quests
      .flatMap((quest) => quest.metricDeltas)
      .at(0)!.metricId;

    expect(() => runUndoableWorkspaceMutation(current, [], (draft) => {
      draft.goals[goalIndex].metrics = draft.goals[goalIndex].metrics
        .filter((metric) => metric.id !== referencedMetricId);
    }, "2026-07-18T12:01:00.000Z")).toThrow(
      new RegExp(`references missing metric "${referencedMetricId}"`, "i"),
    );
    expect(current.goals[goalIndex].metrics.some(
      (metric) => metric.id === referencedMetricId,
    )).toBe(true);
  });

  it("rejects goal removal while action definitions or history still link to it", () => {
    const actionGoals = createStarterGoals();
    const linkedGoalId = actionGoals[1].id;
    actionGoals[0].quests[0].linkedGoalIds = [linkedGoalId];
    const actionState = parseImportedState({
      ...structuredClone(EMPTY_STATE),
      goals: actionGoals,
    }, FIXED_NOW);

    expect(() => runUndoableWorkspaceMutation(actionState, [], (draft) => {
      draft.goals = draft.goals.filter((goal) => goal.id !== linkedGoalId);
    }, "2026-07-18T12:01:00.000Z")).toThrow(
      new RegExp(`references missing linked goal "${linkedGoalId}"`, "i"),
    );
    expect(actionState.goals.some((goal) => goal.id === linkedGoalId)).toBe(true);

    const historyGoals = createStarterGoals();
    const historyLinkedGoalId = historyGoals[1].id;
    const primaryGoal = historyGoals[0];
    const historyState = parseImportedState({
      ...structuredClone(EMPTY_STATE),
      goals: historyGoals,
      questCompletions: [{
        id: "70000000-0000-4000-8000-000000000001",
        goalId: primaryGoal.id,
        linkedGoalIds: [historyLinkedGoalId],
        questId: primaryGoal.quests[0].id,
        title: primaryGoal.quests[0].title,
        completedAt: FIXED_NOW,
        evidence: [],
        metricDeltas: [],
      }],
    }, FIXED_NOW);

    expect(() => runUndoableWorkspaceMutation(historyState, [], (draft) => {
      draft.goals = draft.goals.filter((goal) => goal.id !== historyLinkedGoalId);
    }, "2026-07-18T12:01:00.000Z")).toThrow(
      new RegExp(`references missing linked goal "${historyLinkedGoalId}"`, "i"),
    );
    expect(historyState.goals.some(
      (goal) => goal.id === historyLinkedGoalId,
    )).toBe(true);
  });

  it("incrementally enforces collection, node, depth, and string budgets", () => {
    const current = parseImportedState(structuredClone(EMPTY_STATE), FIXED_NOW);
    const unsafeProfile = (draft: typeof current) =>
      draft.profile as unknown as Record<string, unknown>;

    expect(() => runUndoableWorkspaceMutation(current, [], (draft) => {
      unsafeProfile(draft).unexpected = "z".repeat(MAX_WORKSPACE_STRING_BYTES + 1);
    }, "2026-07-18T12:01:00.000Z")).toThrow(/per-string size limit/i);

    let nested: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_WORKSPACE_NESTING_DEPTH; index += 1) {
      nested = { next: nested };
    }
    expect(() => runUndoableWorkspaceMutation(current, [], (draft) => {
      unsafeProfile(draft).unexpected = nested;
    }, "2026-07-18T12:01:00.000Z")).toThrow(/maximum nesting depth/i);

    expect(() => runUndoableWorkspaceMutation(current, [], (draft) => {
      unsafeProfile(draft).unexpected = Array.from(
        { length: MAX_WORKSPACE_NODES },
        () => null,
      );
    }, "2026-07-18T12:01:00.000Z")).toThrow(/node safety limit/i);

    expect(() => runUndoableWorkspaceMutation(current, [], (draft) => {
      draft.areas.push(...Array.from({ length: 500 }, (_, index) => ({
        id: `over-limit-area-${index}`,
        name: `Area ${index}`,
        color: "#123456",
        icon: "Circle",
        order: current.areas.length + index,
      })));
    }, "2026-07-18T12:01:00.000Z")).toThrow(/more than 500 items/i);

    expect(current.profile).not.toHaveProperty("unexpected");
    expect(current.areas).toHaveLength(EMPTY_STATE.areas.length);
  });

  it("keeps a near-5 MiB routine mutation bounded and avoids whole-state serialization", () => {
    const current = nearLimitWorkspace();
    const coldCurrent = structuredClone(current);
    const currentBytes = profileJsonValue(current).bytes;
    expect(currentBytes).toBeGreaterThan(4.75 * 1024 * 1024);
    expect(currentBytes).toBeLessThan(MAX_WORKSPACE_SERIALIZED_BYTES);
    const stringify = vi.spyOn(JSON, "stringify");
    const coldStartedAt = performance.now();
    const coldResult = runUndoableWorkspaceMutation(coldCurrent, [], (draft) => {
      draft.profile.chapter = "A cold bounded transaction";
    }, "2026-07-18T12:00:30.000Z");
    const coldElapsedMs = performance.now() - coldStartedAt;
    const warmStartedAt = performance.now();

    const result = runUndoableWorkspaceMutation(current, [], (draft) => {
      draft.profile.chapter = "A bounded transaction";
    }, "2026-07-18T12:01:00.000Z");
    const warmElapsedMs = performance.now() - warmStartedAt;

    expect(coldResult.state.timeline).toBe(coldCurrent.timeline);
    expect(result.state.profile.chapter).toBe("A bounded transaction");
    expect(result.state.timeline).toBe(current.timeline);
    expect(result.history).toEqual([current]);
    expect(stringify.mock.calls.some(([value]) => (
      value === current
      || value === current.timeline
      || value === result.state
      || value === result.state.timeline
    ))).toBe(false);
    // Cold accounting may visit a pre-boundary object once. Boundary-primed
    // states must then stay comfortably sub-frame on routine commands.
    expect(coldElapsedMs).toBeLessThan(100);
    expect(warmElapsedMs).toBeLessThan(25);
    stringify.mockRestore();
  });
});
