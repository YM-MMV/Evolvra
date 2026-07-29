import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import { EvidenceCompensationError } from "@/lib/evidence-operation-journal";
import {
  createGoalEvidenceActions,
  type GoalEvidenceActionPorts,
  type GoalEvidenceMetadataTransactions,
  type GoalEvidenceOperationScope,
  type GoalMetadataSnapshot,
  type LocalGoalEvidenceRepository,
  type RemoteGoalEvidenceRepository,
} from "@/lib/provider-goal-evidence";
import type { EvidenceBlobRecord } from "@/lib/persistence";
import type { AppState, GoalEvidence, GoalFileEvidence } from "@/lib/types";
import { workspaceScopeKeyFromDecimal } from "@/lib/workspace-scope";

const GOAL_ID = "goal-one";
const EVIDENCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REMOTE_PATH = `user-a/${GOAL_ID}/${EVIDENCE_ID}/proof.txt`;

const operationScope: GoalEvidenceOperationScope = Object.freeze({
  workspaceScopeKey: workspaceScopeKeyFromDecimal("7"),
  workspaceGeneration: workspaceScopeKeyFromDecimal("14"),
  persistenceAccountId: "user-a",
  persistenceGeneration: 9,
  authenticatedAccountId: "user-a",
});

function copyState(value: AppState): AppState {
  return JSON.parse(JSON.stringify(value)) as AppState;
}

function fileEvidence(overrides: Partial<GoalFileEvidence> = {}): GoalFileEvidence {
  return {
    id: EVIDENCE_ID,
    type: "file",
    name: "proof.txt",
    mimeType: "text/plain",
    size: 5,
    remotePath: REMOTE_PATH,
    ...overrides,
  };
}

function workspace(evidence: GoalEvidence[] = [fileEvidence()]): AppState {
  const state = copyState(EMPTY_STATE);
  state.goals = [{
    id: GOAL_ID,
    title: "Evidence",
    description: "",
    areaId: "area-growth",
    model: "open",
    priority: "medium",
    status: "active",
    createdAt: "2026-07-28T12:00:00.000Z",
    metrics: [],
    milestones: [],
    quests: [],
    statIds: [],
    checkIns: [],
    evidence,
    notes: "",
  }];
  return state;
}

function localRecord(): EvidenceBlobRecord {
  return {
    accountId: "user-a",
    goalId: GOAL_ID,
    evidenceId: EVIDENCE_ID,
    blob: new Blob(["local"], { type: "text/plain" }),
    savedAt: "2026-07-28T12:00:00.000Z",
  };
}

interface FakeHarness {
  actions: ReturnType<typeof createGoalEvidenceActions>;
  current: () => AppState;
  history: AppState[];
  events: string[];
  metadata: GoalEvidenceMetadataTransactions;
  local: LocalGoalEvidenceRepository;
  remote: RemoteGoalEvidenceRepository;
  isCurrent: ReturnType<typeof vi.fn<(scope: GoalEvidenceOperationScope) => boolean>>;
}

