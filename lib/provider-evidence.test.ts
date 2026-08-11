import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import { decodeLegacyGoalEvidence } from "@/lib/goal-evidence";
import {
  externalizeEmbeddedEvidence,
  externalizeWorkspaceHistory,
  portableWorkspaceState,
  remoteEvidencePath,
  rollbackEvidenceWrites,
  rollbackExternalizedEvidence,
} from "@/lib/provider-evidence";
import { cloneWorkspaceValue } from "@/lib/provider-state";
import type { GoalEvidence, GoalFileEvidence } from "@/lib/types";
import {
  createWorkspaceOperationCoordinator,
  WorkspaceOperationStartRejectedError,
} from "@/lib/workspace-operation-coordinator";
import { workspaceScopeKeyFromDecimal } from "@/lib/workspace-scope";

const SCOPE_GENERATION = 7;
const workspaceScope = (value: number) => workspaceScopeKeyFromDecimal(String(value));

const {
  stageEvidenceBlob,
  rollbackStagedEvidenceBlob,
} = vi.hoisted(() => ({
  stageEvidenceBlob: vi.fn(),
  rollbackStagedEvidenceBlob: vi.fn(),
}));

vi.mock("@/lib/persistence", () => ({
  stageEvidenceBlob,
  rollbackStagedEvidenceBlob,
}));

const EVIDENCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fileEvidence(path: string): GoalFileEvidence {
  return {
    id: EVIDENCE_ID,
    type: "file",
    name: "proof.pdf",
    mimeType: "application/pdf",
    size: 120,
    remotePath: path,
  };
}

