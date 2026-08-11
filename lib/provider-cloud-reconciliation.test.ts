import { describe, expect, it, vi } from "vitest";
import {
  planProviderAccountHandoff,
  runProviderCloudReconciliation,
  type ProviderReconciliationBoundary,
  type ProviderReconciliationCurrentness,
  type ProviderReconciliationPorts,
} from "@/lib/provider-cloud-reconciliation";
import { parseWorkspaceRevision } from "@/lib/sync-reconciliation";

interface TestState {
  readonly version: number;
  readonly value: string;
}

interface TestEvidence {
  readonly path: string;
}

type TestBoundary = ProviderReconciliationBoundary<string, number>;
type TestPorts = ProviderReconciliationPorts<
  TestState,
  TestEvidence,
  string,
  number
>;

const UPDATED_AT = "2026-07-29T12:00:00.000Z";

function boundary(
  overrides: Partial<TestBoundary> = {},
): TestBoundary {
  return {
    accountId: "account-a",
    persistenceAccountId: "account-a",
    workspaceGeneration: "generation-7",
    workspaceScopeKey: "scope-11",
    persistenceGeneration: 4,
    ...overrides,
  };
}

function local(
  overrides: Partial<ReturnType<TestPorts["readLocal"]>> = {},
): ReturnType<TestPorts["readLocal"]> {
  return {
    state: { version: 3, value: "device" },
    revision: 8,
    dirty: false,
    changeVersion: 13,
    ...overrides,
  };
}

function ports(overrides: Partial<TestPorts> = {}): TestPorts {
  return {
    inspectCurrentness: () => ({ current: true }),
    readLocal: () => local(),
    fetchRemote: async () => ({
      data: {
        state: { version: 3, value: "cloud" },
        revision: 9,
        updated_at: UPDATED_AT,
      },
      error: null,
    }),
    saveSnapshot: async (state, expectedRevision) => ({
      data: [{
        state,
        revision: expectedRevision + 1,
        updated_at: UPDATED_AT,
      }],
      error: null,
    }),
    migrateState: (stored) => stored as TestState,
    prepareEvidence: async (state) => ({
      state,
      changed: false,
      createdEvidence: [],
    }),
    rollbackEvidence: async () => undefined,
    statesEqual: (left, right) => (
      JSON.stringify(left) === JSON.stringify(right)
    ),
    parseRevision: parseWorkspaceRevision,
    isRevisionConflict: (error) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "PT409"
    ),
    readStoredStateVersion: (stored) => (
      typeof stored === "object" && stored !== null && "version" in stored
        ? stored.version
        : undefined
    ),
    currentStateVersion: 3,
    now: () => UPDATED_AT,
    onPhase: () => undefined,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("provider cloud reconciliation boundary", () => {
  it("does not read cloud data after the captured account boundary is stale", async () => {
    const fetchRemote = vi.fn<TestPorts["fetchRemote"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        inspectCurrentness: () => ({
          current: false,
          reason: "account",
        }),
        fetchRemote,
      }),
    )).resolves.toEqual({
      kind: "superseded",
      phase: "preflight",
      reason: "account",
    });
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it("ignores a late fetch response after handoff begins", async () => {
    const pending = deferred<{
      data: {
        state: TestState;
        revision: number;
        updated_at: string;
      };
      error: null;
    }>();
    let currentness: ProviderReconciliationCurrentness = { current: true };
    const prepareEvidence = vi.fn<TestPorts["prepareEvidence"]>();
    const outcome = runProviderCloudReconciliation(
      boundary(),
      ports({
        fetchRemote: () => pending.promise,
        inspectCurrentness: () => currentness,
        prepareEvidence,
      }),
    );

    currentness = { current: false, reason: "handoff" };
    pending.resolve({
      data: {
        state: { version: 3, value: "cloud" },
        revision: 9,
        updated_at: UPDATED_AT,
      },
      error: null,
    });

    await expect(outcome).resolves.toEqual({
      kind: "superseded",
      phase: "fetch",
      reason: "handoff",
    });
    expect(prepareEvidence).not.toHaveBeenCalled();
  });

  it("rolls back staged evidence when the scope changes during preparation", async () => {
    let inspections = 0;
    const staged = [{ path: "account-a/goal/evidence" }];
    const rollbackEvidence = vi.fn<TestPorts["rollbackEvidence"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        inspectCurrentness: () => {
          inspections += 1;
          return inspections >= 3
            ? { current: false, reason: "scope" }
            : { current: true };
        },
        prepareEvidence: async (state) => ({
          state,
          changed: true,
          createdEvidence: staged,
        }),
        rollbackEvidence,
      }),
    )).resolves.toEqual({
      kind: "superseded",
      phase: "preparation",
      reason: "scope",
    });
    expect(rollbackEvidence).toHaveBeenCalledOnce();
    expect(rollbackEvidence).toHaveBeenCalledWith(staged);
  });
});

