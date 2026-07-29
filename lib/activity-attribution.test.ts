import { describe, expect, it } from "vitest";
import {
  completionAreaShares,
  completionAttribution,
  completionGoalIds,
  completionStatIds,
  goalCompletionAttribution,
  momentSupportsAnyGoal,
  relatedGoalIds,
} from "@/lib/activity-attribution";

const AT = "2026-07-18T12:00:00.000Z";

describe("shared action attribution", () => {
  it("keeps the primary goal canonical and removes duplicate links", () => {
    expect(relatedGoalIds("goal-primary", ["goal-shared", "goal-primary", "goal-shared"]))
      .toEqual(["goal-primary", "goal-shared"]);
    expect(completionGoalIds({ goalId: "goal-primary", linkedGoalIds: ["goal-shared"] }))
      .toEqual(["goal-primary", "goal-shared"]);
  });

  it("matches a moment once when any related goal is in scope", () => {
    expect(momentSupportsAnyGoal(["goal-primary", "goal-shared"], new Set(["goal-shared"]))).toBe(true);
    expect(momentSupportsAnyGoal(["goal-primary", "goal-shared"], new Set(["goal-other"]))).toBe(false);
  });

  it("splits duration across distinct areas without inflating total time", () => {
    const shares = completionAreaShares(
      { goalId: "goal-a", linkedGoalIds: ["goal-b", "goal-c", "missing"], durationMinutes: 90, completedAt: AT, title: "Shared action" },
      [
        { id: "goal-a", areaId: "area-health" },
        { id: "goal-b", areaId: "area-health" },
        { id: "goal-c", areaId: "area-work" },
      ],
    );

    expect(shares).toEqual([
      { areaId: "area-health", goalId: "goal-a", minutes: 45 },
      { areaId: "area-work", goalId: "goal-c", minutes: 45 },
    ]);
    expect(shares.reduce((total, share) => total + share.minutes, 0)).toBe(90);
  });

  it("keeps all duration in one area when several connected goals share it", () => {
    expect(completionAreaShares(
      { goalId: "goal-a", linkedGoalIds: ["goal-b"], durationMinutes: 35, completedAt: AT, title: "Shared action" },
      [
        { id: "goal-a", areaId: "area-health" },
        { id: "goal-b", areaId: "area-health" },
      ],
    )).toEqual([{ areaId: "area-health", goalId: "goal-a", minutes: 35 }]);
  });

  it("uses immutable snapshots after goals move to other areas or qualities", () => {
    const completion = {
      goalId: "goal-a",
      linkedGoalIds: [],
      goalSnapshots: [{ goalId: "goal-a", areaId: "area-original", statIds: ["stat-original"] }],
      durationMinutes: 20,
      completedAt: AT,
      title: "Historical action",
    };
    const editedGoals = [{ id: "goal-a", areaId: "area-new", statIds: ["stat-new"] }];

    expect(completionAreaShares(completion, editedGoals)).toEqual([
      { areaId: "area-original", goalId: "goal-a", minutes: 20 },
    ]);
    expect(completionStatIds(completion, editedGoals)).toEqual(["stat-original"]);
  });

  it("uses legacy timeline attribution before mutable goal organisation", () => {
    const completion = {
      goalId: "goal-a",
      linkedGoalIds: [],
      completedAt: AT,
      title: "Historical action",
    };
    const editedGoals = [{ id: "goal-a", areaId: "area-new", statIds: ["stat-new"] }];
    const timeline = [{
      id: "legacy-mirror",
      type: "quest" as const,
      title: "Historical action",
      detail: "Action completed.",
      at: AT,
      goalId: "goal-a",
      areaId: "area-original",
      relatedGoalIds: ["goal-a"],
      relatedAreaIds: ["area-original"],
      relatedStatIds: ["stat-original"],
    }];

    expect(completionAttribution(completion, editedGoals, timeline)).toEqual({
      goalIds: ["goal-a"],
      areaIds: ["area-original"],
      statIds: ["stat-original"],
    });
  });

  it("keeps completed goal activity attached to its historical area and qualities", () => {
    const attribution = goalCompletionAttribution({
      id: "goal-a",
      title: "Finish the guide",
      areaId: "area-new",
      statIds: ["stat-new"],
      completedAt: AT,
    }, [{
      id: "goal-completed",
      type: "goal",
      title: "Finish the guide completed",
      detail: "Goal completed.",
      at: AT,
      goalId: "goal-a",
      areaId: "area-original",
      relatedGoalIds: ["goal-a"],
      relatedAreaIds: ["area-original"],
      relatedStatIds: ["stat-original"],
    }]);

    expect(attribution).toEqual({
      goalIds: ["goal-a"],
      areaIds: ["area-original"],
      statIds: ["stat-original"],
    });
  });
});
