import { describe, expect, it } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import {
  parseTimelineFilters,
  reconciledTimelineEvents,
  timelineEventMatchesFilters,
  timelineHref,
} from "@/lib/timeline";
import type { AppState, Goal } from "@/lib/types";

const AT = "2026-07-18T12:00:00.000Z";

const goal: Goal = {
  id: "goal-1",
  title: "Publish the guide",
  description: "Create a useful guide.",
  areaId: "area-work",
  model: "numeric",
  priority: "high",
  status: "active",
  createdAt: AT,
  metrics: [{ id: "metric-1", label: "Sections", current: 1, target: 5, unit: "sections", weight: 100 }],
  milestones: [],
  quests: [],
  statIds: [],
  checkIns: [],
  evidence: [],
  notes: "",
};

function workspace(): AppState {
  return {
    ...structuredClone(EMPTY_STATE),
    profile: { ...EMPTY_STATE.profile, onboarded: true },
    goals: [structuredClone(goal)],
    questCompletions: [{
      id: "completion-1",
      goalId: goal.id,
      questId: "quest-1",
      linkedGoalIds: [],
      title: "Draft the outline",
      completedAt: AT,
      durationMinutes: 20,
      evidence: [],
      metricDeltas: [],
    }],
    metricEntries: [{
      id: "entry-1",
      goalId: goal.id,
      metricId: "metric-1",
      label: "Sections",
      unit: "sections",
      value: 1,
      previousValue: 0,
      recordedAt: AT,
      source: "manual",
    }],
  };
}

describe("reconciledTimelineEvents", () => {
  it("exports immutable completion and metric history without mirror events", () => {
    const events = reconciledTimelineEvents(workspace());
    expect(events.map((event) => event.id)).toEqual(expect.arrayContaining([
      "record-quest-completion-1",
      "record-metric-entry-1",
    ]));
  });

  it("does not duplicate a timeline mirror of a canonical completion", () => {
    const state = workspace();
    state.timeline = [{
      id: "mirror",
      type: "quest",
      title: "Draft the outline",
      detail: "Action completed.",
      at: AT,
      goalId: goal.id,
      areaId: goal.areaId,
    }];
    expect(reconciledTimelineEvents(state).filter((event) => event.type === "quest")).toHaveLength(1);
  });

  it("uses current terminology in reconstructed permanent records", () => {
    const state = workspace();
    state.settings.terminology.quests = "Rituals";
    state.settings.terminology.milestones = "Stages";
    state.goals[0].milestones = [{ id: "stage-1", title: "Outline approved", weight: 25, completed: true, completedAt: AT }];
    expect(reconciledTimelineEvents(state).find((event) => event.type === "quest")?.detail).toContain("Ritual completed");
    expect(reconciledTimelineEvents(state).find((event) => event.type === "milestone")?.detail).toContain("Stage reached");
  });

  it("retains shared goal and area attribution on one canonical action record", () => {
    const state = workspace();
    const relatedGoal: Goal = {
      ...structuredClone(goal),
      id: "goal-2",
      title: "Grow the audience",
      areaId: "area-social",
    };
    state.goals.push(relatedGoal);
    state.questCompletions[0].linkedGoalIds = [relatedGoal.id];

    const event = reconciledTimelineEvents(state).find((item) => item.id === "record-quest-completion-1");
    expect(event?.relatedGoalIds).toEqual([goal.id, relatedGoal.id]);
    expect(event?.relatedAreaIds).toEqual([goal.areaId, relatedGoal.areaId]);
    expect(event?.detail).toContain("also supports Grow the audience");
  });

  it("filters canonical history by immutable attribution after a goal is reorganised", () => {
    const state = workspace();
    state.questCompletions[0].goalSnapshots = [{
      goalId: goal.id,
      areaId: "area-original",
      statIds: ["stat-original"],
    }];
    state.goals[0].areaId = "area-new";
    state.goals[0].statIds = ["stat-new"];

    const event = reconciledTimelineEvents(state).find((item) => item.id === "record-quest-completion-1")!;
    expect(event.relatedAreaIds).toEqual(["area-original"]);
    expect(event.relatedStatIds).toEqual(["stat-original"]);
    expect(timelineEventMatchesFilters(event, {
      areaId: "area-original",
      statId: "stat-original",
      goalId: goal.id,
    })).toBe(true);
    expect(timelineEventMatchesFilters(event, { areaId: "area-new" })).toBe(false);
    expect(timelineEventMatchesFilters(event, { statId: "stat-new" })).toBe(false);
  });

  it("uses the immutable structural mirror for goal lifecycle attribution", () => {
    const state = workspace();
    state.goals[0].completedAt = AT;
    state.timeline = [{
      id: "goal-completion-mirror",
      type: "goal",
      title: "Publish the guide completed",
      detail: "Goal completed.",
      at: AT,
      goalId: goal.id,
      areaId: "area-original",
      relatedGoalIds: [goal.id],
      relatedAreaIds: ["area-original"],
      relatedStatIds: ["stat-original"],
    }];
    state.goals[0].areaId = "area-new";
    state.goals[0].statIds = ["stat-new"];

    const event = reconciledTimelineEvents(state).find((item) => item.id === `record-goal-completed-${goal.id}`)!;
    expect(event.areaId).toBe("area-original");
    expect(event.relatedAreaIds).toEqual(["area-original"]);
    expect(event.relatedStatIds).toEqual(["stat-original"]);
  });

  it("reconstructs a traceable goal-created source record", () => {
    const event = reconciledTimelineEvents(workspace()).find((item) => item.id === `record-goal-created-${goal.id}`)!;
    expect(event.title).toContain("Created");
    expect(timelineEventMatchesFilters(event, { type: "goal", query: "created" })).toBe(true);
  });
});