function harness(initialState = workspace()): FakeHarness {
  let state = copyState(initialState);
  const history: AppState[] = [];
  const events: string[] = [];
  const isCurrent = vi.fn(() => true);
  const metadata: GoalEvidenceMetadataTransactions = {
    readGoalEvidence: (goalId) => state.goals.find((goal) => goal.id === goalId)?.evidence,
    captureWorkspace: () => ({
      state: copyState(state),
      history: history.map(copyState),
    }),
    setGoalFileEvidence: (goalId, evidence) => {
      events.push("set-metadata");
      const goal = state.goals.find((item) => item.id === goalId);
      if (goal) goal.evidence = evidence.map((item) => ({ ...item }));
    },
    deleteGoalRecords: (goalId) => {
      events.push("delete-metadata");
      state.goals = state.goals.filter((goal) => goal.id !== goalId);
    },
    restoreWorkspace: (snapshot: GoalMetadataSnapshot) => {
      events.push("restore-metadata");
      state = copyState(snapshot.state);
      history.splice(0, history.length, ...snapshot.history.map(copyState));
    },
    flushDurably: async () => {
      events.push("flush-metadata");
    },
  };
  const local: LocalGoalEvidenceRepository = {
    list: async () => [localRecord()],
    remove: async () => {
      events.push("remove-local");
    },
    restore: async () => {
      events.push("restore-local");
    },
  };
  const remote: RemoteGoalEvidenceRepository = {
    assertWriteAllowed: () => {
      events.push("remote-write-check");
    },
    download: async () => {
      events.push("download-remote");
      return new Blob(["proof"], { type: "text/plain" });
    },
    remove: async () => {
      events.push("remove-remote");
    },
    restore: async () => {
      events.push("restore-remote");
    },
  };
  const ports: GoalEvidenceActionPorts = {
    metadata,
    localEvidence: local,
    remoteEvidence: remote,
    scope: {
      isCurrent,
      runExclusive: async (_scope, operation) => operation(),
    },
  };
  return {
    actions: createGoalEvidenceActions(ports),
    current: () => state,
    history,
    events,
    metadata,
    local,
    remote,
    isCurrent,
  };
}

describe("goal evidence metadata", () => {
  it("commits a detached evidence request under the exact scope", async () => {
    const test = harness();
    const replacement = [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      type: "note",
      text: "new proof",
    }] satisfies GoalEvidence[];

    await test.actions.setGoalFileEvidence({
      goalId: GOAL_ID,
      evidence: replacement,
      scope: operationScope,
    });
    replacement[0].text = "mutated by caller";

    expect(test.current().goals[0].evidence).toEqual([{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      type: "note",
      text: "new proof",
    }]);
    expect(test.isCurrent).toHaveBeenCalledWith(operationScope);
    expect(test.events).toEqual(["set-metadata", "flush-metadata"]);
  });

  it("rejects a stale scope before reading or changing metadata", async () => {
    const test = harness();
    test.isCurrent.mockReturnValue(false);
    const read = vi.spyOn(test.metadata, "readGoalEvidence");

    await expect(test.actions.setGoalFileEvidence({
      goalId: GOAL_ID,
      evidence: [],
      scope: operationScope,
    })).rejects.toThrow("active workspace changed");

    expect(read).not.toHaveBeenCalled();
    expect(test.events).toEqual([]);
  });

  it("rejects a missing goal without attempting a metadata commit", async () => {
    const test = harness(workspace());

    await expect(test.actions.setGoalFileEvidence({
      goalId: "missing-goal",
      evidence: [],
      scope: operationScope,
    })).rejects.toThrow("goal no longer exists");

    expect(test.events).toEqual([]);
  });

  it("restores and durably flushes the prior evidence after commit failure", async () => {
    const test = harness();
    vi.spyOn(test.metadata, "flushDurably")
      .mockRejectedValueOnce(new Error("commit failed"))
      .mockResolvedValueOnce();
    const replacement: GoalEvidence[] = [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      type: "note",
      text: "new proof",
    }];

    await expect(test.actions.setGoalFileEvidence({
      goalId: GOAL_ID,
      evidence: replacement,
      scope: operationScope,
    })).rejects.toThrow("commit failed");

    expect(test.current().goals[0].evidence).toEqual([fileEvidence()]);
    expect(test.metadata.flushDurably).toHaveBeenCalledTimes(2);
  });

  it("reports both metadata commit and compensation failures", async () => {
    const test = harness();
    vi.spyOn(test.metadata, "flushDurably")
      .mockRejectedValueOnce(new Error("commit failed"))
      .mockRejectedValueOnce(new Error("rollback failed"));

    const result = test.actions.setGoalFileEvidence({
      goalId: GOAL_ID,
      evidence: [],
      scope: operationScope,
    });
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toThrow("durably restored");
  });
});

