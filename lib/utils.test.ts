import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import { goalProgress, levelFromXp, questXp } from "@/lib/utils";
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
  statWeights: {},
  evidence: [],
  notes: "",
};

describe("progress and XP rules", () => {
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

  it("does not fake progress for an unscored open goal", () => {
    expect(goalProgress({ ...baseGoal, model: "open" })).toBeNull();
  });

  it("caps quest XP", () => {
    expect(questXp({ effort: "major", difficulty: "difficult", impact: "important" }, DEFAULT_SETTINGS.scoring)).toBe(70);
  });

  it("increases level requirements gradually", () => {
    expect(levelFromXp(125)).toMatchObject({ level: 2, current: 0, needed: 150 });
  });
});
