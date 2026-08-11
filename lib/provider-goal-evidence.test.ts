import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import { EvidenceCompensationError } from "@/lib/evidence-operation-journal";
import {
  commitGoalEvidenceRemoteUpload,
  createGoalEvidenceActions,
  GoalEvidenceCloudSaveAmbiguousError,
  GoalEvidenceLocalCommitRetainedError,
  planWorkspaceReplacementEvidenceCleanup,
  removeSingleGoalEvidenceWithCompensation,
  requireEvidenceDeletionReceipt,
  saveGoalEvidenceCloudMetadataWithVerification,
  type GoalEvidenceActionPorts,
  type GoalEvidenceMetadataTransactions,
  type GoalEvidenceOperationScope,
  type GoalMetadataSnapshot,
  type LocalGoalEvidenceRepository,
  type RemoteGoalEvidenceRepository,
} from "@/lib/provider-goal-evidence";
import type {
  EvidenceBlobDeletionReceipt,
  EvidenceBlobRecord,
  EvidenceCleanupIntent,
} from "@/lib/persistence";
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
    writeId: "write-1",
  };
}

function cleanupIntent(): EvidenceCleanupIntent {
  return {
    kind: "cleanup",
    token: "cleanup-token",
    accountId: "user-a",
    goalId: GOAL_ID,
    evidenceId: EVIDENCE_ID,
    remotePath: REMOTE_PATH,
    createdAt: "2026-07-28T12:00:00.000Z",
  };
}

function localDeletionReceipt(): EvidenceBlobDeletionReceipt {
  return {
    accountId: "user-a",
    generation: operationScope.persistenceGeneration,
    workspaceLocalRevision: 11,
    evidenceRevisionAfterDelete: 4,
    snapshots: [localRecord()],
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
      return true;
    },
    flushDurably: async () => {
      events.push("flush-metadata");
      return 11;
    },
  };
  const local: LocalGoalEvidenceRepository = {
    list: async () => [localRecord()],
    remove: async (snapshots) => {
      events.push("remove-local");
      return {
        kind: "deleted",
        receipt: {
          accountId: "user-a",
          generation: operationScope.persistenceGeneration,
          workspaceLocalRevision: 11,
          evidenceRevisionAfterDelete: 4,
          snapshots,
        },
      };
    },
    stageCleanup: async (input) => ({
      ...input,
      kind: "cleanup",
      token: "cleanup-token",
      createdAt: "2026-07-28T12:00:00.000Z",
    }),
    cancelCleanup: async () => "cancelled",
  };
  const remote: RemoteGoalEvidenceRepository = {
    assertWriteAllowed: () => {
      events.push("remote-write-check");
    },
    claim: async () => {
      events.push("claim-remote");
      return "claimed";
    },
    remove: async () => {
      events.push("remove-remote");
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
  it("never treats a superseded compare-delete as a successful byte removal", () => {
    expect(() => requireEvidenceDeletionReceipt({ kind: "superseded" }))
      .toThrow(/metadata must be restored/i);
  });

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
      .mockResolvedValueOnce(11);
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

  it("keeps staged-add metadata when bytes committed locally but cloud did not", async () => {
    const test = harness();
    const retained = new GoalEvidenceLocalCommitRetainedError(
      new Error("cloud unavailable"),
      11,
      false,
    );
    vi.spyOn(test.metadata, "flushDurably").mockRejectedValueOnce(retained);
    const replacement = [fileEvidence({ remotePath: undefined })];

    await expect(test.actions.setGoalFileEvidence({
      goalId: GOAL_ID,
      evidence: replacement,
      scope: operationScope,
      stagedEvidence: [{
        token: "stage-token",
        record: localRecord(),
      }],
    })).rejects.toBe(retained);

    expect(test.current().goals[0].evidence).toEqual(replacement);
    expect(test.metadata.flushDurably).toHaveBeenCalledTimes(1);
  });
});

