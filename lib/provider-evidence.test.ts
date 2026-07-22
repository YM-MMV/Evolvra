import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import { decodeLegacyGoalEvidence } from "@/lib/goal-evidence";
import {
  externalizeEmbeddedEvidence,
  externalizeWorkspaceHistory,
  portableWorkspaceState,
  remoteEvidencePath,
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

const { storeEvidenceBlob, readEvidenceBlob, deleteEvidenceBlob } = vi.hoisted(() => ({
  storeEvidenceBlob: vi.fn(async (input: Record<string, unknown>) => input),
  readEvidenceBlob: vi.fn(async () => null as null | Record<string, unknown>),
  deleteEvidenceBlob: vi.fn(async () => undefined),
}));

vi.mock("@/lib/persistence", () => ({
  storeEvidenceBlob,
  readEvidenceBlob,
  deleteEvidenceBlob,
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
    storeEvidenceBlob.mockReset();
    storeEvidenceBlob.mockImplementation(async (input: Record<string, unknown>) => input);
    readEvidenceBlob.mockReset();
    readEvidenceBlob.mockResolvedValue(null);
    deleteEvidenceBlob.mockReset();
    deleteEvidenceBlob.mockResolvedValue(undefined);
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
    expect(storeEvidenceBlob).toHaveBeenCalledWith(
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
    expect(storeEvidenceBlob).toHaveBeenCalledTimes(2);
  });

  it("restores a pre-existing blob instead of deleting it when staging is rolled back", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;
    const existing = {
      accountId: "anonymous",
      goalId: "goal-one",
      evidenceId: decoded.evidence.id,
      blob: new Blob(["older"], { type: "text/plain" }),
      savedAt: "2026-07-17T12:00:00.000Z",
    };
    readEvidenceBlob.mockResolvedValueOnce(existing);
    const state = stateWithEvidence([decoded.evidence]);

    const result = await externalizeEmbeddedEvidence(state, "anonymous", SCOPE_GENERATION);
    storeEvidenceBlob.mockClear();
    await rollbackExternalizedEvidence(result);

    expect(storeEvidenceBlob).toHaveBeenCalledWith(existing, SCOPE_GENERATION);
    expect(deleteEvidenceBlob).not.toHaveBeenCalled();
  });

  it("rolls back earlier snapshots when a later history migration fails", async () => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;
    storeEvidenceBlob
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("quota exhausted"));

    await expect(externalizeWorkspaceHistory(
      stateWithEvidence([decoded.evidence]),
      [stateWithEvidence([decoded.evidence])],
      "anonymous",
      SCOPE_GENERATION,
    )).rejects.toThrow(/quota exhausted/i);
    expect(deleteEvidenceBlob).toHaveBeenCalledWith(
      "anonymous",
      "goal-one",
      decoded.evidence.id,
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
    storeEvidenceBlob
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("quota exhausted"));
    deleteEvidenceBlob.mockRejectedValueOnce(new Error("rollback blocked"));

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

  it.each([
    ["erasure", "a pre-existing blob", true],
    ["erasure", "a newly-created blob", false],
    ["account switch", "a pre-existing blob", true],
    ["account switch", "a newly-created blob", false],
  ])("finishes compensation before %s after pausing before replacing %s", async (boundary, _label, hasPrevious) => {
    const decoded = decodeLegacyGoalEvidence(
      "file|proof.txt|data:text/plain;base64,cHJvb2Y=",
      "goal-one",
      0,
    );
    expect(decoded.status).toBe("valid");
    if (decoded.status !== "valid") return;

    const key = `account-a/goal-one/${decoded.evidence.id}`;
    const blobs = new Map<string, Record<string, unknown>>();
    const events: string[] = [];
    const beforePut = deferred<void>();
    const allowPut = deferred<void>();
    const previous = {
      accountId: "account-a",
      goalId: "goal-one",
      evidenceId: decoded.evidence.id,
      blob: new Blob(["previous"], { type: "text/plain" }),
      savedAt: "2026-07-17T12:00:00.000Z",
    };
    if (hasPrevious) blobs.set(key, previous);

    readEvidenceBlob.mockImplementation(async () => {
      events.push("read");
      return blobs.get(key) ?? null;
    });
    storeEvidenceBlob.mockImplementation(async (input: Record<string, unknown>) => {
      if (!("savedAt" in input)) {
        events.push("put-start");
        beforePut.resolve();
        await allowPut.promise;
        events.push("put");
      } else {
        events.push("rollback-store");
      }
      blobs.set(key, {
        ...input,
        savedAt: input.savedAt ?? "2026-07-19T12:00:00.000Z",
      });
      return input;
    });
    deleteEvidenceBlob.mockImplementation(async () => {
      events.push("rollback-delete");
      blobs.delete(key);
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

    await beforePut.promise;
    accountIsCurrent = false;
    let boundaryFinished = false;
    const boundaryOperation = boundary === "erasure"
      ? coordinator.retire(workspaceScope(42)).then(() => {
          events.push("erase");
          blobs.clear();
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

    allowPut.resolve();
    await reconciliation;
    await boundaryOperation;

    expect(blobs.size).toBe(boundary === "erasure" || !hasPrevious ? 0 : 1);
    expect(events.at(-1)).toBe(boundary === "erasure" ? "erase" : "switch");
    expect(events).toContain(hasPrevious ? "rollback-store" : "rollback-delete");
  });
});
