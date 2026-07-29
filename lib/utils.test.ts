import { describe, expect, it } from "vitest";
import { createStarterGoals } from "@/lib/defaults";
import {
  activePeriodKey,
  escapeCsv,
  formatDate,
  goalProgress,
  isFiniteWorkspaceNumber,
  isPeriodKey,
  isQuestAvailable,
  isQuestDue,
  localDateKey,
  nextRepeatDate,
  parseLocalDate,
  rollMetricPeriod,
  shortDate,
  singularizeTerm,
  uid,
} from "@/lib/utils";
import type { Goal } from "@/lib/types";

const baseGoal: Goal = {
  id: "goal",
  title: "Goal",
  description: "",
  areaId: "area",
  model: "numeric",
  priority: "medium",
  status: "active",
  createdAt: new Date().toISOString(),
  metrics: [],
  milestones: [],
  quests: [],
  statIds: [],
  checkIns: [],
  evidence: [],
  notes: "",
};

describe("goal progress", () => {
  it("calculates weighted numeric progress", () => {
    const goal: Goal = {
      ...baseGoal,
      metrics: [
        { id: "a", label: "A", current: 50, target: 100, unit: "", weight: 70 },
        { id: "b", label: "B", current: 20, target: 20, unit: "", weight: 30 },
      ],
    };
    expect(goalProgress(goal)).toBe(65);
  });

  it("does not replace measured progress when a goal is marked complete", () => {
    expect(
      goalProgress({
        ...baseGoal,
        status: "completed",
        metrics: [{ id: "a", label: "A", current: 2, target: 10, unit: "", weight: 100 }],
      }),
    ).toBe(20);
  });

  it("does not invent a percentage for an open goal", () => {
    expect(goalProgress({ ...baseGoal, model: "open", status: "completed" })).toBeNull();
  });

  it("treats consistency progress from an old calendar window as zero without mutating it", () => {
    const metric = {
      id: "sessions",
      label: "Sessions",
      current: 9,
      target: 12,
      unit: "sessions",
      weight: 100,
      period: "month" as const,
      periodKey: "month:2026-06",
    };
    const goal: Goal = { ...baseGoal, model: "consistency", metrics: [metric] };

    expect(goalProgress(goal, new Date(2026, 6, 1))).toBe(0);
    expect(metric).toMatchObject({ current: 9, periodKey: "month:2026-06" });
    expect(goalProgress(goal, new Date(2026, 5, 30))).toBe(75);
  });

  it("combines multiple consistency metrics by their configured weights", () => {
    const today = new Date(2026, 6, 18);
    const goal: Goal = {
      ...baseGoal,
      model: "consistency",
      metrics: [
        { id: "sessions", label: "Sessions", current: 5, target: 10, unit: "sessions", weight: 60, period: "month", periodKey: "month:2026-07" },
        { id: "minutes", label: "Minutes", current: 100, target: 100, unit: "minutes", weight: 40, period: "month", periodKey: "month:2026-07" },
      ],
    };
    expect(goalProgress(goal, today)).toBe(70);
  });
});

