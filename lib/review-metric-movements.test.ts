import { describe, expect, it } from "vitest";
import { buildReviewMetricMovements } from "@/lib/review-metric-movements";
import type { Goal, MetricEntry } from "@/lib/types";

const goal = {
  id: "goal-one",
  title: "Build endurance",
  metrics: [{ id: "metric-one", label: "Body mass", unit: "lb" }],
} as Goal;

function entry(
  id: string,
  previousValue: number,
  value: number,
  unit: string | undefined,
  recordedAt: string,
): MetricEntry {
  return {
    id,
    goalId: goal.id,
    metricId: "metric-one",
    label: "Body mass",
    ...(unit === undefined ? {} : { unit }),
    previousValue,
    value,
    recordedAt,
    source: "manual",
  };
}

describe("buildReviewMetricMovements", () => {
  it("combines movement when immutable units remain the same", () => {
    const entries = [
      entry("one", 68, 70, "kg", "2026-07-27T09:00:00.000Z"),
      entry("two", 70, 72, "kg", "2026-07-28T09:00:00.000Z"),
    ];

    expect(buildReviewMetricMovements(entries, entries, [goal], { from: "2026-07-27", to: "2026-07-29" }))
      .toMatchObject([{
        unit: "kg",
        from: 68,
        to: 72,
        updates: 2,
        startsAfterUnitChange: false,
      }]);
  });

  it("never relabels an earlier value when the recorded unit changes", () => {
    const entries = [
      entry("kg", 70, 72, "kg", "2026-07-27T09:00:00.000Z"),
      entry("lb", 72, 160, "lb", "2026-07-28T09:00:00.000Z"),
    ];

    const movements = buildReviewMetricMovements(entries, entries, [goal], {
      from: "2026-07-27",
      to: "2026-07-29",
    });

    expect(movements).toHaveLength(2);
    expect(movements).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: "kg", from: 70, to: 72 }),
      expect.objectContaining({
        unit: "lb",
        to: 160,
        startsAfterUnitChange: true,
      }),
    ]));
    expect(movements.find((movement) => movement.unit === "lb")?.from).toBeUndefined();
  });

  it("shows only within-unit movement after a unit boundary", () => {
    const entries = [
      entry("kg", 70, 72, "kg", "2026-07-26T09:00:00.000Z"),
      entry("lb-one", 72, 160, "lb", "2026-07-27T09:00:00.000Z"),
      entry("lb-two", 160, 162, "lb", "2026-07-28T09:00:00.000Z"),
    ];

    const movements = buildReviewMetricMovements(entries.slice(1), entries, [goal], {
      from: "2026-07-27",
      to: "2026-07-29",
    });

    expect(movements).toMatchObject([{
      unit: "lb",
      from: 160,
      to: 162,
      updates: 2,
      startsAfterUnitChange: true,
    }]);
  });

  it("does not borrow the current metric unit for a historical entry without one", () => {
    const entries = [entry("legacy", 4, 5, undefined, "2026-07-27T09:00:00.000Z")];

    expect(buildReviewMetricMovements(entries, entries, [goal], { from: "2026-07-27", to: "2026-07-29" }))
      .toMatchObject([{ unit: "", from: 4, to: 5 }]);
  });
});
