import { describe, expect, it } from "vitest";
import {
  goalProgressConfigurationIssue,
  metricsForGoalModel,
} from "@/lib/goal-progress";
import type { ProgressMetric } from "@/lib/types";

const metric = (overrides: Partial<ProgressMetric> = {}): ProgressMetric => ({
  id: "metric-1",
  label: "Sessions",
  current: 4,
  target: 12,
  unit: "sessions",
  weight: 100,
  ...overrides,
});

describe("goal progress model transitions", () => {
  it("uses configured terminology in user-facing validation", () => {
    expect(goalProgressConfigurationIssue({
      model: "numeric",
      metrics: [],
    }, "mission")).toBe("A numeric or consistency mission needs at least one metric.");
  });

  it("recomputes a new consistency period when the boundary passes before save", () => {
    const beforeBoundary = metricsForGoalModel(
      [metric()],
      "consistency",
      new Date(2026, 6, 31, 23, 59, 59),
    );
    const afterBoundary = metricsForGoalModel(
      beforeBoundary,
      "consistency",
      new Date(2026, 7, 1, 0, 0, 1),
    );

    expect(beforeBoundary[0]).toMatchObject({
      current: 4,
      period: "month",
      periodKey: "month:2026-07",
    });
    expect(afterBoundary[0]).toMatchObject({
      current: 0,
      period: "month",
      periodKey: "month:2026-08",
    });
  });

  it("removes calendar metadata when returning to all-time numeric progress", () => {
    const [numeric] = metricsForGoalModel([
      metric({ period: "week", periodKey: "week:2026-W31" }),
    ], "numeric");

    expect(numeric).toEqual(metric());
  });
});