describe("provider cloud reconciliation outcomes", () => {
  it("creates the first snapshot and reports whether local state changed in flight", async () => {
    let current = local({
      revision: 0,
      dirty: false,
      changeVersion: 3,
    });
    const saveSnapshot = vi.fn<TestPorts["saveSnapshot"]>(
      async (state) => {
        current = { ...current, changeVersion: 4 };
        return {
          data: [{
            state,
            revision: 1,
            updated_at: UPDATED_AT,
          }],
          error: null,
        };
      },
    );
    const onPhase = vi.fn<TestPorts["onPhase"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        readLocal: () => current,
        fetchRemote: async () => ({ data: null, error: null }),
        saveSnapshot,
        onPhase,
      }),
    )).resolves.toMatchObject({
      kind: "saved-local",
      localUnchanged: false,
      remote: { revision: 1 },
    });
    expect(saveSnapshot).toHaveBeenCalledWith(current.state, 0);
    expect(onPhase.mock.calls.map(([phase]) => phase))
      .toEqual(["connecting", "saving"]);
  });

  it("rejects malformed revisions without preparing or overwriting either copy", async () => {
    const prepareEvidence = vi.fn<TestPorts["prepareEvidence"]>();
    const saveSnapshot = vi.fn<TestPorts["saveSnapshot"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        fetchRemote: async () => ({
          data: {
            state: { version: 3, value: "cloud" },
            revision: "bad",
            updated_at: UPDATED_AT,
          },
          error: null,
        }),
        prepareEvidence,
        saveSnapshot,
      }),
    )).resolves.toEqual({
      kind: "invalid-revision",
      phase: "initial",
      source: "remote",
    });
    expect(prepareEvidence).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it("uploads dirty device state at the matching revision after compensating cloud evidence", async () => {
    const staged = [{ path: "prepared/cloud-file" }];
    const calls: string[] = [];

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        readLocal: () => local({ dirty: true, revision: 9 }),
        prepareEvidence: async (state) => ({
          state,
          changed: true,
          createdEvidence: staged,
        }),
        rollbackEvidence: async () => {
          calls.push("rollback");
        },
        saveSnapshot: async (state, expectedRevision) => {
          calls.push("save");
          return {
            data: [{
              state,
              revision: expectedRevision + 1,
              updated_at: UPDATED_AT,
            }],
            error: null,
          };
        },
      }),
    )).resolves.toMatchObject({
      kind: "saved-local",
      localUnchanged: true,
      remote: { revision: 10 },
    });
    expect(calls).toEqual(["rollback", "save"]);
  });

  it("retains prepared evidence when divergent dirty state becomes an explicit conflict", async () => {
    const staged = [{ path: "prepared/cloud-file" }];
    const rollbackEvidence = vi.fn<TestPorts["rollbackEvidence"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        readLocal: () => local({ dirty: true, revision: 8 }),
        prepareEvidence: async (state) => ({
          state,
          changed: false,
          createdEvidence: staged,
        }),
        rollbackEvidence,
      }),
    )).resolves.toMatchObject({
      kind: "conflict",
      remote: {
        revision: 9,
        createdEvidence: staged,
      },
    });
    expect(rollbackEvidence).not.toHaveBeenCalled();
  });

  it("adopts a clean validated remote and retains its prepared evidence", async () => {
    const staged = [{ path: "prepared/cloud-file" }];
    const rollbackEvidence = vi.fn<TestPorts["rollbackEvidence"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        prepareEvidence: async (state) => ({
          state,
          changed: false,
          createdEvidence: staged,
        }),
        rollbackEvidence,
      }),
    )).resolves.toEqual({
      kind: "adopt-remote",
      remote: {
        state: { version: 3, value: "cloud" },
        revision: 9,
        updatedAt: UPDATED_AT,
        needsSave: false,
        createdEvidence: staged,
      },
    });
    expect(rollbackEvidence).not.toHaveBeenCalled();
  });

  it("returns a migrated remote for an atomic local commit before any cloud save", async () => {
    const current = local();
    const staged = [{ path: "prepared/cloud-file" }];
    const rollbackEvidence = vi.fn<TestPorts["rollbackEvidence"]>();
    const saveSnapshot = vi.fn<TestPorts["saveSnapshot"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        readLocal: () => current,
        prepareEvidence: async (state) => ({
          state: { ...state, version: 3 },
          changed: true,
          createdEvidence: staged,
        }),
        saveSnapshot,
        rollbackEvidence,
      }),
    )).resolves.toMatchObject({
      kind: "adopt-remote",
      remote: {
        revision: 9,
        needsSave: true,
        createdEvidence: staged,
      },
    });
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(rollbackEvidence).not.toHaveBeenCalled();
  });

  it("does not expose stripped cloud JSON before migrated bytes commit locally", async () => {
    const staged = [{ path: "prepared/cloud-file" }];
    const migrated = { version: 3, value: "cloud" };
    let remote = {
      state: { version: 2, value: "cloud" },
      revision: 9,
      updated_at: UPDATED_AT,
    };
    const fetchRemote = vi.fn<TestPorts["fetchRemote"]>(async () => ({
      data: remote,
      error: null,
    }));
    const rollbackEvidence = vi.fn<TestPorts["rollbackEvidence"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        fetchRemote,
        prepareEvidence: async () => ({
          state: migrated,
          changed: true,
          createdEvidence: staged,
        }),
        saveSnapshot: async (state, expectedRevision) => {
          // The compare-and-swap commits, but the browser never receives the
          // response. The authoritative reread must prove that exact write
          // before reconciliation can adopt it.
          remote = {
            state,
            revision: expectedRevision + 1,
            updated_at: UPDATED_AT,
          };
          throw new TypeError("response lost after commit");
        },
        rollbackEvidence,
      }),
    )).resolves.toEqual({
      kind: "adopt-remote",
      remote: {
        state: migrated,
        revision: 9,
        updatedAt: UPDATED_AT,
        needsSave: true,
        createdEvidence: staged,
      },
    });
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(rollbackEvidence).not.toHaveBeenCalled();
  });

  it("retains migrated evidence without attempting a premature cloud save", async () => {
    const staged = [{ path: "prepared/cloud-file" }];
    const transportError = new TypeError("response lost");
    const rollbackEvidence = vi.fn<TestPorts["rollbackEvidence"]>();

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        fetchRemote: async () => ({
          data: {
            state: { version: 2, value: "cloud" },
            revision: 9,
            updated_at: UPDATED_AT,
          },
          error: null,
        }),
        prepareEvidence: async () => ({
          state: { version: 3, value: "cloud" },
          changed: true,
          createdEvidence: staged,
        }),
        saveSnapshot: async () => {
          throw transportError;
        },
        rollbackEvidence,
      }),
    )).resolves.toEqual({
      kind: "adopt-remote",
      remote: {
        state: { version: 3, value: "cloud" },
        revision: 9,
        updatedAt: UPDATED_AT,
        needsSave: true,
        createdEvidence: staged,
      },
    });
    expect(rollbackEvidence).not.toHaveBeenCalled();
  });

  it("treats a status-zero save error as transport-ambiguous", async () => {
    const transportError = new TypeError("request aborted");

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        fetchRemote: async () => ({ data: null, error: null }),
        saveSnapshot: async () => ({
          data: null,
          error: transportError,
          status: 0,
        }),
      }),
    )).resolves.toEqual({
      kind: "ambiguous-save",
      error: transportError,
    });
  });

  it("acknowledges an exact newer cloud copy of a dirty device snapshot", async () => {
    const same = { version: 3, value: "same" };

    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        readLocal: () => local({
          state: same,
          dirty: true,
          revision: 8,
        }),
        fetchRemote: async () => ({
          data: {
            state: same,
            revision: 9,
            updated_at: UPDATED_AT,
          },
          error: null,
        }),
      }),
    )).resolves.toMatchObject({
      kind: "acknowledged",
      remote: {
        state: same,
        revision: 9,
      },
    });
  });

  it("distinguishes preparation, read, revision-conflict, and ordinary failures", async () => {
    const preparationError = new Error("file migration failed");
    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        prepareEvidence: async () => {
          throw preparationError;
        },
      }),
    )).resolves.toEqual({
      kind: "preparation-error",
      error: preparationError,
    });

    const readError = new Error("read unavailable");
    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        fetchRemote: async () => ({ data: null, error: readError }),
      }),
    )).resolves.toEqual({
      kind: "remote-read-error",
      error: readError,
    });

    const conflict = { code: "PT409" };
    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        fetchRemote: async () => ({ data: null, error: null }),
        saveSnapshot: async () => {
          throw conflict;
        },
      }),
    )).resolves.toEqual({
      kind: "revision-conflict",
      error: conflict,
    });

    const ordinary = new Error("save unavailable");
    await expect(runProviderCloudReconciliation(
      boundary(),
      ports({
        fetchRemote: async () => ({ data: null, error: null }),
        saveSnapshot: async () => ({
          data: null,
          error: ordinary,
          status: 503,
        }),
      }),
    )).resolves.toEqual({
      kind: "error",
      error: ordinary,
    });
  });
});