describe("consistency calendar windows", () => {
  it("uses Monday as the start of each local week", () => {
    expect(activePeriodKey("week", new Date(2026, 6, 19))).toBe("week:2026-07-13");
    expect(activePeriodKey("week", new Date(2026, 6, 20))).toBe("week:2026-07-20");
    expect(isPeriodKey("week", "week:2026-07-13")).toBe(true);
    expect(isPeriodKey("week", "week:2026-07-19")).toBe(false);
  });

  it("changes month and year keys exactly at their local boundaries", () => {
    expect(activePeriodKey("month", new Date(2026, 11, 31, 23, 59))).toBe("month:2026-12");
    expect(activePeriodKey("year", new Date(2026, 11, 31, 23, 59))).toBe("year:2026");
    expect(activePeriodKey("month", new Date(2027, 0, 1))).toBe("month:2027-01");
    expect(activePeriodKey("year", new Date(2027, 0, 1))).toBe("year:2027");
  });

  it("changes quarter keys at April, July, October, and January", () => {
    expect(activePeriodKey("quarter", new Date(2026, 2, 31))).toBe("quarter:2026-Q1");
    expect(activePeriodKey("quarter", new Date(2026, 3, 1))).toBe("quarter:2026-Q2");
    expect(activePeriodKey("quarter", new Date(2026, 6, 1))).toBe("quarter:2026-Q3");
    expect(activePeriodKey("quarter", new Date(2026, 9, 1))).toBe("quarter:2026-Q4");
    expect(activePeriodKey("quarter", new Date(2027, 0, 1))).toBe("quarter:2027-Q1");
  });

  it("keeps local calendar keys stable across UK daylight-saving transition dates", () => {
    // The UK clock changes on these Sundays. Domain dates must still advance by
    // calendar day and switch week only on Monday, never by elapsed 24h blocks.
    expect(localDateKey(new Date(2026, 2, 29, 23, 30))).toBe("2026-03-29");
    expect(activePeriodKey("week", new Date(2026, 2, 29, 23, 30))).toBe("week:2026-03-23");
    expect(activePeriodKey("week", new Date(2026, 2, 30, 0, 30))).toBe("week:2026-03-30");
    expect(nextRepeatDate("daily", "2026-03-29", new Date(2026, 2, 28))).toBe("2026-03-30");

    expect(localDateKey(new Date(2026, 9, 25, 23, 30))).toBe("2026-10-25");
    expect(activePeriodKey("week", new Date(2026, 9, 25, 23, 30))).toBe("week:2026-10-19");
    expect(activePeriodKey("week", new Date(2026, 9, 26, 0, 30))).toBe("week:2026-10-26");
  });

  it("returns an immutable reset for stale metrics and preserves current metrics", () => {
    const stale = {
      id: "sessions",
      label: "Sessions",
      current: 9,
      target: 12,
      unit: "sessions",
      weight: 100,
      period: "month" as const,
      periodKey: "month:2026-06",
    };
    const reset = rollMetricPeriod(stale, new Date(2026, 6, 1));
    expect(reset).toMatchObject({ current: 0, periodKey: "month:2026-07" });
    expect(reset).not.toBe(stale);
    expect(stale).toMatchObject({ current: 9, periodKey: "month:2026-06" });

    const current = { ...stale, periodKey: "month:2026-07" };
    expect(rollMetricPeriod(current, new Date(2026, 6, 31))).toEqual(current);
  });

  it("configures the starter fitness metric as a current monthly window", () => {
    const fitness = createStarterGoals().find((goal) => goal.title === "Build dependable cardiovascular fitness");
    expect(fitness?.metrics[0]).toMatchObject({
      period: "month",
      periodKey: activePeriodKey("month"),
    });
  });
});