function stateWithEvidence(evidence: GoalEvidence[]) {
  const state = cloneWorkspaceValue(EMPTY_STATE);
  state.goals = [{
    id: "goal-one",
    title: "Proof",
    description: "",
    areaId: "area-growth",
    model: "open",
    priority: "medium",
    status: "active",
    createdAt: "2026-07-18T12:00:00.000Z",
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

describe("owned remote evidence paths", () => {
  it("accepts only the exact signed-in account, goal, and evidence prefix", () => {
    const validPath = `user-a/goal-1/${EVIDENCE_ID}/proof.pdf`;
    const value = fileEvidence(validPath);

    expect(remoteEvidencePath(value, "user-a", "goal-1")).toBe(validPath);
    expect(remoteEvidencePath(value, "user-b", "goal-1")).toBeUndefined();
    expect(remoteEvidencePath(value, "user-a", "goal-2")).toBeUndefined();
    expect(remoteEvidencePath({
      ...value,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }, "user-a", "goal-1")).toBeUndefined();
  });

  it("rejects nested, encoded, and traversal-like paths", () => {
    expect(remoteEvidencePath(fileEvidence(
      `user-a/goal-1/${EVIDENCE_ID}/folder/proof.pdf`,
    ), "user-a", "goal-1")).toBeUndefined();
    expect(remoteEvidencePath(fileEvidence(
      `user-a/goal-1/${EVIDENCE_ID}/..`,
    ), "user-a", "goal-1")).toBeUndefined();
    expect(remoteEvidencePath(fileEvidence(
      `user-a/goal-1/${EVIDENCE_ID}/%2e%2e`,
    ), "user-a", "goal-1")).toBeUndefined();
  });
});

describe("portable workspace backups", () => {
  it("removes account-bound remote paths without mutating the live workspace", () => {
    const remotePath = `user-a/goal-one/${EVIDENCE_ID}/proof.pdf`;
    const source = stateWithEvidence([
      fileEvidence(remotePath),
      { id: "note-one", type: "note", text: "Context" },
    ]);

    const portable = portableWorkspaceState(source);

    expect(portable.goals[0].evidence).toEqual([
      {
        id: EVIDENCE_ID,
        type: "file",
        name: "proof.pdf",
        mimeType: "application/pdf",
        size: 120,
      },
      { id: "note-one", type: "note", text: "Context" },
    ]);
    expect(source.goals[0].evidence[0]).toMatchObject({ remotePath });
  });
});

describe("embedded evidence externalization", () => {
  beforeEach(() => {
    let writeSequence = 0;
    stageEvidenceBlob.mockReset();
    stageEvidenceBlob.mockImplementation(async (
      input: Record<string, unknown>,
    ) => {
      writeSequence += 1;
      return {
        token: `00000000-0000-4000-8000-${String(writeSequence).padStart(12, "0")}`,
        record: {
          ...input,
          savedAt: input.savedAt ?? `2026-07-19T12:00:00.${String(writeSequence).padStart(3, "0")}Z`,
        },
      };
    });
    rollbackStagedEvidenceBlob.mockReset();
    rollbackStagedEvidenceBlob.mockResolvedValue("rolled-back");
  });

  it("stores legacy bytes under the migrated id and removes the data payload", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;
    const state = stateWithEvidence([decoded.evidence]);

    const result = await externalizeEmbeddedEvidence(state, "anonymous", SCOPE_GENERATION);

    expect(result.changed).toBe(true);
    expect(stageEvidenceBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "anonymous",
        goalId: "goal-one",
        evidenceId: decoded.evidence.id,
      }),
      SCOPE_GENERATION,
    );
    expect(result.state.goals[0].evidence[0]).toEqual({
      id: decoded.evidence.id,
      type: "file",
      name: "proof.txt",
      mimeType: "text/plain",
      size: 5,
    });
    expect(JSON.stringify(result.state)).not.toContain("data:text/plain");
    expect(JSON.stringify(state)).toContain("data:text/plain");
  });

  it("decodes charset data URLs without using fetch, so production CSP remains strict", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be used for data URLs");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;charset=utf-8,proof",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;

    await expect(externalizeEmbeddedEvidence(
      stateWithEvidence([decoded.evidence]),
      "anonymous",
      SCOPE_GENERATION,
    )).resolves.toMatchObject({ changed: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("externalizes retained undo history and never leaves embedded bytes in the result", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;
    const current = stateWithEvidence([decoded.evidence]);
    const history = cloneWorkspaceValue(current);

    const result = await externalizeWorkspaceHistory(
      current,
      [history],
      "anonymous",
      SCOPE_GENERATION,
    );

    expect(result.changed).toBe(true);
    expect(result.history).toHaveLength(1);
    expect(JSON.stringify(result.state)).not.toContain("data:text/plain");
    expect(JSON.stringify(result.history)).not.toContain("data:text/plain");
    expect(stageEvidenceBlob).toHaveBeenCalledTimes(2);
  });

  it("rolls back only the opaque staging token and never touches a live value", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;
    const state = stateWithEvidence([decoded.evidence]);

    const result = await externalizeEmbeddedEvidence(state, "anonymous", SCOPE_GENERATION);
    await rollbackExternalizedEvidence(result);

    expect(rollbackStagedEvidenceBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        token: expect.any(String),
        record: expect.objectContaining({ evidenceId: decoded.evidence.id }),
      }),
      SCOPE_GENERATION,
    );
  });

  it("counts an already-absent staging token as successful idempotent compensation", async () => {
    rollbackStagedEvidenceBlob.mockResolvedValueOnce("already-absent");

    await expect(rollbackEvidenceWrites([{
      token: "00000000-0000-4000-8000-000000000099",
      record: {
        accountId: "anonymous",
        goalId: "goal-one",
        evidenceId: EVIDENCE_ID,
        blob: new Blob(["proof"], { type: "text/plain" }),
        savedAt: "2026-07-19T12:00:00.000Z",
      },
      scopeGeneration: SCOPE_GENERATION,
    }])).resolves.toEqual({ rolledBack: 0, alreadyAbsent: 1 });
  });

  it("leaves notes and already-external file references unchanged", async () => {
    const remotePath = `anonymous/goal-one/${EVIDENCE_ID}/proof.pdf`;
    const source = stateWithEvidence([
      { id: "note-one", type: "note", text: "Context" },
      fileEvidence(remotePath),
    ]);

    const result = await externalizeEmbeddedEvidence(
      source,
      "anonymous",
      SCOPE_GENERATION,
    );

    expect(result).toMatchObject({ changed: false, createdEvidence: [] });
    expect(result.state.goals[0].evidence).toEqual(source.goals[0].evidence);
    expect(stageEvidenceBlob).not.toHaveBeenCalled();
  });

  it("rejects embedded bytes whose decoded metadata no longer matches", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid" || decoded.evidence.type !== "file") return;
    const mismatched = { ...decoded.evidence, size: decoded.evidence.size + 1 };

    await expect(externalizeEmbeddedEvidence(
      stateWithEvidence([mismatched]),
      "anonymous",
      SCOPE_GENERATION,
    )).rejects.toThrow(/did not match/i);
    expect(stageEvidenceBlob).not.toHaveBeenCalled();
  });

  it("retains an existing private path while externalizing embedded bytes", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid" || decoded.evidence.type !== "file") return;
    const remotePath = `anonymous/goal-one/${decoded.evidence.id}/proof.txt`;

    const result = await externalizeEmbeddedEvidence(
      stateWithEvidence([{ ...decoded.evidence, remotePath }]),
      "anonymous",
      SCOPE_GENERATION,
    );

    expect(result.state.goals[0].evidence[0]).toMatchObject({ remotePath });
  });

  it("rolls back earlier snapshots when a later history migration fails", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;
    stageEvidenceBlob
      .mockResolvedValueOnce({
        token: "00000000-0000-4000-8000-000000000001",
        record: {
          accountId: "anonymous",
          goalId: "goal-one",
          evidenceId: decoded.evidence.id,
          blob: new Blob(["proof"], { type: "text/plain" }),
          savedAt: "2026-07-19T12:00:00.000Z",
        },
      })
      .mockRejectedValueOnce(new Error("quota exhausted"));

    await expect(externalizeWorkspaceHistory(
      stateWithEvidence([decoded.evidence]),
      [stateWithEvidence([decoded.evidence])],
      "anonymous",
      SCOPE_GENERATION,
    )).rejects.toThrow(/quota exhausted/i);
    expect(rollbackStagedEvidenceBlob).toHaveBeenCalledWith(
      expect.objectContaining({ token: "00000000-0000-4000-8000-000000000001" }),
      SCOPE_GENERATION,
    );
  });

  it("preserves migration and rollback failures together", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;
    stageEvidenceBlob
      .mockResolvedValueOnce({
        token: "00000000-0000-4000-8000-000000000001",
        record: {
          accountId: "anonymous",
          goalId: "goal-one",
          evidenceId: decoded.evidence.id,
          blob: new Blob(["proof"], { type: "text/plain" }),
          savedAt: "2026-07-19T12:00:00.000Z",
        },
      })
      .mockRejectedValueOnce(new Error("quota exhausted"));
    rollbackStagedEvidenceBlob.mockRejectedValueOnce(new Error("rollback blocked"));

    const failure = await externalizeWorkspaceHistory(
      stateWithEvidence([decoded.evidence]),
      [stateWithEvidence([decoded.evidence])],
      "anonymous",
      SCOPE_GENERATION,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    const nested = failure as AggregateError;
    expect(JSON.stringify(nested.errors.map(String))).toMatch(/quota exhausted|rollback blocked/i);
  });

  it.each(["erasure", "account switch"])(
    "finishes token-only compensation before %s",
    async (boundary) => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;

    const stagedTokens = new Set<string>();
    const events: string[] = [];
    const beforeStage = deferred<void>();
    const allowStage = deferred<void>();
    const token = "00000000-0000-4000-8000-000000000042";
    stageEvidenceBlob.mockImplementation(async (input: Record<string, unknown>) => {
      events.push("stage-start");
      beforeStage.resolve();
      await allowStage.promise;
      stagedTokens.add(token);
      events.push("stage");
      return {
        token,
        record: {
          ...input,
          savedAt: "2026-07-19T12:00:00.000Z",
        },
      };
    });
    rollbackStagedEvidenceBlob.mockImplementation(async () => {
      events.push("rollback-stage");
      stagedTokens.delete(token);
      return "rolled-back";
    });

    const coordinator = createWorkspaceOperationCoordinator();
    let accountIsCurrent = true;
    const reconciliation = coordinator.run(workspaceScope(42), async () => {
      const migrated = await externalizeEmbeddedEvidence(
        stateWithEvidence([decoded.evidence]),
        "account-a",
        SCOPE_GENERATION,
      );
      if (!accountIsCurrent) await rollbackExternalizedEvidence(migrated);
    });

    await beforeStage.promise;
    accountIsCurrent = false;
    let boundaryFinished = false;
    const boundaryOperation = boundary === "erasure"
      ? coordinator.retire(workspaceScope(42)).then(() => {
          events.push("erase");
          boundaryFinished = true;
        })
      : coordinator.run(workspaceScope(42), async () => {
          events.push("switch");
          boundaryFinished = true;
        });

    await Promise.resolve();
    expect(boundaryFinished).toBe(false);
    await expect(coordinator.run(
      workspaceScope(42),
      async () => undefined,
      () => accountIsCurrent,
    )).rejects.toBeInstanceOf(
      WorkspaceOperationStartRejectedError,
    );

    allowStage.resolve();
    await reconciliation;
    await boundaryOperation;

    expect(stagedTokens.size).toBe(0);
    expect(events.at(-1)).toBe(boundary === "erasure" ? "erase" : "switch");
    expect(events).toContain("rollback-stage");
  });
});
