import { describe, expect, it } from "vitest";
import { migrateState } from "@/lib/state-schema";

const NOW = "2026-07-18T12:00:00.000Z";

describe("workspace state migration", () => {
  it("moves a v1 workspace to the non-points v2 model without losing real activity", () => {
    const migrated = migrateState(
      {
        version: 1,
        updatedAt: "2026-07-17T10:00:00.000Z",
        overallXp: 725,
        profile: {
          displayName: "Morgan",
          chapter: "Build steadily",
          onboarded: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        settings: {
          theme: "light",
          gameIntensity: "minimal",
          notifications: true,
          scoring: { questCap: 70, levelBase: 100 },
          terminology: {
            goals: "Outcomes",
            quests: "Actions",
            areas: "Areas",
            milestones: "Milestones",
            stats: "Qualities",
          },
        },
        areas: [{ id: "area", name: "Health", color: "#00aa88", icon: "Heart", order: 0 }],
        stats: [
          { id: "steady", name: "Steadiness", color: "#00aa88", icon: "Shield", xp: 350 },
          { id: "unused", name: "Unused", color: "#888888", icon: "Circle", xp: 0 },
        ],
        goals: [
          {
            id: "goal",
            title: "Run comfortably",
            description: "Build a sustainable routine.",
            areaId: "area",
            model: "consistency",
            priority: "high",
            status: "active",
            createdAt: "2026-01-02T00:00:00.000Z",
            metrics: [{ id: "runs", label: "Runs", current: 3, target: 12, unit: "runs", weight: 100 }],
            milestones: [{ id: "five-k", title: "Comfortable 5K", weight: 100, xp: 200, completed: false }],
            quests: [
              {
                id: "easy-run",
                title: "Easy run",
                effort: "focused",
                difficulty: "moderate",
                impact: "meaningful",
                xp: 40,
                repeat: "weekly",
                completed: false,
                completedAt: "2026-07-17T08:00:00.000Z",
                durationMinutes: 30,
                metricDeltas: [{ metricId: "runs", amount: 1 }],
              },
            ],
            statWeights: { steady: 70, unused: 0, missing: 30 },
            checkInScore: 82,
            evidence: ["proof.png"],
            notes: "Consistency over intensity.",
          },
        ],
        reviews: [],
        timeline: [
          {
            id: "event-run",
            type: "quest",
            title: "Easy run",
            detail: "40 XP earned · 30 minutes invested.",
            at: "2026-07-17T08:00:00.000Z",
            goalId: "goal",
            areaId: "area",
            xp: 40,
          },
          {
            id: "event-level",
            type: "level",
            title: "Steadiness reached level 3",
            detail: "Easy run helped develop Steadiness.",
            at: "2026-07-17T08:00:01.000Z",
          },
        ],
      },
      NOW,
    );

    expect(migrated.version).toBe(2);
    expect(migrated.profile.displayName).toBe("Morgan");
    expect(migrated.settings.theme).toBe("light");
    expect(migrated.goals[0].statIds).toEqual(["steady"]);
    expect(migrated.goals[0].checkIns).toEqual([]);
    expect(migrated.goals[0].milestones[0]).toEqual({
      id: "five-k",
      title: "Comfortable 5K",
      weight: 100,
      completed: false,
    });
    expect(migrated.goals[0].quests[0]).toMatchObject({
      id: "easy-run",
      title: "Easy run",
      repeat: "weekly",
      durationMinutes: 30,
    });
    expect(migrated.questCompletions).toEqual([
      {
        id: "completion-event-run",
        goalId: "goal",
        questId: "easy-run",
        title: "Easy run",
        completedAt: "2026-07-17T08:00:00.000Z",
        durationMinutes: 30,
      },
    ]);
    expect(migrated.metricEntries).toEqual([]);
    expect(migrated.timeline).toHaveLength(1);
    expect(migrated.timeline[0].detail).toBe("Action completed · 30 minutes invested.");

    const serialized = JSON.stringify(migrated).toLowerCase();
    expect(serialized).not.toContain('"xp"');
    expect(serialized).not.toContain('"scoring"');
    expect(serialized).not.toContain('"level"');
    expect(serialized).not.toContain('"statweights"');
    expect(serialized).not.toContain('"checkinscore"');
  });

  it("sanitizes malformed values and gives generated records deterministic fallback ids", () => {
    const raw = {
      version: 999,
      profile: { onboarded: "yes" },
      settings: { theme: "neon", terminology: { goals: 42 } },
      areas: [{ name: "Work", order: "first" }, { name: "Duplicate", id: "area-migrated-1" }],
      stats: [{ name: "Focus" }],
      goals: [
        {
          title: "Ship",
          model: "unknown",
          priority: "unknown",
          status: "unknown",
          metrics: "invalid",
          milestones: [],
          quests: [],
          statIds: ["stat-migrated-1", 12, "stat-migrated-1"],
          checkIns: [{ note: "A useful reflection", createdAt: "invalid" }, { note: "" }],
          evidence: ["link", 10],
        },
      ],
      questCompletions: [{ goalId: "", questId: "quest" }],
      metricEntries: [{ goalId: "goal", metricId: "metric", value: Number.POSITIVE_INFINITY }],
      reviews: [{ answers: { useful: "yes", invalid: 12 } }],
      timeline: [{ type: "unknown" }],
    };

    const first = migrateState(raw, NOW);
    const second = migrateState(raw, NOW);

    expect(first).toEqual(second);
    expect(first.profile.onboarded).toBe(false);
    expect(first.settings.theme).toBe("dark");
    expect(first.areas).toHaveLength(1);
    expect(first.goals[0]).toMatchObject({
      id: "goal-migrated-1",
      model: "open",
      priority: "medium",
      status: "active",
      statIds: ["stat-migrated-1"],
    });
    expect(first.goals[0].checkIns).toEqual([
      {
        id: "goal-migrated-1-check-in-1",
        createdAt: NOW,
        note: "A useful reflection",
      },
    ]);
    expect(first.questCompletions).toEqual([]);
    expect(first.metricEntries[0]).toMatchObject({ value: 0, previousValue: 0, source: "manual" });
    expect(first.reviews[0].answers).toEqual({ useful: "yes" });
    expect(first.timeline).toEqual([]);
  });

  it("preserves valid v2 history fields", () => {
    const migrated = migrateState(
      {
        profile: { displayName: "A", chapter: "B", onboarded: true, createdAt: NOW },
        settings: { theme: "system", gameIntensity: "immersive", notifications: false, terminology: {} },
        areas: [],
        stats: [],
        goals: [],
        questCompletions: [
          { id: "completion", goalId: "goal", questId: "quest", title: "Walk", completedAt: NOW, durationMinutes: 20 },
        ],
        metricEntries: [
          {
            id: "entry",
            goalId: "goal",
            metricId: "distance",
            value: 5,
            previousValue: 3,
            recordedAt: NOW,
            source: "quest",
          },
        ],
        reviews: [],
        timeline: [],
      },
      NOW,
    );

    expect(migrated.questCompletions[0]).toMatchObject({ id: "completion", title: "Walk", durationMinutes: 20 });
    expect(migrated.metricEntries[0]).toEqual({
      id: "entry",
      goalId: "goal",
      metricId: "distance",
      value: 5,
      previousValue: 3,
      recordedAt: NOW,
      source: "quest",
    });
  });
});