describe("calendar dates", () => {
  it("parses calendar-only values in local time", () => {
    const parsed = parseLocalDate("2026-07-18");
    expect(parsed && [parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual([2026, 6, 18]);
    expect(formatDate("2026-07-18")).toContain("18 Jul 2026");
    expect(shortDate("2026-07-18")).toBe("18 Jul");
  });

  it("rejects impossible dates instead of silently rolling them over", () => {
    expect(parseLocalDate("2026-02-30")).toBeNull();
    expect(parseLocalDate("2026-13-01")).toBeNull();
    expect(formatDate("not-a-date")).toBe("No date");
  });

  it("clamps monthly repeats to the final day of shorter months", () => {
    expect(nextRepeatDate("monthly", "2026-01-31", new Date(2026, 0, 30))).toBe("2026-02-28");
    expect(nextRepeatDate("monthly", "2028-01-31", new Date(2028, 0, 30))).toBe("2028-02-29");
  });

  it("moves daily and weekly repeats safely across year boundaries", () => {
    expect(nextRepeatDate("daily", "2026-12-31", new Date(2026, 11, 30))).toBe("2027-01-01");
    expect(nextRepeatDate("weekly", "2026-12-28", new Date(2026, 11, 27))).toBe("2027-01-04");
  });

  it("schedules an overdue repeat from the completion day, not a missed occurrence", () => {
    expect(nextRepeatDate("daily", "2026-07-01", new Date(2026, 6, 18))).toBe("2026-07-19");
    expect(nextRepeatDate("weekly", "2026-07-01", new Date(2026, 6, 18))).toBe("2026-07-25");
    expect(nextRepeatDate("monthly", "2026-01-31", new Date(2026, 2, 31))).toBe("2026-04-30");
  });

  it("keeps the recurrence cadence anchored to a future due date", () => {
    const today = new Date(2026, 6, 18);
    expect(nextRepeatDate("daily", "2026-07-22", today)).toBe("2026-07-23");
    expect(nextRepeatDate("weekly", "2026-07-22", today)).toBe("2026-07-29");
    expect(nextRepeatDate("monthly", "2026-07-31", today)).toBe("2026-08-31");
  });

  it("keeps future actions unavailable and completed one-off actions closed", () => {
    const today = new Date(2026, 6, 18);
    expect(isQuestAvailable({ completed: false, repeat: "daily", dueDate: "2026-07-19" }, today)).toBe(false);
    expect(isQuestAvailable({ completed: false, repeat: "daily", dueDate: "2026-07-18" }, today)).toBe(true);
    expect(isQuestAvailable({ completed: true, repeat: "weekly", dueDate: "2026-07-18" }, today)).toBe(true);
    expect(isQuestAvailable({ completed: true, repeat: "none" }, today)).toBe(false);
  });

  it("keeps undated actions available without labelling them as due today", () => {
    const today = new Date(2026, 6, 18);
    expect(isQuestAvailable({ completed: false, repeat: "none" }, today)).toBe(true);
    expect(isQuestDue({ completed: false, repeat: "none" }, today)).toBe(false);
    expect(isQuestDue({ completed: false, repeat: "none", dueDate: "2026-07-18" }, today)).toBe(true);
    expect(isQuestDue({ completed: false, repeat: "none", dueDate: "2026-07-19" }, today)).toBe(false);
  });
});

describe("identifiers", () => {
  it("creates UUID-compatible identifiers for new records", () => {
    expect(uid("goal")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("uses stable UUID-compatible identifiers throughout the starter workspace", () => {
    const starter = createStarterGoals();
    const identifiers = starter.flatMap((goal) => [
      goal.id,
      ...goal.metrics.map((metric) => metric.id),
      ...goal.milestones.map((milestone) => milestone.id),
      ...goal.quests.map((quest) => quest.id),
    ]);
    expect(identifiers).toHaveLength(new Set(identifiers).size);
    identifiers.forEach((identifier) => {
      expect(identifier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });
});

describe("custom terminology", () => {
  it("derives readable singular labels without changing already-singular terms", () => {
    expect(singularizeTerm("Goals")).toBe("Goal");
    expect(singularizeTerm("Qualities")).toBe("Quality");
    expect(singularizeTerm("Branches")).toBe("Branch");
    expect(singularizeTerm("Progress")).toBe("Progress");
    expect(singularizeTerm("Mission")).toBe("Mission");
  });
});

describe("workspace numbers", () => {
  it("rejects non-finite and unsafe values at live mutation boundaries", () => {
    expect(isFiniteWorkspaceNumber(42, 0)).toBe(true);
    expect(isFiniteWorkspaceNumber(-1, 0)).toBe(false);
    expect(isFiniteWorkspaceNumber(Number.POSITIVE_INFINITY, 0)).toBe(false);
    expect(isFiniteWorkspaceNumber(Number.NaN, 0)).toBe(false);
    expect(isFiniteWorkspaceNumber(Number.MAX_SAFE_INTEGER + 1, 0)).toBe(false);
  });
});

describe("CSV export", () => {
  it("neutralizes spreadsheet formulas while retaining CSV quoting", () => {
    expect(escapeCsv("=HYPERLINK(\"https://example.test\")")).toBe("\"'=HYPERLINK(\"\"https://example.test\"\")\"");
    expect(escapeCsv("  @SUM(A1:A2)")).toBe("\"'  @SUM(A1:A2)\"");
    expect(escapeCsv("ordinary value")).toBe("\"ordinary value\"");
  });
});
