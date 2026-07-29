import { describe, expect, it } from "vitest";
import { createStarterGoals, EMPTY_STATE } from "@/lib/defaults";
import {
  migrateState,
  migrateStoredState,
  MAX_WORKSPACE_NESTING_DEPTH,
  MAX_WORKSPACE_NODES,
  MAX_WORKSPACE_SERIALIZED_BYTES,
  MAX_WORKSPACE_STRING_BYTES,
  parseImportedState,
  UnsupportedStoredWorkspaceVersionError,
  WorkspaceImportError,
} from "@/lib/state-schema";

const NOW = "2026-07-18T12:00:00.000Z";

const serializedBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

function jsonNodeCount(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + value.reduce((total, item) => total + jsonNodeCount(item), 0);
  }
  if (typeof value === "object" && value !== null) {
    return 1 + Object.values(value).reduce(
      (total: number, item) => total + jsonNodeCount(item),
      0,
    );
  }
  return 1;
}

function backupWithSerializedBytes(targetBytes: number) {
  const backup = validV2Backup() as unknown as Record<string, unknown>;
  const padding: string[] = [];
  backup.extraPadding = padding;
  const payloadBytes = targetBytes - serializedBytes(backup);
  for (let itemCount = 1; itemCount < 100; itemCount += 1) {
    const stringContentBytes = payloadBytes - (itemCount * 2) - (itemCount - 1);
    if (stringContentBytes < 0 || stringContentBytes > itemCount * MAX_WORKSPACE_STRING_BYTES) {
      continue;
    }
    let remaining = stringContentBytes;
    for (let index = 0; index < itemCount; index += 1) {
      const size = Math.min(MAX_WORKSPACE_STRING_BYTES, remaining);
      padding.push("x".repeat(size));
      remaining -= size;
    }
    if (remaining === 0 && serializedBytes(backup) === targetBytes) return backup;
    padding.length = 0;
  }
  throw new Error(`Could not construct a ${targetBytes}-byte test backup.`);
}