describe("journaled single-file remote upload", () => {
  it("stages cleanup before upload and retains it when a lost response cannot be verified", async () => {
    const events: string[] = [];
    const cancelCleanup = vi.fn(async () => {
      events.push("cancel-cleanup");
    });
    const remove = vi.fn(async () => {
      events.push("remove-remote");
    });
    const commitMetadata = vi.fn(async (remotePath: string | undefined) => {
      events.push(remotePath ? "commit-remote-metadata" : "commit-local-metadata");
    });

    const outcome = await commitGoalEvidenceRemoteUpload({
      remotePath: REMOTE_PATH,
      blob: new Blob(["proof"], { type: "text/plain" }),
      allowLocalOnly: true,
      stageCleanup: async () => {
        events.push("stage-cleanup");
        return cleanupIntent();
      },
      upload: async () => {
        events.push("upload-remote");
        throw new TypeError("response lost");
      },
      download: async () => {
        events.push("verify-remote");
        throw new TypeError("verification unavailable");
      },
      commitMetadata,
      remove,
      cancelCleanup,
    });

    expect(outcome).toEqual({
      uploadNeedsRetry: true,
      cleanupPending: true,
    });
    expect(events).toEqual([
      "stage-cleanup",
      "upload-remote",
      "verify-remote",
      "commit-local-metadata",
    ]);
    expect(remove).not.toHaveBeenCalled();
    expect(cancelCleanup).not.toHaveBeenCalled();
  });

  it("adopts an exact object after a lost upload response, then cancels only after metadata commits", async () => {
    const events: string[] = [];
    const proof = new Blob(["proof"], { type: "text/plain" });

    const outcome = await commitGoalEvidenceRemoteUpload({
      remotePath: REMOTE_PATH,
      blob: proof,
      allowLocalOnly: false,
      stageCleanup: async () => {
        events.push("stage-cleanup");
        return cleanupIntent();
      },
      upload: async () => {
        events.push("upload-remote");
        throw new TypeError("response lost");
      },
      download: async () => {
        events.push("verify-remote");
        return proof;
      },
      commitMetadata: async (remotePath) => {
        events.push(`commit-metadata:${remotePath}`);
      },
      remove: async () => {
        events.push("remove-remote");
      },
      cancelCleanup: async () => {
        events.push("cancel-cleanup");
      },
    });

    expect(outcome).toEqual({
      remotePath: REMOTE_PATH,
      uploadNeedsRetry: false,
      cleanupPending: false,
    });
    expect(events).toEqual([
      "stage-cleanup",
      "upload-remote",
      "verify-remote",
      `commit-metadata:${REMOTE_PATH}`,
      "cancel-cleanup",
    ]);
  });

  it("retains cleanup when metadata and immediate remote compensation both fail", async () => {
    const metadataError = new Error("metadata failed");
    const cancelCleanup = vi.fn(async () => undefined);
    const events: string[] = [];

    const result = commitGoalEvidenceRemoteUpload({
      remotePath: REMOTE_PATH,
      blob: new Blob(["proof"], { type: "text/plain" }),
      allowLocalOnly: false,
      stageCleanup: async () => {
        events.push("stage-cleanup");
        return cleanupIntent();
      },
      upload: async () => {
        events.push("upload-remote");
      },
      download: async () => {
        throw new Error("not used");
      },
      commitMetadata: async () => {
        events.push("commit-metadata");
        throw metadataError;
      },
      remove: async () => {
        events.push("remove-remote");
        throw new TypeError("remove response lost");
      },
      cancelCleanup,
    });

    await expect(result).rejects.toBe(metadataError);
    expect(events).toEqual([
      "stage-cleanup",
      "upload-remote",
      "commit-metadata",
      "remove-remote",
    ]);
    expect(cancelCleanup).not.toHaveBeenCalled();
  });

  it("cancels after a retained local metadata commit references the immutable path", async () => {
    const retained = new GoalEvidenceLocalCommitRetainedError(
      new Error("cloud metadata unavailable"),
      12,
      false,
    );
    const remove = vi.fn(async () => undefined);
    const cancelCleanup = vi.fn(async () => undefined);

    const outcome = await commitGoalEvidenceRemoteUpload({
      remotePath: REMOTE_PATH,
      blob: new Blob(["proof"], { type: "text/plain" }),
      allowLocalOnly: false,
      stageCleanup: async () => cleanupIntent(),
      upload: async () => undefined,
      download: async () => {
        throw new Error("not used");
      },
      commitMetadata: async () => {
        throw retained;
      },
      remove,
      cancelCleanup,
    });

    expect(outcome.localCommitRetainedError).toBe(retained);
    expect(outcome.cleanupPending).toBe(false);
    expect(cancelCleanup).toHaveBeenCalledWith(cleanupIntent());
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("compensated single-file removal", () => {
  it("claims before deleting remote and local bytes, then cancels the journal", async () => {
    const events: string[] = [];
    await expect(removeSingleGoalEvidenceWithCompensation({
      stageCleanup: async () => {
        events.push("stage-cleanup");
        return cleanupIntent();
      },
      commitMetadataDeletion: async () => {
        events.push("delete-metadata");
        return 11;
      },
      claimRemote: async () => {
        events.push("claim-remote");
        return "claimed";
      },
      removeRemote: async () => {
        events.push("remove-remote");
      },
      removeLocal: async () => {
        events.push("remove-local");
        return localDeletionReceipt();
      },
      restoreMetadata: async () => {
        events.push("restore-metadata");
      },
      cancelCleanup: async () => {
        events.push("cancel-cleanup");
      },
    })).resolves.toEqual({ cleanupPending: false });
    expect(events).toEqual([
      "stage-cleanup",
      "delete-metadata",
      "claim-remote",
      "remove-remote",
      "remove-local",
      "cancel-cleanup",
    ]);
  });

  it("keeps deletion metadata and the journal after a claimed remove becomes ambiguous", async () => {
    const restoreMetadata = vi.fn(async () => undefined);
    const cancelCleanup = vi.fn(async () => undefined);

    await expect(removeSingleGoalEvidenceWithCompensation({
      stageCleanup: async () => cleanupIntent(),
      commitMetadataDeletion: async () => 11,
      claimRemote: async () => "claimed",
      removeRemote: async () => {
        throw new TypeError("delete response lost");
      },
      restoreMetadata,
      cancelCleanup,
    })).resolves.toEqual({ cleanupPending: true });
    expect(restoreMetadata).not.toHaveBeenCalled();
    expect(cancelCleanup).not.toHaveBeenCalled();
  });

  it("keeps deletion metadata when the claim response is ambiguous", async () => {
    const removeRemote = vi.fn(async () => undefined);
    const restoreMetadata = vi.fn(async () => undefined);
    const cancelCleanup = vi.fn(async () => undefined);

    await expect(removeSingleGoalEvidenceWithCompensation({
      stageCleanup: async () => cleanupIntent(),
      commitMetadataDeletion: async () => 11,
      claimRemote: async () => {
        throw new TypeError("claim response lost");
      },
      removeRemote,
      restoreMetadata,
      cancelCleanup,
    })).resolves.toEqual({ cleanupPending: true });
    expect(removeRemote).not.toHaveBeenCalled();
    expect(restoreMetadata).not.toHaveBeenCalled();
    expect(cancelCleanup).not.toHaveBeenCalled();
  });

  it("compensates metadata only after a definitive referenced response", async () => {
    const events: string[] = [];
    const removeRemote = vi.fn(async () => undefined);

    await expect(removeSingleGoalEvidenceWithCompensation({
      stageCleanup: async () => {
        events.push("stage-cleanup");
        return cleanupIntent();
      },
      commitMetadataDeletion: async () => {
        events.push("delete-metadata");
        return 11;
      },
      claimRemote: async () => {
        events.push("claim-remote");
        return "referenced";
      },
      removeRemote,
      restoreMetadata: async () => {
        events.push("restore-metadata");
      },
      cancelCleanup: async () => {
        events.push("cancel-cleanup");
      },
    })).rejects.toThrow(/newer cloud workspace still references/i);
    expect(removeRemote).not.toHaveBeenCalled();
    expect(events).toEqual([
      "stage-cleanup",
      "delete-metadata",
      "claim-remote",
      "restore-metadata",
      "cancel-cleanup",
    ]);
  });

  it("does not roll deletion back when only cleanup-journal cancellation fails", async () => {
    const restoreMetadata = vi.fn(async () => undefined);

    await expect(removeSingleGoalEvidenceWithCompensation({
      stageCleanup: async () => cleanupIntent(),
      commitMetadataDeletion: async () => 11,
      claimRemote: async () => "claimed",
      removeRemote: async () => undefined,
      removeLocal: async () => localDeletionReceipt(),
      restoreMetadata,
      cancelCleanup: async () => {
        throw new Error("journal unavailable");
      },
    })).resolves.toEqual({ cleanupPending: true });
    expect(restoreMetadata).not.toHaveBeenCalled();
  });

  it("requires claim and remove ports as one remote deletion contract", async () => {
    await expect(removeSingleGoalEvidenceWithCompensation({
      stageCleanup: async () => cleanupIntent(),
      commitMetadataDeletion: async () => 11,
      removeRemote: async () => undefined,
      restoreMetadata: async () => undefined,
      cancelCleanup: async () => undefined,
    })).rejects.toThrow(/requires an atomic server-side cleanup claim/i);
  });

  it("refuses byte cleanup when the durable journal was not staged", async () => {
    const commitMetadataDeletion = vi.fn(async () => 11);

    await expect(removeSingleGoalEvidenceWithCompensation({
      stageCleanup: async () => null,
      commitMetadataDeletion,
      claimRemote: async () => "claimed",
      removeRemote: async () => undefined,
      restoreMetadata: async () => undefined,
      cancelCleanup: async () => undefined,
    })).rejects.toThrow(/without a durable cleanup journal/i);
    expect(commitMetadataDeletion).not.toHaveBeenCalled();
  });
});

describe("authoritative workspace replacement evidence cleanup", () => {
  it("selects exact local bytes and owned remote paths that lose all references", () => {
    expect(planWorkspaceReplacementEvidenceCleanup({
      accountId: "user-a",
      sourceStates: [workspace()],
      targetStates: [workspace([])],
      localEvidence: [localRecord()],
    })).toEqual([{
      accountId: "user-a",
      goalId: GOAL_ID,
      evidenceId: EVIDENCE_ID,
      expectedWriteId: "write-1",
      remotePath: REMOTE_PATH,
    }]);
  });

  it("preserves same-key local bytes while journaling a superseded remote path", () => {
    const replacementPath = `user-a/${GOAL_ID}/${EVIDENCE_ID}/replacement.txt`;
    expect(planWorkspaceReplacementEvidenceCleanup({
      accountId: "user-a",
      sourceStates: [workspace()],
      targetStates: [workspace([fileEvidence({ remotePath: replacementPath })])],
      localEvidence: [localRecord()],
    })).toEqual([{
      accountId: "user-a",
      goalId: GOAL_ID,
      evidenceId: EVIDENCE_ID,
      remotePath: REMOTE_PATH,
    }]);
  });

  it("does not clean evidence retained by an authoritative target", () => {
    expect(planWorkspaceReplacementEvidenceCleanup({
      accountId: "user-a",
      sourceStates: [workspace(), workspace()],
      targetStates: [workspace()],
      localEvidence: [localRecord()],
    })).toEqual([]);
  });

  it("never deletes an unowned remote path but still records exact local cleanup", () => {
    expect(planWorkspaceReplacementEvidenceCleanup({
      accountId: "user-a",
      sourceStates: [workspace([fileEvidence({
        remotePath: `user-b/${GOAL_ID}/${EVIDENCE_ID}/proof.txt`,
      })])],
      targetStates: [workspace([])],
      localEvidence: [localRecord()],
    })).toEqual([{
      accountId: "user-a",
      goalId: GOAL_ID,
      evidenceId: EVIDENCE_ID,
      expectedWriteId: "write-1",
    }]);
  });

  it("refuses to orphan a local record without an exact live identity", () => {
    const legacyRecord = { ...localRecord(), writeId: undefined };
    expect(() => planWorkspaceReplacementEvidenceCleanup({
      accountId: "user-a",
      sourceStates: [workspace()],
      targetStates: [workspace([])],
      localEvidence: [legacyRecord],
    })).toThrow(/exact live write identity/i);
  });
});

describe("evidence metadata cloud save verification", () => {
  const submitted = workspace();
  const exact = {
    state: submitted,
    revision: 9,
    updated_at: "2026-07-28T13:00:00.000Z",
  };
  const run = (overrides: Partial<Parameters<
    typeof saveGoalEvidenceCloudMetadataWithVerification
  >[0]> = {}) => saveGoalEvidenceCloudMetadataWithVerification({
    state: submitted,
    expectedRevision: 8,
    save: async () => ({ data: [exact], error: null }),
    readAuthoritative: async () => ({ data: exact, error: null }),
    migrateState: (value) => value as AppState,
    statesEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    parseRevision: (value) => typeof value === "number" ? value : null,
    ...overrides,
  });

  it("confirms a commit whose save response was lost before allowing cleanup", async () => {
    const readAuthoritative = vi.fn(async () => ({ data: exact, error: null }));
    await expect(run({
      save: async () => { throw new TypeError("response lost"); },
      readAuthoritative,
    })).resolves.toMatchObject({ revision: 9, state: submitted });
    expect(readAuthoritative).toHaveBeenCalledOnce();
  });

  it("retains an unresolved commit-lost response as explicitly ambiguous", async () => {
    await expect(run({
      save: async () => ({ data: null, error: new TypeError("aborted"), status: 0 }),
      readAuthoritative: async () => ({
        data: { ...exact, revision: 8 },
        error: null,
      }),
    })).rejects.toBeInstanceOf(GoalEvidenceCloudSaveAmbiguousError);
  });

  it("does not reinterpret a returned non-transport error as ambiguous", async () => {
    const definite = new Error("revision conflict");
    const readAuthoritative = vi.fn();
    await expect(run({
      save: async () => ({ data: null, error: definite, status: 409 }),
      readAuthoritative,
    })).rejects.toBe(definite);
    expect(readAuthoritative).not.toHaveBeenCalled();
  });
});

describe("compensated goal deletion", () => {
  let test: FakeHarness;

  beforeEach(() => {
    test = harness();
  });

  it("durably deletes metadata, atomically claims the path batch, then removes bytes", async () => {
    await test.actions.deleteGoal({ goalId: GOAL_ID, scope: operationScope });

    expect(test.current().goals).toHaveLength(0);
    expect(test.events).toEqual([
      "remote-write-check",
      "delete-metadata",
      "flush-metadata",
      "claim-remote",
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
    const claim = vi.spyOn(test.remote, "claim");

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow("active workspace changed");

    expect(list).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
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

  it("restores metadata before touching bytes when the current cloud still references a path", async () => {
    vi.spyOn(test.remote, "claim").mockImplementation(async () => {
      test.events.push("claim-remote");
      return "referenced";
    });

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow(/newer cloud workspace still references/i);

    expect(test.events).toEqual([
      "remote-write-check",
      "delete-metadata",
      "flush-metadata",
      "claim-remote",
      "restore-metadata",
      "flush-metadata",
    ]);
    expect(test.events).not.toContain("remove-remote");
    expect(test.events).not.toContain("remove-local");
    expect(test.current().goals).toHaveLength(1);
  });

  it("keeps metadata deleted and the journal pending after a claimed remote deletion failure", async () => {
    vi.spyOn(test.remote, "remove").mockImplementation(async () => {
      test.events.push("remove-remote");
      throw new Error("remote delete failed");
    });
    const cancel = vi.spyOn(test.local, "cancelCleanup");

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).resolves.toBeUndefined();

    expect(test.events).toEqual([
      "remote-write-check",
      "delete-metadata",
      "flush-metadata",
      "claim-remote",
      "remove-remote",
      "remove-local",
    ]);
    expect(cancel).not.toHaveBeenCalled();
    expect(test.current().goals).toHaveLength(0);
  });

  it("keeps metadata deleted and the journal pending after a local deletion failure", async () => {
    vi.spyOn(test.local, "remove").mockImplementation(async () => {
      test.events.push("remove-local");
      throw new Error("local delete failed");
    });
    const cancel = vi.spyOn(test.local, "cancelCleanup");

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).resolves.toBeUndefined();

    expect(test.events).toContain("claim-remote");
    expect(test.events).toContain("remove-remote");
    expect(test.events).not.toContain("restore-metadata");
    expect(cancel).not.toHaveBeenCalled();
    expect(test.current().goals).toHaveLength(0);
  });

  it("does not remove bytes and restores metadata when its durable commit fails", async () => {
    vi.spyOn(test.metadata, "flushDurably")
      .mockRejectedValueOnce(new Error("metadata commit failed"))
      .mockResolvedValueOnce(11);

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).rejects.toThrow("metadata commit failed");

    expect(test.events).not.toContain("remove-remote");
    expect(test.events).not.toContain("remove-local");
    expect(test.events).toContain("restore-metadata");
    expect(test.current().goals).toHaveLength(1);
  });

  it("keeps deletion metadata and does not touch bytes when the claim response is ambiguous", async () => {
    vi.spyOn(test.remote, "claim").mockImplementation(async () => {
      test.events.push("claim-remote");
      throw new TypeError("claim response lost");
    });
    const removeRemote = vi.spyOn(test.remote, "remove");
    const removeLocal = vi.spyOn(test.local, "remove");
    const cancel = vi.spyOn(test.local, "cancelCleanup");

    await expect(test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    })).resolves.toBeUndefined();
    expect(removeRemote).not.toHaveBeenCalled();
    expect(removeLocal).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(test.events).not.toContain("restore-metadata");
    expect(test.current().goals).toHaveLength(0);
  });

  it("does not overwrite unrelated edits while compensating a definitive referenced claim", async () => {
    vi.spyOn(test.remote, "claim").mockImplementation(async () => {
      test.events.push("claim-remote");
      return "referenced";
    });
    vi.spyOn(test.metadata, "restoreWorkspace").mockReturnValue(false);

    const result = test.actions.deleteGoal({
      goalId: GOAL_ID,
      scope: operationScope,
    });
    await expect(result).rejects.toBeInstanceOf(EvidenceCompensationError);
    await expect(result).rejects.toMatchObject({
      rollbackFailures: [expect.objectContaining({
        message: expect.stringMatching(/unrelated edits were preserved/i),
      })],
    });
    expect(test.events).not.toContain("remove-remote");
    expect(test.events).not.toContain("remove-local");
    expect(test.current().goals).toHaveLength(0);
  });
});