describe("timeline filters", () => {
  it("round-trips all supported URL filters", () => {
    const href = timelineHref({
      type: "quest",
      areaId: "area one",
      statId: "stat/one",
      goalId: "goal-1",
      from: "2026-07-01",
      to: "2026-07-18",
      query: "deep work & focus",
    }, "event-record-quest-1");
    const url = new URL(href, "https://evolvra.test");

    expect(parseTimelineFilters(url.searchParams)).toEqual({
      type: "quest",
      areaId: "area one",
      statId: "stat/one",
      goalId: "goal-1",
      from: "2026-07-01",
      to: "2026-07-18",
      query: "deep work & focus",
    });
    expect(url.hash).toBe("#event-record-quest-1");
  });

  it("uses inclusive local dates and ignores malformed URL values", () => {
    const event = {
      id: "event-1",
      type: "metric" as const,
      title: "Focus hours updated",
      detail: "2 → 3 hours",
      at: "2026-07-18T12:00:00.000Z",
      goalId: "goal-1",
      areaId: "area-1",
      relatedGoalIds: ["goal-1"],
      relatedAreaIds: ["area-1"],
      relatedStatIds: ["stat-1"],
    };

    expect(timelineEventMatchesFilters(event, {
      type: "metric",
      areaId: "area-1",
      statId: "stat-1",
      goalId: "goal-1",
      from: "2026-07-18",
      to: "2026-07-18",
      query: "FOCUS HOURS",
    })).toBe(true);
    expect(timelineEventMatchesFilters(event, { from: "2026-07-19" })).toBe(false);
    expect(parseTimelineFilters("?type=unknown&from=2026-02-30&to=2026-07-18T00%3A00%3A00Z&q=%20%20")).toEqual({});
  });

  it("offers a recorded-moment scope without including structural notes", () => {
    const activity = {
      id: "record-check-in-goal-1-check-in-1",
      type: "note" as const,
      title: "Check-in for Publish the guide",
      detail: "The outline is clearer.",
      at: AT,
    };
    const structuralNote = {
      ...activity,
      id: "event-quest-created",
      title: "New action: Draft the outline",
    };

    expect(parseTimelineFilters("?type=activity")).toEqual({ type: "activity" });
    expect(timelineEventMatchesFilters(activity, { type: "activity" })).toBe(true);
    expect(timelineEventMatchesFilters(structuralNote, { type: "activity" })).toBe(false);
    expect(timelineEventMatchesFilters({
      ...activity,
      id: "record-goal-completed-goal-1",
      type: "goal",
      title: "Publish the guide completed",
    }, { type: "activity" })).toBe(true);
    expect(timelineEventMatchesFilters({
      ...activity,
      id: "record-review-review-1",
      type: "review",
      title: "Weekly review completed",
    }, { type: "activity" })).toBe(true);
  });
});