describe("compensated goal deletion", () => {
  let test: FakeHarness;

  beforeEach(() => {
    test = harness();
  });

  it("durably deletes metadata before removing exact remote and local bytes", async () => {
    await test.actions.deleteGoal({ goalId: GOAL_ID, scope: operationScope });

    expect(test.current().goals).toHaveLength(0);
    expect(test.events).toEqual([
      "remote-write-check",
      "download-remote",
      "delete-metadata",
      "flush-metadata",
      "remove-remote",
      "remove-local",
    ]);
  });

  it("treats a missing goal as an exact no-op", async () => {
    test = harness(workspace([]));
    test.current().goals = [];
    const list = vi.spyOn(test.local, "list");

    await test.actions.deleteGoal({ goalId: GOAL_ID, scope: operationScope });

    expect(test.events).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects a stale scope before taking evidence snapshots", async () => {
    test.isCurrent.mockReturnValue(false);
    const list = vi.spyOn(test.local, "list");
    const download = vi.spyOn(test.remote, "download");

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow("active workspace changed");

    expect(list).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(test.events).toEqual([]);
  });

  it("rejects an invalid account-bound remote path before snapshots or metadata", async () => {
    test = harness(workspace([fileEvidence({ remotePath: `other/${GOAL_ID}/${EVIDENCE_ID}/proof.txt` })]));
    const list = vi.spyOn(test.local, "list");

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow("private evidence path is invalid");

    expect(list).not.toHaveBeenCalled();
    expect(test.events).toEqual([]);
  });

  it("rejects a remote blob whose type or size differs from metadata", async () => {
    vi.spyOn(test.remote, "download").mockResolvedValue(
      new Blob(["wrong-size"], { type: "text/plain" }),
    );
    const list = vi.spyOn(test.local, "list");

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow("did not match its recorded type and size");

    expect(list).not.toHaveBeenCalled();
    expect(test.current().goals).toHaveLength(1);
    expect(test.events).not.toContain("delete-metadata");
  });

  it("restores all snapshots and metadata after a remote deletion failure", async () => {
    vi.spyOn(test.remote, "remove").mockImplementation(async () => {
      test.events.push("remove-remote");
      throw new Error("remote delete failed");
    });

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow("remote delete failed");

    expect(test.events).toEqual([
      "remote-write-check",
      "download-remote",
      "delete-metadata",
      "flush-metadata",
      "remove-remote",
      "restore-remote",
      "restore-local",
      "restore-metadata",
      "flush-metadata",
    ]);
    expect(test.current().goals).toHaveLength(1);
  });

  it("restores all snapshots and metadata after a local deletion failure", async () => {
    vi.spyOn(test.local, "remove").mockImplementation(async () => {
      test.events.push("remove-local");
      throw new Error("local delete failed");
    });

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow("local delete failed");

    expect(test.events).toContain("restore-remote");
    expect(test.events).toContain("restore-local");
    expect(test.events).toContain("restore-metadata");
    expect(test.current().goals).toHaveLength(1);
  });

  it("does not remove bytes and restores metadata when its durable commit fails", async () => {
    vi.spyOn(test.metadata, "flushDurably")
      .mockRejectedValueOnce(new Error("metadata commit failed"))
      .mockResolvedValueOnce();

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow("metadata commit failed");

    expect(test.events).not.toContain("remove-remote");
    expect(test.events).not.toContain("remove-local");
    expect(test.events).toContain("restore-metadata");
    expect(test.current().goals).toHaveLength(1);
  });

  it("keeps metadata deleted when byte compensation fails", async () => {
    vi.spyOn(test.remote, "remove").mockImplementation(async () => {
      test.events.push("remove-remote");
      throw new Error("remote delete failed");
    });
    vi.spyOn(test.remote, "restore").mockImplementation(async () => {
      test.events.push("restore-remote");
      throw new Error("remote restore failed");
    });

    const result = test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    });
    await expect(result).rejects.toBeInstanceOf(EvidenceCompensationError);
    await expect(result).rejects.toMatchObject({
      originalError: expect.objectContaining({ message: "remote delete failed" }),
      rollbackFailures: [expect.objectContaining({ message: "remote restore failed" })],
    });
    expect(test.events).toContain("restore-local");
    expect(test.events).not.toContain("restore-metadata");
    expect(test.current().goals).toHaveLength(0);
  });
});
