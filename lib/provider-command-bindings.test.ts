import { describe, expect, it } from "vitest";
import { createStarterGoals, EMPTY_STATE } from "@/lib/defaults";
import {
  createProviderDomainActions,
  type WorkspaceMutationPort,
} from "@/lib/provider-command-bindings";
import { cloneWorkspaceValue } from "@/lib/provider-state";
import type { AppState, Goal } from "@/lib/types";

function commandHarness(initialState: AppState = EMPTY_STATE) {
  let state = cloneWorkspaceValue(initialState);
  let transactionCount = 0;
  const port: WorkspaceMutationPort = {
    mutate(recipe) {
      transactionCount += 1;
      const draft = cloneWorkspaceValue(state);
      recipe(draft);
      state = draft;
    },
  };
  const actions = createProviderDomainActions(port, {
    now: () => "2026-07-28T10:00:00.000Z",
    id: (prefix) => `${prefix}-stable`,
  });
  return {
    actions,
    get state() {
      return state;
    },
    get transactionCount() {
      return transactionCount;
    },
  };
}

describe("provider command bindings", () => {
  it("commits a domain command and its timeline record in one logical transaction", () => {
    const harness = commandHarness();
    const goal = createStarterGoals()[0];

    harness.actions.addGoal(goal);

    expect(harness.transactionCount).toBe(1);
    expect(harness.state.goals).toHaveLength(1);
    expect(harness.state.timeline).toHaveLength(1);
    expect(harness.state.timeline[0]).toMatchObject({
      type: "goal",
      goalId: goal.id,
      title: expect.stringContaining(goal.title),
    });
  });

  it("rejects invalid manual metric values before opening a transaction", () => {
    const initialState = cloneWorkspaceValue(EMPTY_STATE);
    initialState.goals = createStarterGoals();
    const harness = commandHarness(initialState);
    const goal = harness.state.goals.find((item) => item.metrics.length)!;
    const metric = goal.metrics[0];

    harness.actions.updateMetric(goal.id, metric.id, Number.NaN);
    harness.actions.updateMetric(goal.id, metric.id, Number.POSITIVE_INFINITY);
    harness.actions.updateMetric(goal.id, metric.id, -1);
    harness.actions.updateMetric(goal.id, metric.id, Number.MAX_SAFE_INTEGER + 1);

    expect(harness.transactionCount).toBe(0);
    expect(harness.state.goals.find((item) => item.id === goal.id)?.metrics[0].current)
      .toBe(metric.current);
    expect(harness.state.metricEntries).toEqual([]);
  });

  it("does not retain caller-owned mutable goal or patch inputs", () => {
    const harness = commandHarness();
    const goal = createStarterGoals()[0];

    harness.actions.addGoal(goal);
    goal.title = "Changed outside the provider";
    goal.statIds.push("caller-stat");
    goal.milestones[0].title = "Changed caller milestone";

    const patch: Partial<Goal> = {
      description: "Saved description",
      statIds: ["saved-stat"],
      evidence: [{ id: "note-1", type: "note", text: "Saved evidence" }],
    };
    harness.actions.updateGoal(goal.id, patch);
    patch.statIds!.push("caller-stat-2");
    patch.evidence![0] = { id: "note-2", type: "note", text: "Changed evidence" };

    const saved = harness.state.goals[0];
    expect(saved.title).not.toBe("Changed outside the provider");
    expect(saved.milestones[0].title).not.toBe("Changed caller milestone");
    expect(saved.statIds).toEqual(["saved-stat"]);
    expect(saved.evidence).toEqual([
      { id: "note-1", type: "note", text: "Saved evidence" },
    ]);
  });
});