describe("provider account handoff planning", () => {
  it("maps every explicit choice to a ready source plan", () => {
    expect(planProviderAccountHandoff({
      choice: "device",
      localExists: false,
      localDirty: false,
      remoteExists: false,
      targetWasQuarantined: false,
    })).toEqual({
      kind: "ready",
      handoff: {
        action: "copy-anonymous",
        sourceAccountId: "anonymous",
      },
      source: { action: "use-empty", remoteRevision: 0 },
    });
    expect(planProviderAccountHandoff({
      choice: "merge",
      localExists: true,
      localDirty: false,
      localRevision: 2,
      remoteExists: true,
      remoteRevision: 7,
      targetWasQuarantined: false,
    })).toMatchObject({
      kind: "ready",
      handoff: { action: "merge-anonymous" },
      source: { action: "use-cloud", remoteRevision: 7 },
    });
  });

  it("halts before handoff writes for invalid, divergent, or unrecoverable sources", () => {
    expect(planProviderAccountHandoff({
      choice: "device",
      localExists: true,
      localDirty: true,
      localRevision: "bad",
      remoteExists: false,
      targetWasQuarantined: false,
    })).toEqual({
      kind: "invalid-revision",
      source: "local",
    });
    expect(planProviderAccountHandoff({
      choice: "merge",
      localExists: true,
      localDirty: true,
      localRevision: 4,
      remoteExists: true,
      remoteRevision: 5,
      targetWasQuarantined: false,
    })).toEqual({
      kind: "source-conflict",
      localRevision: 4,
      remoteRevision: 5,
    });
    expect(planProviderAccountHandoff({
      choice: "account",
      localExists: true,
      localDirty: false,
      localRevision: 4,
      remoteExists: false,
      targetWasQuarantined: true,
    })).toEqual({
      kind: "quarantined-account-missing-cloud",
    });
  });
});