function validV2Backup() {
  return {
    version: 2,
    updatedAt: NOW,
    profile: {
      displayName: "Morgan",
      chapter: "Build steadily",
      onboarded: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    settings: {
      theme: "dark",
      interfaceIntensity: "balanced",
      notifications: false,
      terminology: {
        goals: "Goals",
        quests: "Actions",
        areas: "Areas",
        milestones: "Milestones",
        stats: "Qualities",
      },
    },
    areas: [{ id: "area-health", name: "Health", color: "#38D69B", icon: "Heart", order: 0 }],
    stats: [{ id: "stat-steady", name: "Steadiness", color: "#48A9FF", icon: "Shield" }],
    goals: [
      {
        id: "goal-run",
        title: "Run comfortably",
        description: "Build a sustainable routine.",
        areaId: "area-health",
        model: "consistency",
        priority: "high",
        status: "active",
        createdAt: "2026-01-02T00:00:00.000Z",
        targetDate: "2026-10-31",
        metrics: [
          {
            id: "metric-runs",
            label: "Runs",
            current: 3,
            target: 12,
            unit: "runs",
            weight: 100,
            period: "month",
            periodKey: "month:2026-07",
          },
        ],
        milestones: [{ id: "milestone-five-k", title: "Comfortable 5K", weight: 100, completed: false }],
        quests: [
          {
            id: "quest-easy-run",
            linkedGoalIds: [] as string[],
            title: "Easy run",
            dueDate: "2026-07-19",
            repeat: "weekly",
            completed: false,
            durationMinutes: 30,
            metricDeltas: [{ metricId: "metric-runs", amount: 1 }],
          },
        ],
        statIds: ["stat-steady"],
        checkIns: [{ id: "check-in-one", createdAt: "2026-07-17T18:00:00.000Z", note: "Pace felt calm." }],
        evidence: ["https://example.com/run"],
        notes: "Consistency over intensity.",
      },
    ],
    questCompletions: [] as Array<{
      id: string;
      goalId: string;
      linkedGoalIds?: string[];
      questId: string;
      title: string;
      completedAt: string;
      durationMinutes?: number;
      note?: string;
      evidence?: string[];
      metricDeltas?: Array<{ metricId: string; amount: number }>;
    }>,
    metricEntries: [] as Array<{
      id: string;
      goalId: string;
      metricId: string;
      label?: string;
      unit?: string;
      value: number;
      previousValue: number;
      recordedAt: string;
      source: string;
      sourceCompletionId?: string;
      periodKey?: string;
    }>,
    reviews: [] as Array<{ id: string; cadence: string; createdAt: string; answers: Record<string, string> }>,
    timeline: [] as Array<{
      id: string;
      type: string;
      title: string;
      detail: string;
      at: string;
      goalId?: string;
      areaId?: string;
    }>,
  };
}

function addLinkedGoal(backup: ReturnType<typeof validV2Backup>) {
  const linkedGoal = structuredClone(backup.goals[0]);
  linkedGoal.id = "goal-strength";
  linkedGoal.title = "Build comfortable strength";
  linkedGoal.metrics = [];
  linkedGoal.milestones = [];
  linkedGoal.quests = [];
  linkedGoal.checkIns = [];
  linkedGoal.evidence = [];
  backup.goals.push(linkedGoal);
  return linkedGoal;
}

describe("workspace state migration", () => {
  it("keeps the built-in starter workspace canonical at the current version", () => {
    const starter = {
      ...structuredClone(EMPTY_STATE),
      profile: { ...structuredClone(EMPTY_STATE.profile), displayName: "Starter", onboarded: true },
      goals: createStarterGoals(),
    };

    expect(parseImportedState(starter)).toEqual(starter);
  });
  it("moves a v1 workspace to the non-points current model without losing real activity", () => {
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
          interfaceIntensity: "minimal",
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

    expect(migrated.version).toBe(3);
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
      kind: "task",
      title: "Easy run",
      repeat: "weekly",
      durationMinutes: 30,
    });
    expect(migrated.questCompletions).toEqual([
      {
        id: "completion-event-run",
        goalId: "goal",
        linkedGoalIds: [],
        questId: "easy-run",
        title: "Easy run",
        completedAt: "2026-07-17T08:00:00.000Z",
        durationMinutes: 30,
        evidence: [],
        metricDeltas: [],
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

  it("preserves explicit action types and defaults older actions to task", () => {
    const backup = validV2Backup();
    expect(migrateState(backup, NOW).goals[0].quests[0].kind).toBe("task");

    const action = backup.goals[0].quests[0] as unknown as { kind?: string };
    action.kind = "session";
    expect(parseImportedState(backup).goals[0].quests[0].kind).toBe("session");

    action.kind = "unsupported";
    expect(() => parseImportedState(backup)).toThrow(/kind is not supported/i);
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
      reviews: [{ answers: { useful: "yes", achievement: "A meaningful moment", invalid: 12 } }],
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
    expect(first.reviews[0].answers).toEqual({ useful: "yes", meaning: "A meaningful moment" });
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
    expect(migrated.settings.interfaceIntensity).toBe("immersive");
    expect(migrated.settings).not.toHaveProperty("gameIntensity");
  });

  it("preserves immutable completion context and does not recreate a duplicate from legacy activity", () => {
    const backup = validV2Backup();
    backup.questCompletions.push({
      id: "completion-actual",
      goalId: "goal-run",
      linkedGoalIds: [],
      questId: "quest-easy-run",
      title: "Rainy evening run",
      completedAt: "2026-07-17T08:00:00.000Z",
      durationMinutes: 47,
      note: "Kept the pace conversational.",
      evidence: ["https://example.com/watch", "https://example.com/watch"],
      metricDeltas: [{ metricId: "metric-runs", amount: 2 }],
    });
    backup.metricEntries.push({
      id: "entry-actual",
      goalId: "goal-run",
      metricId: "metric-runs",
      value: 5,
      previousValue: 3,
      recordedAt: "2026-07-17T08:00:00.000Z",
      source: "quest",
      periodKey: "month:2026-07",
    });
    backup.timeline.push({
      id: "event-same-completion",
      type: "quest",
      title: "Easy run",
      detail: "Action completed.",
      at: "2026-07-17T08:00:00.000Z",
      goalId: "goal-run",
      areaId: "area-health",
    });

    const migrated = migrateState(backup, NOW);

    expect(migrated.questCompletions).toHaveLength(1);
    expect(migrated.questCompletions[0]).toEqual({
      id: "completion-actual",
      goalId: "goal-run",
      linkedGoalIds: [],
      goalSnapshots: [{
        goalId: "goal-run",
        areaId: "area-health",
        statIds: ["stat-steady"],
      }],
      questId: "quest-easy-run",
      title: "Rainy evening run",
      completedAt: "2026-07-17T08:00:00.000Z",
      durationMinutes: 47,
      note: "Kept the pace conversational.",
      evidence: ["https://example.com/watch"],
      metricDeltas: [{ metricId: "metric-runs", amount: 2 }],
    });
    expect(migrated.metricEntries[0]).toMatchObject({
      id: "entry-actual",
      periodKey: "month:2026-07",
      previousValue: 3,
      value: 5,
    });
    expect(backup.questCompletions[0].evidence).toEqual([
      "https://example.com/watch",
      "https://example.com/watch",
    ]);
  });

  it("drops malformed optional dates and period keys during tolerant recovery", () => {
    const backup = validV2Backup();
    Object.assign(backup.settings, { birthDate: "2026-02-30" });
    backup.goals[0].targetDate = "2026-13-01";
    Object.assign(backup.goals[0].milestones[0], { completedAt: "not-a-date" });
    backup.goals[0].quests[0].dueDate = "tomorrow-ish";
    Object.assign(backup.goals[0].quests[0], { completedAt: "never" });
    backup.metricEntries.push({
      id: "entry-invalid-window",
      goalId: "goal-run",
      metricId: "metric-runs",
      value: 4,
      previousValue: 3,
      recordedAt: NOW,
      source: "manual",
      periodKey: "month:2026-19",
    });

    const recovered = migrateState(backup, NOW);

    expect(recovered.settings).not.toHaveProperty("birthDate");
    expect(recovered.goals[0]).not.toHaveProperty("targetDate");
    expect(recovered.goals[0].milestones[0]).not.toHaveProperty("completedAt");
    expect(recovered.goals[0].quests[0]).not.toHaveProperty("dueDate");
    expect(recovered.goals[0].quests[0]).not.toHaveProperty("completedAt");
    expect(recovered.metricEntries[0]).not.toHaveProperty("periodKey");
  });

  it("removes retired scoring fields from an already-versioned v2 recovery snapshot", () => {
    const backup = validV2Backup() as unknown as Record<string, unknown>;
    const settings = backup.settings as Record<string, unknown>;
    const goal = (backup.goals as Array<Record<string, unknown>>)[0];
    const metric = (goal.metrics as Array<Record<string, unknown>>)[0];
    const milestone = (goal.milestones as Array<Record<string, unknown>>)[0];
    const quest = (goal.quests as Array<Record<string, unknown>>)[0];
    const stat = (backup.stats as Array<Record<string, unknown>>)[0];
    backup.overallXp = 999;
    settings.scoring = { levelBase: 100, questCap: 70 };
    goal.checkInScore = 88;
    goal.statWeights = { "stat-steady": 100 };
    metric.xp = 10;
    milestone.xp = 50;
    quest.xp = 20;
    stat.xp = 300;

    const recovered = migrateState(backup, NOW);
    const serialized = JSON.stringify(recovered).toLowerCase();

    for (const retiredKey of ["\"overallxp\"", "\"xp\"", "\"scoring\"", "\"checkinscore\"", "\"statweights\""]) {
      expect(serialized).not.toContain(retiredKey);
    }
  });
});

describe("strict backup imports", () => {
  it("accepts a coherent v2 backup without rewriting valid scalar values", () => {
    const backup = validV2Backup();

    const imported = parseImportedState(backup);

    expect(imported.version).toBe(3);
    expect(imported.profile.displayName).toBe("Morgan");
    expect(imported.settings.theme).toBe("dark");
    expect(imported.goals[0].model).toBe("consistency");
    expect(imported.goals[0].statIds).toEqual(["stat-steady"]);
    expect(imported.goals[0].evidence).toEqual([expect.objectContaining({
      type: "link",
      url: "https://example.com/run",
    })]);
  });

  it("preserves supported legacy scalar defaults and the gameIntensity alias", () => {
    const backup = validV2Backup();
    const profile = backup.profile as unknown as Record<string, unknown>;
    const settings = backup.settings as unknown as Record<string, unknown>;
    const goal = backup.goals[0] as unknown as Record<string, unknown>;
    const milestone = backup.goals[0].milestones[0] as unknown as Record<string, unknown>;
    const quest = backup.goals[0].quests[0] as unknown as Record<string, unknown>;
    const review = { id: "review-legacy", cadence: "weekly", createdAt: NOW, answers: {} };
    const metricEntry = {
      id: "entry-legacy",
      goalId: "goal-run",
      metricId: "metric-runs",
      value: 4,
      previousValue: 3,
      recordedAt: NOW,
      source: "manual",
    };
    backup.reviews.push(review);
    backup.metricEntries.push(metricEntry);

    delete profile.onboarded;
    delete settings.theme;
    delete settings.interfaceIntensity;
    settings.gameIntensity = "immersive";
    delete settings.notifications;
    delete goal.model;
    delete goal.priority;
    delete goal.status;
    delete milestone.completed;
    delete quest.kind;
    delete quest.repeat;
    delete quest.completed;
    delete (review as unknown as Record<string, unknown>).cadence;
    delete (metricEntry as unknown as Record<string, unknown>).source;

    const imported = parseImportedState(backup);

    expect(imported.profile.onboarded).toBe(false);
    expect(imported.settings).toMatchObject({
      theme: "dark",
      interfaceIntensity: "immersive",
      notifications: false,
    });
    expect(imported.settings).not.toHaveProperty("gameIntensity");
    expect(imported.goals[0]).toMatchObject({ model: "open", priority: "medium", status: "active" });
    expect(imported.goals[0].milestones[0].completed).toBe(false);
    expect(imported.goals[0].quests[0]).toMatchObject({ kind: "task", repeat: "none", completed: false });
    expect(imported.reviews[0].cadence).toBe("weekly");
    expect(imported.metricEntries[0].source).toBe("manual");
  });

  it.each([
    {
      label: "profile onboarded",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.profile as unknown as Record<string, unknown>).onboarded = "yes";
      },
      message: /workspace\.profile\.onboarded must be a boolean/i,
    },
    {
      label: "settings theme",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.settings.theme = "neon";
      },
      message: /workspace\.settings\.theme is not supported/i,
    },
    {
      label: "settings interface intensity",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.settings.interfaceIntensity = "maximum";
      },
      message: /workspace\.settings\.interfaceIntensity is not supported/i,
    },
    {
      label: "legacy game intensity",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.settings as unknown as Record<string, unknown>).gameIntensity = "maximum";
      },
      message: /workspace\.settings\.gameIntensity is not supported/i,
    },
    {
      label: "settings notifications",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.settings as unknown as Record<string, unknown>).notifications = "yes";
      },
      message: /workspace\.settings\.notifications must be a boolean/i,
    },
    {
      label: "area hidden flag",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.areas[0] as unknown as Record<string, unknown>).hidden = "yes";
      },
      message: /workspace\.areas\[0\]\.hidden must be a boolean/i,
    },
    {
      label: "area archived flag",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.areas[0] as unknown as Record<string, unknown>).archived = 1;
      },
      message: /workspace\.areas\[0\]\.archived must be a boolean/i,
    },
    {
      label: "quality archived flag",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.stats[0] as unknown as Record<string, unknown>).archived = "no";
      },
      message: /workspace\.stats\[0\]\.archived must be a boolean/i,
    },
    {
      label: "goal model",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.goals[0].model = "unknown";
      },
      message: /workspace\.goals\[0\]\.model is not supported/i,
    },
    {
      label: "goal priority",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.goals[0].priority = "urgent";
      },
      message: /workspace\.goals\[0\]\.priority is not supported/i,
    },
    {
      label: "goal status",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.goals[0].status = "deleted";
      },
      message: /workspace\.goals\[0\]\.status is not supported/i,
    },
    {
      label: "metric period",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.goals[0].metrics[0].period = "fortnight";
      },
      message: /workspace\.goals\[0\]\.metrics\[0\]\.period is not supported/i,
    },
    {
      label: "milestone completion flag",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.goals[0].milestones[0] as unknown as Record<string, unknown>).completed = "yes";
      },
      message: /workspace\.goals\[0\]\.milestones\[0\]\.completed must be a boolean/i,
    },
    {
      label: "action kind",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.goals[0].quests[0] as unknown as Record<string, unknown>).kind = "appointment";
      },
      message: /workspace\.goals\[0\]\.quests\[0\]\.kind is not supported/i,
    },
    {
      label: "action repeat",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.goals[0].quests[0].repeat = "yearly";
      },
      message: /workspace\.goals\[0\]\.quests\[0\]\.repeat is not supported/i,
    },
    {
      label: "action completion flag",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        (backup.goals[0].quests[0] as unknown as Record<string, unknown>).completed = "yes";
      },
      message: /workspace\.goals\[0\]\.quests\[0\]\.completed must be a boolean/i,
    },
    {
      label: "review cadence",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.reviews.push({ id: "review-invalid", cadence: "yearly", createdAt: NOW, answers: {} });
      },
      message: /workspace\.reviews\[0\]\.cadence is not supported/i,
    },
    {
      label: "metric-entry source",
      mutate: (backup: ReturnType<typeof validV2Backup>) => {
        backup.metricEntries.push({
          id: "entry-invalid-source",
          goalId: "goal-run",
          metricId: "metric-runs",
          value: 4,
          previousValue: 3,
          recordedAt: NOW,
          source: "automation",
        });
      },
      message: /workspace\.metricEntries\[0\]\.source is not supported/i,
    },
  ])("rejects malformed $label scalars at import and stored-state boundaries", ({ mutate, message }) => {
    const imported = validV2Backup();
    mutate(imported);
    expect(() => parseImportedState(imported)).toThrow(message);

    const stored = validV2Backup();
    mutate(stored);
    expect(() => migrateStoredState(stored, NOW)).toThrow(message);
  });

  it.each([
    ["profile onboarded", (state: Record<string, unknown>) => {
      delete (state.profile as Record<string, unknown>).onboarded;
    }, /workspace\.profile\.onboarded is required/i],
    ["settings theme", (state: Record<string, unknown>) => {
      delete (state.settings as Record<string, unknown>).theme;
    }, /workspace\.settings\.theme is required/i],
    ["goal model", (state: Record<string, unknown>) => {
      delete ((state.goals as Array<Record<string, unknown>>)[0]).model;
    }, /workspace\.goals\[0\]\.model is required/i],
    ["action kind", (state: Record<string, unknown>) => {
      const goal = (state.goals as Array<Record<string, unknown>>)[0];
      delete ((goal.quests as Array<Record<string, unknown>>)[0]).kind;
    }, /workspace\.goals\[0\]\.quests\[0\]\.kind is required/i],
  ] as const)("rejects a current workspace missing its required %s scalar", (_label, mutate, message) => {
    const state = migrateStoredState(validV2Backup(), NOW) as unknown as Record<string, unknown>;
    mutate(state);
    expect(() => parseImportedState(state)).toThrow(message);
  });

  it("preserves unique additional goal links on actions and completion snapshots", () => {
    const backup = validV2Backup();
    const linkedGoal = addLinkedGoal(backup);
    backup.goals[0].quests[0].linkedGoalIds = [linkedGoal.id];
    backup.questCompletions.push({
      id: "completion-shared",
      goalId: "goal-run",
      linkedGoalIds: [linkedGoal.id],
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
      evidence: [],
      metricDeltas: [],
    });

    const imported = parseImportedState(backup);

    expect(imported.goals[0].quests[0].linkedGoalIds).toEqual([linkedGoal.id]);
    expect(imported.questCompletions[0].linkedGoalIds).toEqual([linkedGoal.id]);
  });

  it("requires causal measurement links to match one exact completion delta", () => {
    const backup = validV2Backup();
    backup.questCompletions.push({
      id: "completion-measured",
      goalId: "goal-run",
      linkedGoalIds: [],
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
      metricDeltas: [{ metricId: "metric-runs", amount: 2 }],
    });
    const entry = {
      id: "entry-from-completion",
      goalId: "goal-run",
      metricId: "metric-runs",
      value: 5,
      previousValue: 3,
      recordedAt: NOW,
      source: "quest",
      sourceCompletionId: "completion-measured",
    };
    backup.metricEntries.push(entry);
    expect(parseImportedState(backup).metricEntries[0].sourceCompletionId).toBe("completion-measured");

    const mismatch = structuredClone(backup);
    mismatch.metricEntries[0].value = 6;
    expect(() => parseImportedState(mismatch)).toThrow(/does not match its source completion delta/i);

    const duplicate = structuredClone(backup);
    duplicate.metricEntries.push({ ...entry, id: "entry-duplicate-link" });
    expect(() => parseImportedState(duplicate)).toThrow(/duplicate source completion and metric link/i);
  });

  it("defaults old linked-goal fields and repairs unsafe links during tolerant recovery", () => {
    const oldBackup = validV2Backup();
    delete (oldBackup.goals[0].quests[0] as unknown as Record<string, unknown>).linkedGoalIds;
    oldBackup.questCompletions.push({
      id: "completion-old-shape",
      goalId: "goal-run",
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
    });
    const oldRecovered = migrateState(oldBackup, NOW);
    expect(oldRecovered.goals[0].quests[0].linkedGoalIds).toEqual([]);
    expect(oldRecovered.questCompletions[0].linkedGoalIds).toEqual([]);

    const damaged = validV2Backup();
    const linkedGoal = addLinkedGoal(damaged);
    damaged.goals[0].quests[0].linkedGoalIds = ["goal-run", linkedGoal.id, linkedGoal.id, "goal-missing"];
    damaged.questCompletions.push({
      id: "completion-damaged-links",
      goalId: "goal-run",
      linkedGoalIds: ["goal-run", linkedGoal.id, linkedGoal.id, "goal-missing"],
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
    });
    const recovered = migrateState(damaged, NOW);
    expect(recovered.goals[0].quests[0].linkedGoalIds).toEqual([linkedGoal.id]);
    expect(recovered.questCompletions[0].linkedGoalIds).toEqual([linkedGoal.id]);
  });

  it("rejects duplicate, self, and missing linked-goal references on strict import", () => {
    const duplicate = validV2Backup();
    const duplicateGoal = addLinkedGoal(duplicate);
    duplicate.goals[0].quests[0].linkedGoalIds = [duplicateGoal.id, duplicateGoal.id];
    expect(() => parseImportedState(duplicate)).toThrow(/linkedGoalIds contains duplicate goal id/i);

    const self = validV2Backup();
    self.goals[0].quests[0].linkedGoalIds = ["goal-run"];
    expect(() => parseImportedState(self)).toThrow(/cannot link primary goal/i);

    const missing = validV2Backup();
    missing.goals[0].quests[0].linkedGoalIds = ["goal-missing"];
    expect(() => parseImportedState(missing)).toThrow(/references missing linked goal/i);

    const invalidHistory = validV2Backup();
    const historyGoal = addLinkedGoal(invalidHistory);
    invalidHistory.questCompletions.push({
      id: "completion-duplicate-links",
      goalId: "goal-run",
      linkedGoalIds: [historyGoal.id, historyGoal.id],
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
    });
    expect(() => parseImportedState(invalidHistory)).toThrow(/linkedGoalIds contains duplicate goal id/i);

    const selfHistory = validV2Backup();
    selfHistory.questCompletions.push({
      id: "completion-self-link",
      goalId: "goal-run",
      linkedGoalIds: ["goal-run"],
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
    });
    expect(() => parseImportedState(selfHistory)).toThrow(/history .* cannot link primary goal/i);

    const missingHistory = validV2Backup();
    missingHistory.questCompletions.push({
      id: "completion-missing-link",
      goalId: "goal-run",
      linkedGoalIds: ["goal-missing"],
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
    });
    expect(() => parseImportedState(missingHistory)).toThrow(/history .* references missing linked goal/i);
  });

  it("normalizes dashboard preferences during recovery and preserves valid preferences during import", () => {
    const backup = validV2Backup();
    Object.assign(backup.settings, {
      reminderTime: "07:45",
      dashboardOrder: ["goals", "life-map", "goals", "unsupported"],
      hiddenDashboardSections: ["qualities", "qualities", "unsupported"],
    });

    const recovered = migrateState(backup, NOW);
    expect(recovered.settings).toMatchObject({
      reminderTime: "07:45",
      dashboardOrder: ["goals", "life-map", "momentum", "qualities", "review"],
      hiddenDashboardSections: ["qualities"],
    });

    Object.assign(backup.settings, {
      dashboardOrder: ["goals", "life-map", "momentum", "qualities", "review"],
      hiddenDashboardSections: ["qualities", "review"],
    });
    expect(parseImportedState(backup).settings).toMatchObject({
      reminderTime: "07:45",
      dashboardOrder: ["goals", "life-map", "momentum", "qualities", "review"],
      hiddenDashboardSections: ["qualities", "review"],
    });
  });

  it("rejects malformed reminder and dashboard preferences at the import boundary", () => {
    const invalidTime = validV2Backup();
    Object.assign(invalidTime.settings, { reminderTime: "24:00" });
    expect(() => parseImportedState(invalidTime)).toThrow(/24-hour HH:MM/i);

    const duplicateOrder = validV2Backup();
    Object.assign(duplicateOrder.settings, { dashboardOrder: ["goals", "goals"] });
    expect(() => parseImportedState(duplicateOrder)).toThrow(/dashboardOrder contains duplicate entries/i);

    const unsupportedHidden = validV2Backup();
    Object.assign(unsupportedHidden.settings, { hiddenDashboardSections: ["leaderboard"] });
    expect(() => parseImportedState(unsupportedHidden)).toThrow(/contains an unsupported section/i);
  });

  it("keeps immutable history when its original action or metric has since been removed", () => {
    const backup = validV2Backup();
    backup.questCompletions.push({
      id: "completion-retained",
      goalId: "goal-run",
      questId: "quest-removed",
      title: "Retired training action",
      completedAt: "2026-06-01T08:00:00.000Z",
      durationMinutes: 25,
      note: "Historical context stays attached.",
      evidence: ["Training log page 4"],
      metricDeltas: [{ metricId: "metric-removed", amount: 1 }],
    });
    backup.metricEntries.push({
      id: "entry-retained",
      goalId: "goal-run",
      metricId: "metric-removed",
      value: 8,
      previousValue: 7,
      recordedAt: "2026-06-01T08:00:00.000Z",
      source: "quest",
      periodKey: "month:2026-06",
    });

    const imported = parseImportedState(backup);

    expect(imported.questCompletions[0]).toMatchObject({
      id: "completion-retained",
      questId: "quest-removed",
      note: "Historical context stays attached.",
      metricDeltas: [{ metricId: "metric-removed", amount: 1 }],
    });
    expect(imported.metricEntries[0]).toMatchObject({
      id: "entry-retained",
      metricId: "metric-removed",
      periodKey: "month:2026-06",
    });
  });

  it("accepts an explicitly legacy v1 backup and removes its retired point fields", () => {
    const current = validV2Backup();
    const goal = current.goals[0] as typeof current.goals[0] & {
      statWeights?: Record<string, number>;
      xp?: number;
    };
    const stat = current.stats[0] as typeof current.stats[0] & { xp?: number };
    const quest = goal.quests[0] as typeof goal.quests[0] & { xp?: number };
    const settings = current.settings as typeof current.settings & { scoring?: Record<string, number> };
    const legacy = current as typeof current & { overallXp?: number };
    legacy.version = 1;
    legacy.overallXp = 420;
    stat.xp = 120;
    quest.xp = 20;
    settings.scoring = { questCap: 70 };
    goal.statWeights = { "stat-steady": 100 };
    delete (goal as unknown as Record<string, unknown>).statIds;
    delete (goal as unknown as Record<string, unknown>).checkIns;
    delete (legacy as unknown as Record<string, unknown>).questCompletions;
    delete (legacy as unknown as Record<string, unknown>).metricEntries;
    legacy.timeline.push({
      id: "legacy-level-event",
      type: "level",
      title: "Legacy level event",
      detail: "Retired progress event.",
      at: "2026-07-17T08:00:00.000Z",
    });

    const imported = parseImportedState(legacy);

    expect(imported.version).toBe(3);
    expect(imported.goals[0].statIds).toEqual(["stat-steady"]);
    expect(imported.timeline).toEqual([]);
    const serialized = JSON.stringify(imported).toLowerCase();
    expect(serialized).not.toContain('"xp"');
    expect(serialized).not.toContain('"scoring"');
    expect(serialized).not.toContain('"level"');
  });

  it.each([null, [], "backup", 42])("rejects a non-object root (%j)", (value) => {
    expect(() => parseImportedState(value)).toThrow(WorkspaceImportError);
    expect(() => parseImportedState(value)).toThrow(/root value must be an object/i);
  });

  it("accepts the exact nesting boundary and rejects boundary plus one", () => {
    const backup = validV2Backup() as unknown as Record<string, unknown>;
    let cursor = backup;
    for (let index = 0; index < MAX_WORKSPACE_NESTING_DEPTH; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(() => parseImportedState(backup)).not.toThrow();
    cursor.next = {};
    expect(() => parseImportedState(backup)).toThrow(/maximum nesting depth/i);
  });

  it("accepts exact node and string boundaries and rejects boundary plus one", () => {
    const exactNodes = validV2Backup() as unknown as Record<string, unknown>;
    const baseNodes = jsonNodeCount(exactNodes);
    exactNodes.extraNodes = Array(MAX_WORKSPACE_NODES - baseNodes - 1).fill(null);
    expect(jsonNodeCount(exactNodes)).toBe(MAX_WORKSPACE_NODES);
    expect(() => parseImportedState(exactNodes)).not.toThrow();
    (exactNodes.extraNodes as null[]).push(null);
    expect(() => parseImportedState(exactNodes)).toThrow(/node safety limit/i);

    const exactString = validV2Backup() as unknown as Record<string, unknown>;
    exactString.extraString = "x".repeat(MAX_WORKSPACE_STRING_BYTES);
    expect(() => parseImportedState(exactString)).not.toThrow();
    exactString.extraString += "x";
    expect(() => parseImportedState(exactString)).toThrow(/per-string size limit/i);
  });

  it("accepts the exact serialized byte budget and rejects boundary plus one", () => {
    const exact = backupWithSerializedBytes(MAX_WORKSPACE_SERIALIZED_BYTES);
    const oversized = backupWithSerializedBytes(MAX_WORKSPACE_SERIALIZED_BYTES + 1);

    expect(() => parseImportedState(exact)).not.toThrow();
    expect(() => parseImportedState(oversized)).toThrow(/larger than the 5 MB safety limit/i);
  });

  it("accepts the exact top-level collection boundary and rejects boundary plus one", () => {
    const backup = validV2Backup();
    backup.areas = Array.from({ length: 500 }, (_, index) => ({
      ...backup.areas[0],
      id: `area-${index}`,
      order: index,
    }));
    backup.goals[0].areaId = "area-0";
    expect(() => parseImportedState(backup)).not.toThrow();
    backup.areas.push({ ...backup.areas[0], id: "area-500", order: 500 });
    expect(() => parseImportedState(backup)).toThrow(/workspace\.areas cannot contain more than 500/i);
  });

  it("rejects backups created by an unsupported future version", () => {
    const backup = validV2Backup();
    backup.version = 4;
    expect(() => parseImportedState(backup)).toThrow(/newer than this app supports/i);
  });

  it("rejects future stored or cloud snapshots instead of down-migrating them", () => {
    const snapshot = validV2Backup();
    snapshot.version = 4;

    expect(() => migrateStoredState(snapshot, NOW)).toThrow(
      UnsupportedStoredWorkspaceVersionError,
    );
    expect(() => migrateStoredState(snapshot, NOW)).toThrow(/version 4 is not supported/i);
  });

  it("rejects malformed nested records in supported stored versions", () => {
    const snapshot = validV2Backup();
    snapshot.goals = [{ malformed: true }] as unknown as ReturnType<typeof validV2Backup>["goals"];

    expect(() => migrateStoredState(snapshot, NOW)).toThrow(/workspace\.goals\[0\]\.id/i);
  });

  it("preserves a safe legacy file id and path through v2 migration and strict v3 parsing", () => {
    const snapshot = validV2Backup();
    snapshot.goals[0].evidence = [
      "file|evidence_old_123|proof.txt|text%2Fplain|5|account-1%2Fgoal-run%2Fevidence_old_123%2Fproof.txt",
    ];

    const migrated = migrateStoredState(snapshot, NOW);
    const reparsed = parseImportedState(migrated);

    expect(reparsed.goals[0].evidence).toEqual([{
      id: "evidence_old_123",
      type: "file",
      name: "proof.txt",
      mimeType: "text/plain",
      size: 5,
      remotePath: "account-1/goal-run/evidence_old_123/proof.txt",
    }]);
  });

  it("rejects a v3 file path bound to a different goal", () => {
    const snapshot = migrateStoredState(validV2Backup(), NOW);
    snapshot.goals[0].evidence = [{
      id: "evidence_old_123",
      type: "file",
      name: "proof.txt",
      mimeType: "text/plain",
      size: 5,
      remotePath: "account-1/goal-other/evidence_old_123/proof.txt",
    }];

    expect(() => parseImportedState(snapshot)).toThrow(/remotePath is not a valid private file path/i);
  });

  it("rejects a missing version or profile structure", () => {
    const missingVersion = validV2Backup() as unknown as Record<string, unknown>;
    delete missingVersion.version;
    expect(() => parseImportedState(missingVersion)).toThrow(/workspace\.version must be/i);

    const missingProfile = validV2Backup() as unknown as Record<string, unknown>;
    delete missingProfile.profile;
    expect(() => parseImportedState(missingProfile)).toThrow(/workspace\.profile must be an object/i);

    const malformedProfile = validV2Backup() as unknown as Record<string, unknown>;
    malformedProfile.profile = { displayName: "Morgan", onboarded: "yes" };
    expect(() => parseImportedState(malformedProfile)).toThrow(/workspace\.profile\.chapter must be a string/i);
  });

  it.each(["areas", "stats", "goals", "questCompletions", "metricEntries", "reviews", "timeline"])(
    "rejects a missing required %s array",
    (field) => {
      const backup = validV2Backup() as unknown as Record<string, unknown>;
      delete backup[field];
      expect(() => parseImportedState(backup)).toThrow(new RegExp(`workspace\\.${field} must be an array`, "i"));
    },
  );

  it("rejects top-level collections with the wrong type", () => {
    const backup = validV2Backup() as unknown as Record<string, unknown>;
    backup.goals = { id: "not-an-array" };
    expect(() => parseImportedState(backup)).toThrow(/workspace\.goals must be an array/i);
  });

  it("rejects corrupt collection entries rather than silently dropping them", () => {
    const backup = validV2Backup() as unknown as { goals: unknown[] };
    backup.goals.push(null);
    expect(() => parseImportedState(backup)).toThrow(/workspace\.goals\[1\] must be an object/i);
  });

  it("rejects duplicate top-level and nested ids", () => {
    const duplicateArea = validV2Backup();
    duplicateArea.areas.push({ ...duplicateArea.areas[0] });
    expect(() => parseImportedState(duplicateArea)).toThrow(/duplicate id "area-health"/i);

    const duplicateQuest = validV2Backup();
    duplicateQuest.goals[0].quests.push({ ...duplicateQuest.goals[0].quests[0] });
    expect(() => parseImportedState(duplicateQuest)).toThrow(/duplicate id "quest-easy-run"/i);
  });

  it("rejects non-finite numbers before sanitization can hide data loss", () => {
    const backup = validV2Backup();
    backup.goals[0].metrics[0].current = Number.POSITIVE_INFINITY;
    expect(() => parseImportedState(backup)).toThrow(/non-finite number/i);
  });

  it("rejects negative planned and recorded completion durations", () => {
    const negativePlan = validV2Backup();
    negativePlan.goals[0].quests[0].durationMinutes = -1;
    expect(() => parseImportedState(negativePlan)).toThrow(/durationMinutes cannot be negative/i);

    const negativeActual = validV2Backup();
    negativeActual.questCompletions.push({
      id: "completion-negative",
      goalId: "goal-run",
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
      durationMinutes: -1,
    });
    expect(() => parseImportedState(negativeActual)).toThrow(/durationMinutes cannot be negative/i);
  });

  it.each([
    ["invalid target date", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].targetDate = "2026-02-30"; }],
    ["invalid profile date", (backup: ReturnType<typeof validV2Backup>) => { backup.profile.createdAt = "not-a-date"; }],
    ["invalid check-in date", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].checkIns[0].createdAt = "invalid"; }],
  ])("rejects %s", (_label, corrupt) => {
    const backup = validV2Backup();
    corrupt(backup);
    expect(() => parseImportedState(backup)).toThrow(/must be a valid date/i);
  });

  it("rejects references that cannot form a coherent workspace", () => {
    const missingArea = validV2Backup();
    missingArea.goals[0].areaId = "area-missing";
    expect(() => parseImportedState(missingArea)).toThrow(/references missing area/i);

    const missingMetric = validV2Backup();
    missingMetric.goals[0].quests[0].metricDeltas[0].metricId = "metric-missing";
    expect(() => parseImportedState(missingMetric)).toThrow(/references missing metric/i);

    const missingGoal = validV2Backup();
    missingGoal.questCompletions.push({
      id: "completion-orphan",
      goalId: "goal-missing",
      questId: "quest-old",
      title: "Old action",
      completedAt: NOW,
    });
    expect(() => parseImportedState(missingGoal)).toThrow(/history .* references missing goal/i);
  });

  it("keeps tolerant recovery separate from strict import validation", () => {
    const corrupt = validV2Backup();
    corrupt.goals[0].createdAt = "invalid";
    corrupt.goals[0].metrics[0].current = Number.NaN;
    corrupt.areas.push({ ...corrupt.areas[0] });

    expect(() => parseImportedState(corrupt)).toThrow();
    const recovered = migrateState(corrupt, NOW);
    expect(recovered.goals[0].createdAt).toBe(NOW);
    expect(recovered.goals[0].metrics[0].current).toBe(0);
    expect(recovered.areas).toHaveLength(1);
  });

  it("safely repairs malformed nested numeric values while preserving usable records", () => {
    const corrupt = validV2Backup();
    corrupt.areas[0].order = -4;
    Object.assign(corrupt.goals[0].metrics[0], {
      current: -12,
      target: 0,
      weight: 140,
    });
    corrupt.goals[0].milestones[0].weight = 80;
    corrupt.goals[0].milestones.push({
      id: "milestone-ten-k",
      title: "Comfortable 10K",
      weight: 80,
      completed: false,
    });
    corrupt.goals[0].quests[0].durationMinutes = -30;
    const questDeltas = corrupt.goals[0].quests[0].metricDeltas as unknown[];
    questDeltas.splice(
      0,
      questDeltas.length,
      { metricId: "metric-runs", amount: 2 },
      { metricId: "metric-runs", amount: 3 },
      { metricId: "metric-runs" },
      { metricId: "metric-missing", amount: 8 },
      { metricId: "metric-runs", amount: Number.NaN },
    );
    corrupt.questCompletions.push({
      id: "completion-corrupt-context",
      goalId: "goal-run",
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
      durationMinutes: -5,
      metricDeltas: [
        { metricId: "metric-runs", amount: 1 },
        { metricId: "metric-runs", amount: 2 },
      ],
    });
    (corrupt.questCompletions[0].metricDeltas as unknown[]).push({ metricId: "metric-runs" });
    corrupt.metricEntries.push({
      id: "entry-corrupt-values",
      goalId: "goal-run",
      metricId: "metric-runs",
      value: -3,
      previousValue: -8,
      recordedAt: NOW,
      source: "manual",
    });

    const recovered = migrateState(corrupt, NOW);

    expect(recovered.areas[0].order).toBe(0);
    expect(recovered.goals[0].metrics[0]).toMatchObject({ current: 0, target: 1, weight: 100 });
    expect(recovered.goals[0].milestones.map((milestone) => milestone.weight)).toEqual([50, 50]);
    expect(recovered.goals[0].quests[0]).not.toHaveProperty("durationMinutes");
    expect(recovered.goals[0].quests[0].metricDeltas).toEqual([
      { metricId: "metric-runs", amount: 5 },
    ]);
    expect(recovered.questCompletions[0]).not.toHaveProperty("durationMinutes");
    expect(recovered.questCompletions[0].metricDeltas).toEqual([
      { metricId: "metric-runs", amount: 3 },
    ]);
    expect(recovered.metricEntries[0]).toMatchObject({
      value: 0,
      previousValue: 0,
      label: "Runs",
      unit: "runs",
    });
  });

  it("preserves bounded immutable metric context and infers missing context from a live metric", () => {
    const backup = validV2Backup();
    backup.metricEntries.push({
      id: "entry-context",
      goalId: "goal-run",
      metricId: "metric-runs",
      label: "Running sessions at the time",
      unit: "sessions",
      value: 4,
      previousValue: 3,
      recordedAt: NOW,
      source: "manual",
    });
    backup.metricEntries.push({
      id: "entry-inferred-context",
      goalId: "goal-run",
      metricId: "metric-runs",
      value: 5,
      previousValue: 4,
      recordedAt: "2026-07-18T12:05:00.000Z",
      source: "quest",
    });

    const imported = parseImportedState(backup);

    expect(imported.metricEntries[0]).toMatchObject({
      label: "Running sessions at the time",
      unit: "sessions",
    });
    expect(imported.metricEntries[1]).toMatchObject({ label: "Runs", unit: "runs" });
  });

  it.each([
    ["zero metric target", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].metrics[0].target = 0; }, /target must be greater than 0/i],
    ["negative metric current", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].metrics[0].current = -1; }, /current cannot be negative/i],
    ["negative metric weight", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].metrics[0].weight = -1; }, /weight cannot be negative/i],
    ["oversized metric weight", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].metrics[0].weight = 101; }, /weight cannot exceed 100/i],
    ["negative milestone weight", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].milestones[0].weight = -1; }, /weight cannot be negative/i],
    ["oversized milestone weight", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].milestones[0].weight = 101; }, /weight cannot exceed 100/i],
    ["unsafe metric value", (backup: ReturnType<typeof validV2Backup>) => { backup.goals[0].metrics[0].current = Number.MAX_VALUE; }, /current cannot exceed/i],
  ])("rejects %s at the import boundary", (_label, corrupt, message) => {
    const backup = validV2Backup();
    corrupt(backup);
    expect(() => parseImportedState(backup)).toThrow(message);
  });

  it("rejects milestone totals above 100", () => {
    const backup = validV2Backup();
    backup.goals[0].milestones[0].weight = 60;
    backup.goals[0].milestones.push({
      id: "milestone-overflow",
      title: "Overflow",
      weight: 41,
      completed: false,
    });
    expect(() => parseImportedState(backup)).toThrow(/total weight cannot exceed 100/i);
  });

  it("rejects missing, non-numeric, and duplicate metric deltas", () => {
    const missingAmount = validV2Backup();
    delete (missingAmount.goals[0].quests[0].metricDeltas[0] as unknown as Record<string, unknown>).amount;
    expect(() => parseImportedState(missingAmount)).toThrow(/amount must be a finite number/i);

    const stringAmount = validV2Backup();
    (stringAmount.goals[0].quests[0].metricDeltas[0] as unknown as Record<string, unknown>).amount = "one";
    expect(() => parseImportedState(stringAmount)).toThrow(/amount must be a finite number/i);

    const duplicate = validV2Backup();
    duplicate.goals[0].quests[0].metricDeltas.push({ metricId: "metric-runs", amount: 2 });
    expect(() => parseImportedState(duplicate)).toThrow(/duplicate metricId/i);

    const malformedHistory = validV2Backup();
    malformedHistory.questCompletions.push({
      id: "completion-malformed-delta",
      goalId: "goal-run",
      questId: "quest-easy-run",
      title: "Easy run",
      completedAt: NOW,
      metricDeltas: [{ metricId: "metric-runs", amount: 1 }],
    });
    (malformedHistory.questCompletions[0].metricDeltas?.[0] as unknown as Record<string, unknown>).amount = "one";
    expect(() => parseImportedState(malformedHistory)).toThrow(/amount must be a finite number/i);
  });

  it("rejects malformed numeric history and overlong immutable metric context", () => {
    const negativeEntry = validV2Backup();
    negativeEntry.metricEntries.push({
      id: "entry-negative",
      goalId: "goal-run",
      metricId: "metric-runs",
      value: -1,
      previousValue: 0,
      recordedAt: NOW,
      source: "manual",
    });
    expect(() => parseImportedState(negativeEntry)).toThrow(/value cannot be negative/i);

    const malformedDuration = validV2Backup();
    (malformedDuration.goals[0].quests[0] as unknown as Record<string, unknown>).durationMinutes = "thirty";
    expect(() => parseImportedState(malformedDuration)).toThrow(/durationMinutes must be a finite number/i);

    const overlongContext = validV2Backup();
    overlongContext.metricEntries.push({
      id: "entry-long-label",
      goalId: "goal-run",
      metricId: "metric-runs",
      label: "x".repeat(121),
      unit: "runs",
      value: 4,
      previousValue: 3,
      recordedAt: NOW,
      source: "manual",
    });
    expect(() => parseImportedState(overlongContext)).toThrow(/label cannot exceed 120 characters/i);
  });

  it("enforces bounded user-facing text fields before rendering or persistence", () => {
    const profile = validV2Backup();
    profile.profile.displayName = "x".repeat(121);
    expect(() => parseImportedState(profile)).toThrow(/displayName cannot exceed 120 characters/i);

    const goal = validV2Backup();
    goal.goals[0].title = "x".repeat(201);
    expect(() => parseImportedState(goal)).toThrow(/title cannot exceed 200 characters/i);

    const notes = validV2Backup();
    notes.goals[0].notes = "x".repeat(20_001);
    expect(() => parseImportedState(notes)).toThrow(/notes cannot exceed 20,000 characters/i);

    const checkIn = validV2Backup();
    checkIn.goals[0].checkIns[0].note = "x".repeat(5_001);
    expect(() => parseImportedState(checkIn)).toThrow(/note cannot exceed 5,000 characters/i);

    const review = validV2Backup();
    review.reviews.push({ id: "review-long", cadence: "weekly", createdAt: NOW, answers: { movement: "x".repeat(10_001) } });
    expect(() => parseImportedState(review)).toThrow(/string no longer than 10,000 characters/i);

    const timeline = validV2Backup();
    timeline.timeline.push({ id: "event-long", type: "note", title: "Context", detail: "x".repeat(5_001), at: NOW });
    expect(() => parseImportedState(timeline)).toThrow(/detail cannot exceed 5,000 characters/i);
  });

  it("enforces measured-goal and consistency-period invariants at the state-v3 boundary", () => {
    const current = parseImportedState(validV2Backup(), NOW);

    const missingMetric = structuredClone(current);
    missingMetric.goals[0].metrics = [];
    expect(() => parseImportedState(missingMetric, NOW)).toThrow(
      /metrics must include at least one metric/i,
    );

    const zeroWeights = structuredClone(current);
    zeroWeights.goals[0].metrics = zeroWeights.goals[0].metrics
      .map((metric) => ({ ...metric, weight: 0 }));
    expect(() => parseImportedState(zeroWeights, NOW)).toThrow(
      /at least one positive relative weight/i,
    );

    const missingPeriod = structuredClone(current);
    delete missingPeriod.goals[0].metrics[0].period;
    delete missingPeriod.goals[0].metrics[0].periodKey;
    expect(() => parseImportedState(missingPeriod, NOW)).toThrow(
      /period is required for a consistency metric/i,
    );

    const missingPeriodKey = structuredClone(current);
    delete missingPeriodKey.goals[0].metrics[0].periodKey;
    expect(() => parseImportedState(missingPeriodKey, NOW)).toThrow(
      /periodKey is required for a consistency metric/i,
    );
  });

  it("repairs supported legacy measured goals without dropping their metrics or history", () => {
    const legacy = validV2Backup();
    const legacyMetrics = legacy.goals[0].metrics as unknown as Array<{
      id: string;
      label: string;
      current: number;
      target: number;
      unit: string;
      weight: number;
      period?: string;
      periodKey?: string;
    }>;
    const firstMetric = legacyMetrics[0];
    firstMetric.weight = 0;
    delete firstMetric.period;
    delete firstMetric.periodKey;
    legacyMetrics.push({
      id: "metric-minutes",
      label: "Minutes",
      current: 90,
      target: 240,
      unit: "minutes",
      weight: 0,
    });
    legacy.metricEntries.push({
      id: "entry-minutes",
      goalId: legacy.goals[0].id,
      metricId: "metric-minutes",
      label: "Minutes",
      unit: "minutes",
      value: 90,
      previousValue: 60,
      recordedAt: NOW,
      source: "manual",
    });

    const migrated = migrateStoredState(legacy, NOW);
    expect(migrated.goals[0]).toMatchObject({ model: "numeric" });
    expect(migrated.goals[0].metrics).toEqual([
      expect.objectContaining({
        id: "metric-runs",
        current: 3,
        weight: 50,
      }),
      expect.objectContaining({
        id: "metric-minutes",
        current: 90,
        weight: 50,
      }),
    ]);
    expect(migrated.goals[0].metrics[0]).not.toHaveProperty("period");
    expect(migrated.goals[0].metrics[0]).not.toHaveProperty("periodKey");
    expect(migrated.goals[0].metrics[1]).not.toHaveProperty("period");
    expect(migrated.goals[0].metrics[1]).not.toHaveProperty("periodKey");
    expect(migrated.metricEntries).toEqual([
      expect.objectContaining({
        id: "entry-minutes",
        metricId: "metric-minutes",
        value: 90,
        previousValue: 60,
      }),
    ]);

    const measurementFree = validV2Backup();
    measurementFree.goals[0].metrics = [];
    measurementFree.goals[0].quests[0].metricDeltas = [];
    const safelyMigrated = migrateStoredState(measurementFree, NOW);
    expect(safelyMigrated.goals[0]).toMatchObject({
      id: "goal-run",
      model: "open",
      metrics: [],
      title: "Run comfortably",
      notes: "Consistency over intensity.",
    });
  });

  it("preserves valid consistency windows and converts ambiguous legacy counters to all-time numeric progress", () => {
    const valid = validV2Backup();
    expect(migrateState(valid, NOW).goals[0].metrics[0]).toMatchObject({
      period: "month",
      periodKey: "month:2026-07",
    });

    const invalidPeriod = validV2Backup();
    const invalidPeriodMetric = invalidPeriod.goals[0].metrics[0] as unknown as Record<string, unknown>;
    invalidPeriodMetric.period = "fortnight";
    invalidPeriodMetric.periodKey = "fortnight:2026-14";
    const migratedInvalidPeriod = migrateState(invalidPeriod, NOW).goals[0];
    expect(migratedInvalidPeriod.model).toBe("numeric");
    expect(migratedInvalidPeriod.metrics[0]).not.toHaveProperty("period");
    expect(migratedInvalidPeriod.metrics[0]).not.toHaveProperty("periodKey");

    const invalidKey = validV2Backup();
    invalidKey.goals[0].metrics[0].periodKey = "month:2026-13";
    const migratedInvalidKey = migrateState(invalidKey, NOW).goals[0];
    expect(migratedInvalidKey.model).toBe("numeric");
    expect(migratedInvalidKey.metrics[0]).not.toHaveProperty("period");
    expect(migratedInvalidKey.metrics[0]).not.toHaveProperty("periodKey");
  });

  it("rejects invalid consistency period fields at the strict import boundary", () => {
    const invalidPeriod = validV2Backup();
    invalidPeriod.goals[0].metrics[0].period = "fortnight";
    expect(() => parseImportedState(invalidPeriod)).toThrow(/period is not supported/i);

    const invalidKey = validV2Backup();
    invalidKey.goals[0].metrics[0].periodKey = "month:2026-13";
    expect(() => parseImportedState(invalidKey)).toThrow(/periodKey is not valid/i);

    const keyWithoutPeriod = validV2Backup();
    delete (keyWithoutPeriod.goals[0].metrics[0] as unknown as Record<string, unknown>).period;
    expect(() => parseImportedState(keyWithoutPeriod)).toThrow(/periodKey requires a period/i);
  });
});
