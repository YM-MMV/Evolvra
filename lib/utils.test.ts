import { describe, expect, it } from "vitest";
import { formatDate, goalProgress, isQuestAvailable, nextRepeatDate, parseLocalDate, shortDate } from "@/lib/utils";
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
    expect(formatDate("not-a-date")).toBe("No date");
  });

  it("clamps monthly repeats to the final day of shorter months", () => {
    expect(nextRepeatDate("monthly", "2026-01-31")).toBe("2026-02-28");
    expect(nextRepeatDate("monthly", "2028-01-31")).toBe("2028-02-29");
  });

  it("keeps future actions unavailable and completed one-off actions closed", () => {
    const today = new Date(2026, 6, 18);
    expect(isQuestAvailable({ completed: false, repeat: "daily", dueDate: "2026-07-19" }, today)).toBe(false);
    expect(isQuestAvailable({ completed: false, repeat: "daily", dueDate: "2026-07-18" }, today)).toBe(true);
    expect(isQuestAvailable({ completed: true, repeat: "none" }, today)).toBe(false);
  });
});
