import { describe, expect, it } from "vitest";
import { selectConsistencySummary } from "@/lib/consistency-summary";
import type { QuestCompletion } from "@/lib/types";

const NOW = new Date("2026-07-27T12:00:00.000Z");

const completion = (
  id: string,
  completedAt: string,
  overrides: Partial<QuestCompletion> = {},
): QuestCompletion => ({
  id,
  goalId: "goal-consistency",
  linkedGoalIds: [],
  questId: `quest-${id}`,
  title: `Session ${id}`,
  completedAt,
  evidence: [],
  metricDeltas: [],
  ...overrides,
});

describe("consistency summary selector", () => {
  it("derives rolling rates, totals, time, and momentum from immutable goal records", () => {
    const records = [
      completion("today", "2026-07-27T10:00:00.000Z", { durationMinutes: 30 }),
      completion("this-week", "2026-07-22T12:00:00.000Z", { durationMinutes: 45 }),
      completion("this-month", "2026-07-10T12:00:00.000Z"),
      completion("previous-one", "2026-06-20T12:00:00.000Z", { durationMinutes: 20 }),
      completion("previous-two", "2026-06-05T12:00:00.000Z", { durationMinutes: 15 }),
      completion("older", "2026-05-01T12:00:00.000Z", { durationMinutes: 60 }),
      completion("shared", "2026-07-25T12:00:00.000Z", {
        goalId: "goal-primary",
        linkedGoalIds: [],
        goalSnapshots: [
          { goalId: "goal-primary", areaId: "area-one", statIds: [] },
          { goalId: "goal-consistency", areaId: "area-two", statIds: [] },
        ],
        durationMinutes: 25,
      }),
      completion("unrelated", "2026-07-26T12:00:00.000Z", { goalId: "goal-other" }),
      completion("future", "2026-07-28T12:00:00.000Z", { durationMinutes: 500 }),
    ];

    expect(selectConsistencySummary(records, "goal-consistency", NOW)).toEqual({
      weeklyRate: 3,
      monthlyRate: 4,
      totalSessions: 7,
      totalRecordedMinutes: 195,
      longTermMomentum: {
        direction: "rising",
        change: 2,
        currentSessions: 4,
        previousSessions: 2,
      },
    });
  });

  it("uses non-overlapping 30-day windows and reports steady, falling, and empty rhythms", () => {
    const boundaryRecords = [
      completion("current-boundary", "2026-06-27T12:00:00.000Z"),
      completion("previous-boundary", "2026-05-28T12:00:00.000Z"),
    ];
    expect(selectConsistencySummary(boundaryRecords, "goal-consistency", NOW).longTermMomentum)
      .toEqual({
        direction: "steady",
        change: 0,
        currentSessions: 1,
        previousSessions: 1,
      });

    const falling = [
      completion("current", "2026-07-20T12:00:00.000Z"),
      completion("previous-one", "2026-06-20T12:00:00.000Z"),
      completion("previous-two", "2026-06-10T12:00:00.000Z"),
    ];
    expect(selectConsistencySummary(falling, "goal-consistency", NOW).longTermMomentum.direction)
      .toBe("falling");
    expect(selectConsistencySummary([], "goal-consistency", NOW).longTermMomentum.direction)
      .toBe("no-data");
  });

  it("prefers immutable goal snapshots over mutable legacy link fields", () => {
    const record = completion("snapshot", "2026-07-26T12:00:00.000Z", {
      goalId: "goal-primary",
      linkedGoalIds: ["goal-consistency"],
      goalSnapshots: [
        { goalId: "goal-primary", areaId: "area-one", statIds: [] },
      ],
    });

    expect(selectConsistencySummary([record], "goal-consistency", NOW).totalSessions).toBe(0);
  });
});
