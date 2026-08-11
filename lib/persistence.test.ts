import { describe, expect, it } from "vitest";
import { createStarterGoals, DEFAULT_AREAS, DEFAULT_STATS } from "@/lib/defaults";
import {
  applyAccountHandoffPersistence,
  cleanupAbandonedEvidenceStaging,
  deleteAccountPersistenceAtRevision,
  deleteEvidenceBlob,
  LocalWorkspaceConflictError,
  PersistenceError,
  cancelUnstartedAccountErasurePersistenceFence,
  evidenceKey,
  hasIndexedDbSupport,
  isEvidenceBlobRecord,
  isWorkspaceEnvelope,
  parseLegacyWorkspaceImportJournal,
  prepareLegacyWorkspaceImportCapture,
  prepareLegacyWorkspaceImportCommit,
  prepareLegacyWorkspaceImportDisable,
  preparePortableArchiveWorkspaceWrite,
  prepareWorkspaceWrite,
  privacySafeWorkspaceExport,
  readAccountPersistenceBackupBoundary,
  readEvidenceBlob,
  listEvidenceCleanupIntents,
  markEvidenceCleanupRemoteComplete,
  recoverLocalEvidenceCleanupIntents,
  readWorkspace,
  requireAccountErasureWorkspaceRevision,
  recoverEvidenceBlobRecord,
  recoverWorkspaceEnvelope,
  serializeEvidenceBlobRecord,
  stageEvidenceBlob,
  stageEvidenceCleanupIntent,
  storeEvidenceBlob,
  rollbackStagedEvidenceBlob,
  restoreEvidenceBlobs,
  writeWorkspace,
  workspaceEnvelopeContentsEqual,
  workspaceKey,
  type WorkspaceEnvelope,
} from "@/lib/persistence";
import type { AppState } from "@/lib/types";
import { MAX_UNDO_HISTORY_ITEMS } from "@/lib/provider-state";

const state: AppState = {
  version: 3,
  updatedAt: "2026-07-18T12:00:00.000Z",
  profile: {
    displayName: "Explorer",
    chapter: "Build carefully",
    onboarded: true,
    createdAt: "2026-07-18T12:00:00.000Z",
  },
  settings: {
    theme: "dark",
    interfaceIntensity: "balanced",
    notifications: false,
    reminderTime: "18:00",
    dashboardOrder: ["hero", "overview", "due-now", "life-map", "momentum", "goals", "qualities", "review"],
    hiddenDashboardSections: [],
    terminology: {
      goals: "Goals",
      quests: "Quests",
      areas: "Areas",
      milestones: "Milestones",
      stats: "Stats",
    },
  },
  areas: [],
  stats: [],
  goals: [],
  questCompletions: [],
  metricEntries: [],
  reviews: [],
  timeline: [],
};

const envelope: WorkspaceEnvelope = {
  accountId: "account-1",
  state,
  history: [{ ...state }],
  dirty: true,
  localRevision: 4,
  revision: 3,
  serverUpdatedAt: "2026-07-18T11:59:00.000Z",
  savedAt: "2026-07-18T12:01:00.000Z",
};

interface AccountErasureIndexedDbFixture {
  workspaces: Map<string, unknown>;
  evidence: Map<string, unknown>;
  staging: Map<string, unknown>;
  scopes: Map<string, unknown>;
  checkpoints: Map<string, unknown>;
  close: () => void;
}

/** Minimal request/transaction fixture for the atomic account-fence tests. */
function installAccountErasureIndexedDb(): AccountErasureIndexedDbFixture {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const originalKeyRange = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
  const stores = new Map<string, Map<string, unknown>>([
    ["workspaces", new Map()],
    ["evidence", new Map()],
    ["evidence-staging", new Map()],
    ["account-scopes", new Map()],
    ["account-erasure-checkpoints", new Map()],
    ["account-reminders", new Map()],
    ["legacy-import-claims", new Map()],
  ]);
  let database: IDBDatabase | null = null;

  const objectStore = (
    name: string,
    transaction?: {
      pending: number;
      aborted: boolean;
      completionTimer?: ReturnType<typeof setTimeout>;
      oncomplete: ((event: Event) => void) | null;
    },
  ) => {
    const records = stores.get(name);
    if (!records) throw new Error(`Unknown fake object store: ${name}`);
    const storageKey = (key: IDBValidKey) => (
      name === "evidence" && Array.isArray(key)
        ? JSON.stringify(key)
        : String(key)
    );
    const valueKey = (value: Record<string, unknown>) => (
      name === "evidence"
        ? JSON.stringify([value.accountId, value.goalId, value.evidenceId])
        : name === "evidence-staging"
          ? String(value.token)
        : String(value.accountId)
    );
    const request = <T,>(operation: () => T): IDBRequest<T> => {
      const result = {} as IDBRequest<T>;
      if (transaction) {
        transaction.pending += 1;
        if (transaction.completionTimer) clearTimeout(transaction.completionTimer);
      }
      queueMicrotask(() => {
        if (transaction?.aborted) return;
        try {
          Object.defineProperty(result, "result", { value: operation() });
          result.onsuccess?.(new Event("success"));
        } catch (error) {
          Object.defineProperty(result, "error", { value: error });
          result.onerror?.(new Event("error"));
        } finally {
          if (transaction && !transaction.aborted) {
            transaction.pending -= 1;
            transaction.completionTimer = setTimeout(() => {
              if (!transaction.aborted && transaction.pending === 0) {
                transaction.oncomplete?.(new Event("complete"));
              }
            }, 0);
          }
        }
      });
      return result;
    };
    const cursorRequest = (
      entries: Array<[string, Record<string, unknown>]>,
    ): IDBRequest<IDBCursorWithValue | null> => {
      const result = {} as IDBRequest<IDBCursorWithValue | null>;
      let position = 0;
      if (transaction) {
        transaction.pending += 1;
        if (transaction.completionTimer) clearTimeout(transaction.completionTimer);
      }
      const finish = () => {
        if (!transaction || transaction.aborted) return;
        transaction.pending -= 1;
        transaction.completionTimer = setTimeout(() => {
          if (!transaction.aborted && transaction.pending === 0) {
            transaction.oncomplete?.(new Event("complete"));
          }
        }, 0);
      };
      const dispatch = () => queueMicrotask(() => {
        if (transaction?.aborted) return;
        const entry = entries[position];
        if (!entry) {
          Object.defineProperty(result, "result", {
            configurable: true,
            value: null,
          });
          result.onsuccess?.(new Event("success"));
          finish();
          return;
        }
        const [storedKey, value] = entry;
        const primaryKey = name === "evidence" ? JSON.parse(storedKey) : storedKey;
        const cursor = {
          value,
          primaryKey,
          key: primaryKey,
          continue: () => {
            position += 1;
            dispatch();
          },
          delete: () => request(() => {
            records.delete(storedKey);
            return undefined;
          }),
          update: (updated: Record<string, unknown>) => request(() => {
            records.set(storedKey, updated);
            return primaryKey;
          }),
        } as unknown as IDBCursorWithValue;
        Object.defineProperty(result, "result", {
          configurable: true,
          value: cursor,
        });
        result.onsuccess?.(new Event("success"));
      });
      dispatch();
      return result;
    };
    const queryValue = (query: unknown) => (
      query && typeof query === "object" && "__only" in query
        ? (query as { __only: unknown }).__only
        : query
    );
    const indexedEntries = (indexName: string, query: unknown) => {
      const expected = queryValue(query);
      return [...records.entries()].filter(([, raw]) => {
        if (!raw || typeof raw !== "object") return false;
        const record = raw as Record<string, unknown>;
        if (indexName === "by-account-goal") {
          return Array.isArray(expected)
            && record.accountId === expected[0]
            && record.goalId === expected[1];
        }
        return record.accountId === expected;
      }) as Array<[string, Record<string, unknown>]>;
    };
    return {
      indexNames: { contains: () => true },
      createIndex: () => undefined,
      openCursor: () => cursorRequest(
        [...records.entries()] as Array<[string, Record<string, unknown>]>,
      ),
      index: (indexName: string) => ({
        getAll: (query: unknown) => request(() =>
          indexedEntries(indexName, query).map(([, value]) => value)),
        openCursor: (query: unknown) => cursorRequest(
          indexedEntries(indexName, query),
        ),
      }),
      get: (key: IDBValidKey) => request(() => records.get(storageKey(key))),
      add: (value: Record<string, unknown>) => request(() => {
        const key = valueKey(value);
        if (records.has(key)) throw new Error("ConstraintError");
        records.set(key, value);
        return key;
      }),
      put: (value: Record<string, unknown>) => request(() => {
        const key = valueKey(value);
        records.set(key, value);
        return key;
      }),
      delete: (key: IDBValidKey) => request(() => {
        records.delete(storageKey(key));
        return undefined;
      }),
    } as unknown as IDBObjectStore;
  };

  const makeTransaction = (): IDBTransaction => {
    const state = {
      pending: 0,
      aborted: false,
      completionTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      oncomplete: null as ((event: Event) => void) | null,
      onabort: null as ((event: Event) => void) | null,
    };
    return {
      get oncomplete() { return state.oncomplete; },
      set oncomplete(value) { state.oncomplete = value; },
      get onabort() { return state.onabort; },
      set onabort(value) { state.onabort = value; },
      error: null,
      objectStore: (name: string) => objectStore(name, state),
      abort: () => {
        state.aborted = true;
        if (state.completionTimer) clearTimeout(state.completionTimer);
        queueMicrotask(() => state.onabort?.(new Event("abort")));
      },
    } as unknown as IDBTransaction;
  };

  const upgradeTransaction = {
    objectStore: (name: string) => objectStore(name),
  } as unknown as IDBTransaction;
  const fakeDatabase = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => objectStore(name),
    transaction: () => makeTransaction(),
    close: () => undefined,
    onversionchange: null,
  } as unknown as IDBDatabase;
  database = fakeDatabase;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const request = {
          result: fakeDatabase,
          transaction: upgradeTransaction,
          error: null,
          onupgradeneeded: null,
          onblocked: null,
          onerror: null,
          onsuccess: null,
        } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => {
          request.onupgradeneeded?.(new Event("upgradeneeded") as IDBVersionChangeEvent);
          queueMicrotask(() => request.onsuccess?.(new Event("success")));
        });
        return request;
      },
    },
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { only: (value: unknown) => ({ __only: value }) },
  });

  return {
    workspaces: stores.get("workspaces")!,
    evidence: stores.get("evidence")!,
    staging: stores.get("evidence-staging")!,
    scopes: stores.get("account-scopes")!,
    checkpoints: stores.get("account-erasure-checkpoints")!,
    close: () => {
      database?.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);
      if (original) Object.defineProperty(globalThis, "indexedDB", original);
      else Reflect.deleteProperty(globalThis, "indexedDB");
      if (originalKeyRange) Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
      else Reflect.deleteProperty(globalThis, "IDBKeyRange");
    },
  };
}

describe("persistence keys", () => {
  it("keeps evidence key parts separate without delimiter collisions", () => {
    expect(evidenceKey("account:one", "goal/two", "evidence|three")).toEqual([
      "account:one",
      "goal/two",
      "evidence|three",
    ]);
  });

  it("rejects blank or padded account identifiers explicitly", () => {
    for (const value of ["", "   ", " account-1 "]) {
      expect(() => workspaceKey(value)).toThrow(PersistenceError);
    }
  });
});

describe("account-erasure backup revision fence", () => {
  it("accepts only the exact persisted revision covered by the backup", () => {
    expect(requireAccountErasureWorkspaceRevision(
      envelope,
      "account-1",
      envelope.localRevision,
    )).toBe(envelope.localRevision);

    expect(() => requireAccountErasureWorkspaceRevision(
      { ...envelope, localRevision: envelope.localRevision + 1 },
      "account-1",
      envelope.localRevision,
    )).toThrow(LocalWorkspaceConflictError);
  });

  it("treats an absent workspace as revision zero and rejects malformed revisions", () => {
    expect(requireAccountErasureWorkspaceRevision(
      undefined,
      "account-1",
      0,
    )).toBe(0);
    expect(() => requireAccountErasureWorkspaceRevision(
      undefined,
      "account-1",
      -1,
    )).toThrow(PersistenceError);
  });
});

describe("atomic cancellation of an unstarted account erasure", () => {
  const timestamp = "2026-08-02T12:00:00.000Z";
  const pendingCheckpoint = {
    version: 2,
    accountId: "account-1",
    attemptId: "attempt-1",
    cloud: "failed",
    local: "pending",
    session: "pending",
    persistenceGeneration: 1,
    backup: { workspaceRevision: 4, evidenceRevision: 7 },
    owner: null,
    updatedAt: timestamp,
  };

  it("atomically removes the exact checkpoint and rotates to a fresh writable generation", async () => {
    const fixture = installAccountErasureIndexedDb();
    fixture.scopes.set("account-1", {
      accountId: "account-1",
      generation: 1,
      tombstoned: true,
      updatedAt: timestamp,
    });
    fixture.checkpoints.set("account-1", pendingCheckpoint);
    try {
      await expect(cancelUnstartedAccountErasurePersistenceFence(
        "account-1",
        1,
        "attempt-1",
      )).resolves.toMatchObject({
        accountId: "account-1",
        generation: 2,
        tombstoned: false,
      });
      expect(fixture.scopes.get("account-1")).toMatchObject({
        generation: 2,
        tombstoned: false,
      });
      expect(fixture.checkpoints.has("account-1")).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("keeps the fence and checkpoint when the attempt identifier is not exact", async () => {
    const fixture = installAccountErasureIndexedDb();
    const scope = {
      accountId: "account-1",
      generation: 1,
      tombstoned: true,
      updatedAt: timestamp,
    };
    fixture.scopes.set("account-1", scope);
    fixture.checkpoints.set("account-1", pendingCheckpoint);
    try {
      await expect(cancelUnstartedAccountErasurePersistenceFence(
        "account-1",
        1,
        "another-attempt",
      )).rejects.toMatchObject({ code: "invalid-data" });
      expect(fixture.scopes.get("account-1")).toEqual(scope);
      expect(fixture.checkpoints.get("account-1")).toEqual(pendingCheckpoint);
    } finally {
      fixture.close();
    }
  });

  it("rejects a stale generation without changing exact durable bookkeeping", async () => {
    const fixture = installAccountErasureIndexedDb();
    const scope = {
      accountId: "account-1",
      generation: 2,
      tombstoned: true,
      updatedAt: timestamp,
    };
    const checkpoint = {
      ...pendingCheckpoint,
      persistenceGeneration: 2,
    };
    fixture.scopes.set("account-1", scope);
    fixture.checkpoints.set("account-1", checkpoint);
    try {
      await expect(cancelUnstartedAccountErasurePersistenceFence(
        "account-1",
        1,
        "attempt-1",
      )).rejects.toMatchObject({ name: "AccountPersistenceScopeError" });
      expect(fixture.scopes.get("account-1")).toEqual(scope);
      expect(fixture.checkpoints.get("account-1")).toEqual(checkpoint);
    } finally {
      fixture.close();
    }
  });
});

describe("legacy workspace import journal", () => {
  const firstTimestamp = "2026-07-21T10:00:00.000Z";
  const secondTimestamp = "2026-07-21T10:01:00.000Z";

  it("durably models the first observed raw value as pending", () => {
    const raw = JSON.stringify({ profile: { displayName: "Legacy" } });

    expect(prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      raw,
      firstTimestamp,
    )).toEqual({
      accountId: "account-1",
      status: "pending",
      raw,
      capturedAt: firstTimestamp,
    });

    expect(prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      "",
      firstTimestamp,
    )).toMatchObject({ status: "pending", raw: "" });
  });

  it("makes racing tabs adopt the first pending raw value", () => {
    const first = prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      "first-tab-raw",
      firstTimestamp,
    );

    expect(prepareLegacyWorkspaceImportCapture(
      first,
      "account-1",
      "second-tab-raw",
      secondTimestamp,
    )).toBe(first);
    expect(prepareLegacyWorkspaceImportCapture(
      first,
      "account-1",
      null,
      secondTimestamp,
    )).toBe(first);
  });

  it("commits only a captured import and clears its raw data", () => {
    const pending = prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      "legacy-raw",
      firstTimestamp,
    );
    const committed = prepareLegacyWorkspaceImportCommit(
      pending,
      "account-1",
      secondTimestamp,
    );

    expect(committed).toEqual({
      accountId: "account-1",
      status: "committed",
      committedAt: secondTimestamp,
    });
    expect("raw" in committed).toBe(false);
    expect(prepareLegacyWorkspaceImportCapture(
      committed,
      "account-1",
      "late-copy",
      secondTimestamp,
    )).toBe(committed);
    expect(() => prepareLegacyWorkspaceImportCommit(
      undefined,
      "account-1",
      secondTimestamp,
    )).toThrow(PersistenceError);
  });

  it("closes an empty first observation without allowing a later import", () => {
    const committed = prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      null,
      firstTimestamp,
    );

    expect(committed).toEqual({
      accountId: "account-1",
      status: "committed",
      committedAt: firstTimestamp,
    });
    expect(prepareLegacyWorkspaceImportCapture(
      committed,
      "account-1",
      "appeared-later",
      secondTimestamp,
    )).toBe(committed);
  });

  it("recovers old one-shot claims conservatively", () => {
    const legacyClaim = {
      accountId: "account-1",
      claimedAt: firstTimestamp,
    };

    expect(prepareLegacyWorkspaceImportCapture(
      legacyClaim,
      "account-1",
      "still-in-local-storage",
      secondTimestamp,
    )).toEqual({
      accountId: "account-1",
      status: "pending",
      raw: "still-in-local-storage",
      capturedAt: secondTimestamp,
    });
    expect(prepareLegacyWorkspaceImportCapture(
      legacyClaim,
      "account-1",
      null,
      secondTimestamp,
    )).toEqual({
      accountId: "account-1",
      status: "committed",
      committedAt: firstTimestamp,
    });
    expect(parseLegacyWorkspaceImportJournal(legacyClaim, "account-1")).toEqual({
      accountId: "account-1",
      status: "committed",
      committedAt: firstTimestamp,
    });
  });

  it("keeps disabled terminal across capture, commit, and repeated disable", () => {
    const disabled = prepareLegacyWorkspaceImportDisable(
      undefined,
      "account-1",
      firstTimestamp,
    );

    expect(disabled).toEqual({
      accountId: "account-1",
      status: "disabled",
      disabledAt: firstTimestamp,
    });
    expect(prepareLegacyWorkspaceImportCapture(
      disabled,
      "account-1",
      "late-copy",
      secondTimestamp,
    )).toBe(disabled);
    expect(prepareLegacyWorkspaceImportCommit(disabled, "account-1", secondTimestamp)).toBe(disabled);
    expect(prepareLegacyWorkspaceImportDisable(disabled, "account-1", secondTimestamp)).toBe(disabled);
  });

  it("does not replace a completed import when disable is requested later", () => {
    const committed = {
      accountId: "account-1",
      status: "committed" as const,
      committedAt: firstTimestamp,
    };

    expect(prepareLegacyWorkspaceImportDisable(
      committed,
      "account-1",
      secondTimestamp,
    )).toBe(committed);
  });

  it("rejects malformed records everywhere except explicit disable repair", () => {
    const malformed = {
      accountId: "account-1",
      status: "pending",
      raw: "the-only-copy",
      capturedAt: "not-a-date",
    };

    expect(() => parseLegacyWorkspaceImportJournal(malformed, "account-1")).toThrow(PersistenceError);
    expect(() => prepareLegacyWorkspaceImportCapture(
      malformed,
      "account-1",
      "replacement",
      secondTimestamp,
    )).toThrow(PersistenceError);
    expect(() => prepareLegacyWorkspaceImportCommit(
      malformed,
      "account-1",
      secondTimestamp,
    )).toThrow(PersistenceError);
    expect(prepareLegacyWorkspaceImportDisable(
      malformed,
      "account-1",
      secondTimestamp,
    )).toEqual({
      accountId: "account-1",
      status: "disabled",
      disabledAt: secondTimestamp,
    });
  });

  it("rejects cross-account and non-canonical journal records", () => {
    expect(() => prepareLegacyWorkspaceImportCapture(
      {
        accountId: "account-2",
        status: "pending",
        raw: "other-account-copy",
        capturedAt: firstTimestamp,
      },
      "account-1",
      "replacement",
      secondTimestamp,
    )).toThrow(PersistenceError);
    expect(() => parseLegacyWorkspaceImportJournal({
      accountId: "account-1",
      status: "committed",
      committedAt: firstTimestamp,
      raw: "should-have-been-cleared",
    }, "account-1")).toThrow(PersistenceError);
  });
});

describe("workspace envelope validation", () => {
  it("accepts a complete account-scoped envelope", () => {
    expect(isWorkspaceEnvelope(envelope)).toBe(true);
  });

  it("rejects invalid revisions, dates, history, and state shapes", () => {
    expect(isWorkspaceEnvelope({ ...envelope, localRevision: -1 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, localRevision: 1.5 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, localRevision: undefined })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, revision: -1 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, revision: 1.5 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, savedAt: "not-a-date" })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, history: [{}] })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, state: { ...state, version: 1 } })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, state: { ...state, version: 2 } })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, dirty: "yes" })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, revision: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, serverUpdatedAt: "not-a-date" })).toBe(false);
  });

  it("normalizes legacy envelopes without a browser-local revision to zero", () => {
    const legacyEnvelope = { ...envelope } as Record<string, unknown>;
    delete legacyEnvelope.localRevision;

    expect(recoverWorkspaceEnvelope(legacyEnvelope, "account-1").localRevision).toBe(0);
  });

  it("validates transient recovery metadata when it is present", () => {
    expect(isWorkspaceEnvelope({
      ...envelope,
      recovery: {
        source: "history",
        recoveredFromHistoryIndex: 0,
        discardedHistoryEntries: 1,
        message: "A valid undo snapshot was restored.",
      },
    })).toBe(true);
    expect(isWorkspaceEnvelope({
      ...envelope,
      recovery: {
        source: "history",
        recoveredFromHistoryIndex: -1,
        discardedHistoryEntries: 1,
        message: "A valid undo snapshot was restored.",
      },
    })).toBe(false);
  });

  it("validates the exact anonymous revision already handled by an account", () => {
    expect(isWorkspaceEnvelope({
      ...envelope,
      anonymousHandoff: { generation: 2, localRevision: 7 },
    })).toBe(true);
    expect(isWorkspaceEnvelope({
      ...envelope,
      anonymousHandoff: { generation: -1, localRevision: 7 },
    })).toBe(false);
    expect(isWorkspaceEnvelope({
      ...envelope,
      anonymousHandoff: { generation: 2, localRevision: 1.5 },
    })).toBe(false);
  });

  it("accepts the exact undo-count boundary and rejects boundary plus one", () => {
    const history = Array.from({ length: MAX_UNDO_HISTORY_ITEMS }, (_, index) => ({
      ...state,
      updatedAt: `2026-07-18T12:00:${String(index).padStart(2, "0")}.000Z`,
    }));

    expect(isWorkspaceEnvelope({ ...envelope, history })).toBe(true);
    expect(isWorkspaceEnvelope({ ...envelope, history: [...history, state] })).toBe(false);
  });
});

describe("workspace recovery", () => {
  const snapshot = (updatedAt: string, displayName: string): AppState => ({
    ...state,
    updatedAt,
    profile: { ...state.profile, displayName },
  });

  it("restores the newest valid undo snapshot when the current state is damaged", () => {
    const older = snapshot("2026-07-18T09:00:00.000Z", "Older snapshot");
    const newest = snapshot("2026-07-18T10:00:00.000Z", "Newest snapshot");
    const recovered = recoverWorkspaceEnvelope({
      ...envelope,
      state: { ...state, profile: null },
      history: [older, { ...state, version: 1 }, newest],
    }, "account-1");

    expect(recovered.state.profile.displayName).toBe("Newest snapshot");
    expect(recovered.history[0]).toEqual(older);
    expect(recovered.history[1]).toMatchObject({ version: 3 });
    expect(recovered.dirty).toBe(false);
    expect(recovered.localRevision).toBe(envelope.localRevision);
    expect(recovered.revision).toBe(envelope.revision);
    expect(recovered.recovery).toMatchObject({
      source: "history",
      recoveredFromHistoryIndex: 2,
      discardedHistoryEntries: 1,
    });
    expect(recovered.recovery?.message).toMatch(/latest device workspace was damaged/i);
    expect(recovered.recovery?.message).toContain(newest.updatedAt);
  });

  it("keeps an intact current state while removing damaged undo entries", () => {
    const valid = snapshot("2026-07-18T09:00:00.000Z", "Valid undo");
    const recovered = recoverWorkspaceEnvelope({
      ...envelope,
      history: [{ nope: true }, valid],
    }, "account-1");

    expect(recovered.state).toEqual(state);
    expect(recovered.history).toEqual([valid]);
    expect(recovered.dirty).toBe(true);
    expect(recovered.recovery).toMatchObject({
      source: "current",
      discardedHistoryEntries: 1,
    });
  });

  it("restores strict-valid history instead of silently dropping malformed nested data", () => {
    const recoverable = {
      ...state,
      metricEntries: [{
        id: "entry-damaged",
        goalId: "goal-removed",
        metricId: "metric-removed",
        value: -10,
        previousValue: Number.NaN,
        recordedAt: state.updatedAt,
        source: "manual",
      }],
    };
    const recovered = recoverWorkspaceEnvelope({ ...envelope, state: recoverable }, "account-1");

    expect(recovered.state).toEqual(state);
    expect(recovered.dirty).toBe(false);
    expect(recovered.recovery).toMatchObject({ source: "history" });
  });

  it("migrates a valid v2 device snapshot to canonical v3 and marks it dirty", () => {
    const legacy = { ...state, version: 2 };
    const recovered = recoverWorkspaceEnvelope({
      ...envelope,
      state: legacy,
      history: [],
      dirty: false,
    }, "account-1");

    expect(recovered.state.version).toBe(3);
    expect(recovered.dirty).toBe(true);
    expect(recovered.recovery?.message).toMatch(/current snapshot was upgraded/i);
  });

  it("fails explicitly without overwriting when neither current nor history is usable", () => {
    expect(() => recoverWorkspaceEnvelope({
      ...envelope,
      state: { broken: true },
      history: [{ also: "broken" }],
    }, "account-1")).toThrow(/no valid undo snapshot.*nothing was overwritten/i);
  });

  it("quarantines a future current snapshot even when older history is valid", () => {
    const raw = {
      ...envelope,
      state: { ...state, version: 4 },
      history: [state],
    };
    const before = structuredClone(raw);

    expect(() => recoverWorkspaceEnvelope(raw, "account-1")).toThrow(
      /version 4.*newer.*nothing was overwritten/i,
    );
    expect(raw).toEqual(before);
  });

  it("retains only the newest bounded undo window from a legacy oversized history", () => {
    const history = Array.from({ length: MAX_UNDO_HISTORY_ITEMS + 2 }, (_, index) =>
      snapshot(`2026-07-18T10:00:${String(index).padStart(2, "0")}.000Z`, `Snapshot ${index}`));
    const recovered = recoverWorkspaceEnvelope({ ...envelope, history }, "account-1");

    expect(recovered.history).toHaveLength(MAX_UNDO_HISTORY_ITEMS);
    expect(recovered.history[0].profile.displayName).toBe("Snapshot 2");
    expect(recovered.history.at(-1)?.profile.displayName).toBe("Snapshot 11");
    expect(recovered.recovery?.discardedHistoryEntries).toBe(2);
  });

  it("never recovers data from a different account", () => {
    expect(() => recoverWorkspaceEnvelope(envelope, "account-2")).toThrow(/belongs to another account/i);
  });

  it("preserves a durable anonymous handoff acknowledgement during recovery", () => {
    const anonymousHandoff = { generation: 3, localRevision: 11 };
    expect(recoverWorkspaceEnvelope({
      ...envelope,
      anonymousHandoff,
    }, "account-1").anonymousHandoff).toEqual(anonymousHandoff);
  });
});

describe("workspace local compare-and-swap semantics", () => {
  it("treats write timestamps, transient recovery, and local revisions as the same content", () => {
    expect(workspaceEnvelopeContentsEqual(envelope, {
      ...envelope,
      localRevision: envelope.localRevision + 5,
      savedAt: "2026-07-18T13:00:00.000Z",
      recovery: {
        source: "current",
        discardedHistoryEntries: 1,
        message: "A damaged undo snapshot was removed.",
      },
    })).toBe(true);
  });

  it("detects persisted workspace changes", () => {
    expect(workspaceEnvelopeContentsEqual(envelope, {
      ...envelope,
      state: {
        ...envelope.state,
        profile: { ...envelope.state.profile, displayName: "Another tab" },
      },
    })).toBe(false);
  });

  it("treats a different anonymous handoff revision as persisted meaning", () => {
    expect(workspaceEnvelopeContentsEqual(
      { ...envelope, anonymousHandoff: { generation: 1, localRevision: 2 } },
      { ...envelope, anonymousHandoff: { generation: 1, localRevision: 3 } },
    )).toBe(false);
  });

  it("increments a matching revision and returns the stored copy for a same-content no-op", () => {
    const first = prepareWorkspaceWrite(null, { ...envelope, localRevision: 0 });
    expect(first).toMatchObject({ action: "write", envelope: { localRevision: 1 } });

    const noOp = prepareWorkspaceWrite(envelope, {
      ...envelope,
      localRevision: 1,
      savedAt: "2026-07-18T14:00:00.000Z",
    });
    expect(noOp).toEqual({ action: "no-op", envelope });
  });

  it("preserves the acknowledgement when an ordinary workspace save omits it", () => {
    const current = {
      ...envelope,
      anonymousHandoff: { generation: 2, localRevision: 8 },
    };
    const next = prepareWorkspaceWrite(current, {
      ...envelope,
      state: {
        ...envelope.state,
        profile: { ...envelope.state.profile, displayName: "Changed safely" },
      },
    });

    expect(next).toMatchObject({
      action: "write",
      envelope: {
        localRevision: envelope.localRevision + 1,
        anonymousHandoff: current.anonymousHandoff,
      },
    });
  });

  it("rejects stale changed content with the typed local conflict", () => {
    expect(() => prepareWorkspaceWrite(envelope, {
      ...envelope,
      localRevision: envelope.localRevision - 1,
      state: {
        ...envelope.state,
        profile: { ...envelope.state.profile, displayName: "Stale tab" },
      },
    })).toThrow(LocalWorkspaceConflictError);
  });

  it("refuses to overflow the browser-local revision during an ordinary write", () => {
    const exhausted = {
      ...envelope,
      localRevision: Number.MAX_SAFE_INTEGER,
    };

    expect(() => prepareWorkspaceWrite(exhausted, {
      ...exhausted,
      state: {
        ...exhausted.state,
        profile: { ...exhausted.state.profile, displayName: "Changed safely" },
      },
    })).toThrow(PersistenceError);
  });

  it("exposes a typed, privacy-safe local conflict without embedding workspace data", () => {
    const error = new LocalWorkspaceConflictError("account-1", 3, 4);

    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).toMatchObject({
      name: "LocalWorkspaceConflictError",
      code: "local-conflict",
      operation: "write-workspace",
      accountId: "account-1",
      expectedLocalRevision: 3,
      actualLocalRevision: 4,
    });
    expect(error.message).not.toContain("account-1");
    expect(error.message).not.toContain(state.profile.displayName);
  });
});

describe("portable archive compare-and-swap semantics", () => {
  it("always advances the exact inspected revision, including identical metadata", () => {
    expect(preparePortableArchiveWorkspaceWrite(null, {
      ...envelope,
      localRevision: 0,
    })).toMatchObject({ localRevision: 1 });

    expect(preparePortableArchiveWorkspaceWrite(envelope, envelope))
      .toMatchObject({ localRevision: envelope.localRevision + 1 });
  });

  it("preserves an existing anonymous handoff acknowledgement", () => {
    const anonymousHandoff = { generation: 3, localRevision: 9 };
    const stored = preparePortableArchiveWorkspaceWrite({
      ...envelope,
      anonymousHandoff,
    }, envelope);

    expect(stored.anonymousHandoff).toEqual(anonymousHandoff);
  });

  it("rejects a stale revision with exact privacy-safe conflict metadata", () => {
    try {
      preparePortableArchiveWorkspaceWrite(envelope, {
        ...envelope,
        localRevision: envelope.localRevision - 1,
      });
      throw new Error("Expected the stale archive import to be refused.");
    } catch (error) {
      expect(error).toMatchObject({
        name: "LocalWorkspaceConflictError",
        accountId: envelope.accountId,
        expectedLocalRevision: envelope.localRevision - 1,
        actualLocalRevision: envelope.localRevision,
      });
      expect((error as Error).message).not.toContain(envelope.accountId);
    }
  });

  it("refuses to overflow the browser-local revision", () => {
    expect(() => preparePortableArchiveWorkspaceWrite({
      ...envelope,
      localRevision: Number.MAX_SAFE_INTEGER,
    }, {
      ...envelope,
      localRevision: Number.MAX_SAFE_INTEGER,
    })).toThrow(PersistenceError);
  });
});

describe("atomic account handoff persistence", () => {
  it("removes only evidence absent from the exact replacement workspace", async () => {
    const fixture = installAccountErasureIndexedDb();
    const targetAccountId = "target-account";
    const goal = createStarterGoals()[0];
    const retainedEvidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const discardedEvidenceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const retainedKey = JSON.stringify([
      targetAccountId,
      goal.id,
      retainedEvidenceId,
    ]);
    const discardedKey = JSON.stringify([
      targetAccountId,
      goal.id,
      discardedEvidenceId,
    ]);
    const fileEvidence = (id: string, name: string) => ({
      id,
      type: "file" as const,
      name,
      mimeType: "text/plain" as const,
      size: 5,
    });
    const currentState: AppState = {
      ...state,
      areas: DEFAULT_AREAS,
      stats: DEFAULT_STATS,
      goals: [{
        ...goal,
        evidence: [
          fileEvidence(retainedEvidenceId, "keep.txt"),
          fileEvidence(discardedEvidenceId, "discard.txt"),
        ],
      }],
    };
    const current: WorkspaceEnvelope = {
      ...envelope,
      accountId: targetAccountId,
      state: currentState,
      history: [],
      localRevision: 0,
    };
    const requested: WorkspaceEnvelope = {
      ...current,
      state: {
        ...currentState,
        goals: [{
          ...currentState.goals[0],
          evidence: [fileEvidence(retainedEvidenceId, "keep.txt")],
        }],
      },
    };
    const storedEvidence = (evidenceId: string, contents: string) => ({
      accountId: targetAccountId,
      goalId: goal.id,
      evidenceId,
      bytes: new TextEncoder().encode(contents).buffer,
      mimeType: "text/plain",
      savedAt: "2026-08-09T12:00:00.000Z",
      writeId: `write-${evidenceId}`,
    });

    try {
      fixture.workspaces.set(targetAccountId, current);
      const retained = storedEvidence(retainedEvidenceId, "keep!");
      fixture.evidence.set(retainedKey, retained);
      fixture.evidence.set(
        discardedKey,
        storedEvidence(discardedEvidenceId, "drop!"),
      );

      await expect(applyAccountHandoffPersistence({
        envelope: requested,
        evidence: [],
        collisionPolicy: "replace-inspected-workspace",
        replaceQuarantinedWorkspace: false,
      }, 0)).resolves.toMatchObject({
        envelope: { localRevision: 1 },
      });

      expect(fixture.evidence.get(retainedKey)).toBe(retained);
      expect(fixture.evidence.get(discardedKey)).toBeUndefined();
      expect(fixture.scopes.get(targetAccountId)).toMatchObject({
        accountId: targetAccountId,
        generation: 0,
        evidenceRevision: 1,
        tombstoned: false,
      });
    } finally {
      fixture.close();
    }
  });

  it("preserves a target committed after the handoff's initial evidence read", async () => {
    const fixture = installAccountErasureIndexedDb();
    const targetAccountId = "target-account";
    const evidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const goalId = "goal-1";
    const evidenceStorageKey = JSON.stringify([
      targetAccountId,
      goalId,
      evidenceId,
    ]);
    const requested: WorkspaceEnvelope = {
      ...envelope,
      accountId: targetAccountId,
      state,
      history: [],
      localRevision: 0,
      anonymousHandoff: { generation: 0, localRevision: 3 },
    };
    const concurrentlyCommitted: WorkspaceEnvelope = {
      ...requested,
      state: {
        ...state,
        profile: { ...state.profile, displayName: "Tab two" },
      },
      localRevision: 1,
    };
    const concurrentEvidence = {
      accountId: targetAccountId,
      goalId,
      evidenceId,
      bytes: new TextEncoder().encode("tab-two-exact-bytes").buffer,
      mimeType: "text/plain",
      savedAt: "2026-08-02T12:00:00.000Z",
      writeId: "tab-two-write",
    };

    try {
      // Tab one inspected an absent evidence key and workspace revision zero.
      expect(fixture.evidence.get(evidenceStorageKey)).toBeUndefined();
      expect(fixture.workspaces.get(targetAccountId)).toBeUndefined();

      // Tab two then commits both its bytes and the workspace that references them.
      fixture.evidence.set(evidenceStorageKey, concurrentEvidence);
      fixture.workspaces.set(targetAccountId, concurrentlyCommitted);

      await expect(applyAccountHandoffPersistence({
        envelope: requested,
        evidence: [{
          accountId: targetAccountId,
          goalId,
          evidenceId,
          blob: new Blob(["tab-one-bytes"], { type: "text/plain" }),
          savedAt: "2026-08-02T12:01:00.000Z",
        }],
        collisionPolicy: "replace-inspected-workspace",
        replaceQuarantinedWorkspace: false,
      }, 0)).rejects.toBeInstanceOf(LocalWorkspaceConflictError);

      // The failed handoff neither overwrites nor compensates over tab two.
      expect(fixture.workspaces.get(targetAccountId)).toBe(concurrentlyCommitted);
      expect(fixture.evidence.get(evidenceStorageKey)).toBe(concurrentEvidence);
    } finally {
      fixture.close();
    }
  });
});

describe("v4 staged evidence and revision fences", () => {
  const accountId = "account-1";
  const goalId = "goal-1";
  const evidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const initialEnvelope = (): WorkspaceEnvelope => ({
    ...envelope,
    accountId,
    history: [],
    localRevision: 0,
    revision: 0,
  });
  const input = (contents: string) => ({
    accountId,
    goalId,
    evidenceId,
    blob: new Blob([contents], { type: "text/plain" }),
    savedAt: "2026-08-02T12:00:00.000Z",
  });

  it("atomically sweeps an unreferenced evidence row that arrived just before replacement", async () => {
    const fixture = installAccountErasureIndexedDb();
    const goal = createStarterGoals()[0];
    const referencedState: AppState = {
      ...state,
      areas: DEFAULT_AREAS,
      stats: DEFAULT_STATS,
      goals: [{
        ...goal,
        evidence: [{
          id: evidenceId,
          type: "file",
          name: "proof.txt",
          mimeType: "text/plain",
          size: 4,
        }],
      }],
    };
    try {
      const inspected = await writeWorkspace({
        ...initialEnvelope(),
        state: referencedState,
      }, 0);

      // This write represents the other tab landing after replacement cleanup
      // was planned but before the replacement transaction starts.
      await storeEvidenceBlob({
        ...input("late"),
        goalId: goal.id,
      }, 0, inspected.localRevision);

      const replaced = await writeWorkspace({
        ...inspected,
        state: { ...referencedState, goals: [] },
        history: [],
      }, 0, [], { removeUnreferencedEvidence: true });

      expect(replaced.localRevision).toBe(inspected.localRevision + 1);
      expect(await readEvidenceBlob(accountId, goal.id, evidenceId, 0)).toBeNull();
      expect(fixture.scopes.get(accountId)).toMatchObject({
        generation: 0,
        evidenceRevision: 2,
      });
    } finally {
      fixture.close();
    }
  });

  it("advances the workspace CAS when an identical replacement sweeps evidence", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const inspected = await writeWorkspace(initialEnvelope(), 0);
      await storeEvidenceBlob(input("unreferenced"), 0, inspected.localRevision);

      const replaced = await writeWorkspace(
        inspected,
        0,
        [],
        { removeUnreferencedEvidence: true },
      );

      expect(replaced.localRevision).toBe(inspected.localRevision + 1);
      expect(await readEvidenceBlob(accountId, goalId, evidenceId, 0)).toBeNull();
      await expect(storeEvidenceBlob(
        input("stale-late-write"),
        0,
        inspected.localRevision,
      )).rejects.toMatchObject({ code: "local-conflict" });
    } finally {
      fixture.close();
    }
  });

  it.each([
    ["A then B", [0, 1]],
    ["B then A", [1, 0]],
  ] as const)("keeps live bytes unchanged when staged attempts roll back %s", async (_label, order) => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const committedWorkspace = await writeWorkspace(initialEnvelope(), 0);
      const live = await storeEvidenceBlob(input("live"), 0, committedWorkspace.localRevision);
      const attempts = await Promise.all([
        stageEvidenceBlob(input("attempt-a"), 0),
        stageEvidenceBlob(input("attempt-b"), 0),
      ]);

      for (const index of order) {
        await expect(rollbackStagedEvidenceBlob(attempts[index], 0))
          .resolves.toBe("rolled-back");
      }

      expect(fixture.staging.size).toBe(0);
      const after = await readEvidenceBlob(accountId, goalId, evidenceId, 0);
      expect(after?.writeId).toBe(live.writeId);
      await expect(after?.blob.text()).resolves.toBe("live");
    } finally {
      fixture.close();
    }
  });

  it("promotes one exact staging token atomically and leaves a conflicting attempt staged", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const first = await stageEvidenceBlob(input("first"), 0);
      const committedWorkspace = await writeWorkspace(initialEnvelope(), 0, [first]);

      expect(fixture.staging.has(first.token)).toBe(false);
      await expect(rollbackStagedEvidenceBlob(first, 0)).resolves.toBe("already-absent");
      const live = await readEvidenceBlob(accountId, goalId, evidenceId, 0);
      expect(live?.writeId).toEqual(expect.any(String));
      await expect(live?.blob.text()).resolves.toBe("first");

      const conflicting = await stageEvidenceBlob(input("second"), 0);
      await expect(writeWorkspace(committedWorkspace, 0, [conflicting]))
        .rejects.toMatchObject({ code: "local-conflict" });
      expect(fixture.staging.has(conflicting.token)).toBe(true);
      const unchanged = await readEvidenceBlob(accountId, goalId, evidenceId, 0);
      expect(unchanged?.writeId).toBe(live?.writeId);
      await expect(unchanged?.blob.text()).resolves.toBe("first");
      await expect(rollbackStagedEvidenceBlob(conflicting, 0)).resolves.toBe("rolled-back");
    } finally {
      fixture.close();
    }
  });

  it("cleans an abandoned staging token without exposing or deleting live evidence", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const committedWorkspace = await writeWorkspace(initialEnvelope(), 0);
      const live = await storeEvidenceBlob(input("live"), 0, committedWorkspace.localRevision);
      const abandoned = await stageEvidenceBlob(input("abandoned"), 0);
      const stored = fixture.staging.get(abandoned.token) as Record<string, unknown>;
      fixture.staging.set(abandoned.token, {
        ...stored,
        stagedAt: "2026-07-01T00:00:00.000Z",
      });

      await expect(cleanupAbandonedEvidenceStaging(
        accountId,
        0,
        "2026-08-01T00:00:00.000Z",
      )).resolves.toBe(1);

      expect(fixture.staging.size).toBe(0);
      const after = await readEvidenceBlob(accountId, goalId, evidenceId, 0);
      expect(after?.writeId).toBe(live.writeId);
      await expect(after?.blob.text()).resolves.toBe("live");
    } finally {
      fixture.close();
    }
  });

  it("recovers a crash after metadata commit by deleting only the journaled live write", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const goal = createStarterGoals()[0];
      const referencedState: AppState = {
        ...state,
        areas: DEFAULT_AREAS,
        stats: DEFAULT_STATS,
        goals: [{
          ...goal,
          evidence: [{
            id: evidenceId,
            type: "file",
            name: "proof.txt",
            mimeType: "text/plain",
            size: 4,
          }],
        }],
      };
      const committed = await writeWorkspace({
        ...initialEnvelope(),
        state: referencedState,
      }, 0);
      const live = await storeEvidenceBlob({
        ...input("live"),
        goalId: goal.id,
      }, 0, committed.localRevision);
      const intent = await stageEvidenceCleanupIntent({
        accountId,
        goalId: goal.id,
        evidenceId,
        expectedWriteId: live.writeId,
      }, 0);

      await writeWorkspace({
        ...committed,
        state: {
          ...referencedState,
          goals: [{ ...referencedState.goals[0], evidence: [] }],
        },
      }, 0);

      expect(fixture.staging.has(intent.token)).toBe(true);
      await expect(recoverLocalEvidenceCleanupIntents(accountId, 0))
        .resolves.toEqual({
          deletedLive: 1,
          cancelledReferenced: 0,
          pendingRemote: 0,
        });
      expect(await readEvidenceBlob(accountId, goal.id, evidenceId, 0)).toBeNull();
      expect(fixture.staging.has(intent.token)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("retains remote cleanup provenance until Storage deletion is confirmed", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const committed = await writeWorkspace(initialEnvelope(), 0);
      const live = await storeEvidenceBlob(input("live"), 0, committed.localRevision);
      const intent = await stageEvidenceCleanupIntent({
        accountId,
        goalId,
        evidenceId,
        expectedWriteId: live.writeId,
        remotePath: `${accountId}/${goalId}/${evidenceId}/attempt-proof.txt`,
      }, 0);

      await expect(recoverLocalEvidenceCleanupIntents(accountId, 0))
        .resolves.toMatchObject({ deletedLive: 1, pendingRemote: 1 });
      const [pending] = await listEvidenceCleanupIntents(accountId, 0);
      expect(pending).toMatchObject({
        token: intent.token,
        expectedWriteId: undefined,
        remotePath: intent.remotePath,
      });
      await expect(markEvidenceCleanupRemoteComplete(pending, 0))
        .resolves.toBe("completed");
      await expect(listEvidenceCleanupIntents(accountId, 0)).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("cancels crash cleanup when metadata still references the file", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const goal = createStarterGoals()[0];
      const referencedState: AppState = {
        ...state,
        areas: DEFAULT_AREAS,
        stats: DEFAULT_STATS,
        goals: [{
          ...goal,
          evidence: [{
            id: evidenceId,
            type: "file",
            name: "proof.txt",
            mimeType: "text/plain",
            size: 4,
          }],
        }],
      };
      const committed = await writeWorkspace({
        ...initialEnvelope(),
        state: referencedState,
      }, 0);
      const live = await storeEvidenceBlob({
        ...input("live"),
        goalId: goal.id,
      }, 0, committed.localRevision);
      const intent = await stageEvidenceCleanupIntent({
        accountId,
        goalId: goal.id,
        evidenceId,
        expectedWriteId: live.writeId,
      }, 0);

      await expect(recoverLocalEvidenceCleanupIntents(accountId, 0))
        .resolves.toEqual({
          deletedLive: 0,
          cancelledReferenced: 1,
          pendingRemote: 0,
        });
      const after = await readEvidenceBlob(accountId, goal.id, evidenceId, 0);
      expect(after?.writeId).toBe(live.writeId);
      expect(fixture.staging.has(intent.token)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("preserves same-key local bytes while retaining cleanup for a superseded remote path", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const goal = createStarterGoals()[0];
      const oldPath = `${accountId}/${goal.id}/${evidenceId}/old-proof.txt`;
      const nextPath = `${accountId}/${goal.id}/${evidenceId}/next-proof.txt`;
      const withPath = (remotePath: string): AppState => ({
        ...state,
        areas: DEFAULT_AREAS,
        stats: DEFAULT_STATS,
        goals: [{
          ...goal,
          evidence: [{
            id: evidenceId,
            type: "file",
            name: "proof.txt",
            mimeType: "text/plain",
            size: 4,
            remotePath,
          }],
        }],
      });
      const committed = await writeWorkspace({
        ...initialEnvelope(),
        state: withPath(oldPath),
      }, 0);
      const live = await storeEvidenceBlob({
        ...input("live"),
        goalId: goal.id,
      }, 0, committed.localRevision);
      const intent = await stageEvidenceCleanupIntent({
        accountId,
        goalId: goal.id,
        evidenceId,
        expectedWriteId: live.writeId,
        remotePath: oldPath,
      }, 0);
      await writeWorkspace({
        ...committed,
        state: withPath(nextPath),
      }, 0);

      await expect(recoverLocalEvidenceCleanupIntents(accountId, 0))
        .resolves.toEqual({
          deletedLive: 0,
          cancelledReferenced: 0,
          pendingRemote: 1,
        });
      expect((await readEvidenceBlob(accountId, goal.id, evidenceId, 0))?.writeId)
        .toBe(live.writeId);
      const [pending] = await listEvidenceCleanupIntents(accountId, 0);
      expect(pending).toMatchObject({
        token: intent.token,
        expectedWriteId: undefined,
        remotePath: oldPath,
      });
      await expect(markEvidenceCleanupRemoteComplete(pending, 0))
        .resolves.toBe("completed");
      await expect(listEvidenceCleanupIntents(accountId, 0)).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("rejects a reset receipt when an evidence write advances the backup boundary", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const committedWorkspace = await writeWorkspace(initialEnvelope(), 0);
      const boundary = await readAccountPersistenceBackupBoundary(accountId);
      const live = await storeEvidenceBlob(input("newer"), 0, committedWorkspace.localRevision);

      await expect(deleteAccountPersistenceAtRevision(
        accountId,
        boundary.generation,
        boundary.workspaceLocalRevision,
        boundary.evidenceRevision,
      )).rejects.toMatchObject({ code: "local-conflict" });

      const after = await readEvidenceBlob(accountId, goalId, evidenceId, 0);
      expect(after?.writeId).toBe(live.writeId);
      expect(fixture.workspaces.has(accountId)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("lets a newer replacement survive stale compare-delete and ABA restore receipts", async () => {
    const fixture = installAccountErasureIndexedDb();
    try {
      const committedWorkspace = await writeWorkspace(initialEnvelope(), 0);
      const first = await storeEvidenceBlob(input("first"), 0, committedWorkspace.localRevision);
      const firstDelete = await deleteEvidenceBlob(first, 0, committedWorkspace.localRevision);
      expect(firstDelete.kind).toBe("deleted");
      if (firstDelete.kind !== "deleted") return;

      const replacement = await storeEvidenceBlob(
        input("replacement"),
        0,
        committedWorkspace.localRevision,
      );
      await expect(deleteEvidenceBlob(first, 0, committedWorkspace.localRevision))
        .resolves.toEqual({ kind: "superseded" });
      await expect(restoreEvidenceBlobs(firstDelete.receipt)).resolves.toBe("superseded");

      const current = await readEvidenceBlob(accountId, goalId, evidenceId, 0);
      expect(current?.writeId).toBe(replacement.writeId);
      await expect(current?.blob.text()).resolves.toBe("replacement");

      const replacementDelete = await deleteEvidenceBlob(
        replacement,
        0,
        committedWorkspace.localRevision,
      );
      expect(replacementDelete.kind).toBe("deleted");
      await expect(restoreEvidenceBlobs(firstDelete.receipt)).resolves.toBe("superseded");
      expect(await readEvidenceBlob(accountId, goalId, evidenceId, 0)).toBeNull();
    } finally {
      fixture.close();
    }
  });
});

describe("privacy-safe in-memory recovery export", () => {
  it("keeps workspace records while removing account-bound cloud file paths", () => {
    const goal = createStarterGoals()[0];
    const evidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const remotePath = `private-account/${goal.id}/${evidenceId}/proof.pdf`;
    const source: AppState = {
      ...state,
      goals: [{
        ...goal,
        evidence: [{
          id: evidenceId,
          type: "file",
          name: "proof.pdf",
          mimeType: "application/pdf",
          size: 12,
          remotePath,
        }],
      }],
    };

    const exported = privacySafeWorkspaceExport(source);
    const exportedEvidence = exported.goals[0].evidence[0];

    expect(exported.profile).toEqual(source.profile);
    expect(exportedEvidence).toEqual({
      id: evidenceId,
      type: "file",
      name: "proof.pdf",
      mimeType: "application/pdf",
      size: 12,
    });
    expect(JSON.stringify(exported)).not.toContain("private-account");
    expect(JSON.stringify(exported)).not.toContain("migrationDataUrl");
    expect(source.goals[0].evidence[0]).toMatchObject({ remotePath });
  });
});

describe("evidence record validation", () => {
  it("accepts a scoped Blob record and rejects malformed ownership or payload data", () => {
    const record = {
      accountId: "account-1",
      goalId: "goal-1",
      evidenceId: "evidence-1",
      blob: new Blob(["proof"], { type: "text/plain" }),
      savedAt: "2026-07-18T12:00:00.000Z",
    };

    expect(isEvidenceBlobRecord(record)).toBe(true);
    expect(recoverEvidenceBlobRecord(record)).toBe(record);
    expect(recoverEvidenceBlobRecord(null)).toBeNull();
    expect(isEvidenceBlobRecord({ ...record, accountId: " account-1" })).toBe(false);
    expect(isEvidenceBlobRecord({ ...record, blob: "proof" })).toBe(false);
    expect(isEvidenceBlobRecord({ ...record, blob: new Blob(["proof"], { type: "text/html" }) })).toBe(false);
    expect(isEvidenceBlobRecord({ ...record, blob: new Blob([new Uint8Array(10_485_761)], { type: "text/plain" }) })).toBe(false);
    expect(isEvidenceBlobRecord({ ...record, blob: new Blob(["proof"], { type: "text/plain;charset=utf-8" }) })).toBe(true);
    expect(isEvidenceBlobRecord({ ...record, savedAt: "sometime" })).toBe(false);
  });

  it("round-trips evidence through the cross-browser byte representation", async () => {
    const record = {
      accountId: "account-1",
      goalId: "goal-1",
      evidenceId: "evidence-1",
      blob: new Blob(["proof"], { type: "text/plain" }),
      savedAt: "2026-07-18T12:00:00.000Z",
    };

    const stored = await serializeEvidenceBlobRecord(record);
    expect(stored).toMatchObject({
      accountId: record.accountId,
      goalId: record.goalId,
      evidenceId: record.evidenceId,
      mimeType: "text/plain",
    });
    expect(stored).not.toHaveProperty("blob");
    expect(stored.bytes).toBeInstanceOf(ArrayBuffer);

    const recovered = recoverEvidenceBlobRecord(stored);
    expect(recovered).not.toBeNull();
    expect(await recovered?.blob.text()).toBe("proof");
    expect(recoverEvidenceBlobRecord({
      ...stored,
      mimeType: "text/html",
    })).toBeNull();
  });

  it("rejects invalid and unstable evidence before device storage", async () => {
    const base = {
      accountId: "account-1",
      goalId: "goal-1",
      evidenceId: "evidence-1",
      savedAt: "2026-07-18T12:00:00.000Z",
    };

    await expect(serializeEvidenceBlobRecord({
      ...base,
      blob: new Blob(["unsafe"], { type: "text/html" }),
    })).rejects.toMatchObject({ code: "invalid-data", operation: "serialize-evidence" });

    const unstableBlob = {
      size: 5,
      type: "text/plain",
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    } as Blob;
    await expect(serializeEvidenceBlobRecord({
      ...base,
      blob: unstableBlob,
    })).rejects.toMatchObject({ code: "invalid-data", operation: "serialize-evidence" });
  });
});

describe("IndexedDB capability detection", () => {
  it("returns false when IndexedDB is absent or access throws", () => {
    expect(hasIndexedDbSupport({})).toBe(false);
    expect(hasIndexedDbSupport({
      get indexedDB() {
        throw new Error("blocked");
      },
    })).toBe(false);
  });

  it("recognises an IndexedDB-shaped factory without opening it", () => {
    expect(hasIndexedDbSupport({ indexedDB: { open: () => undefined } })).toBe(true);
  });

  it("reports an explicit unavailable error before attempting a read in non-browser environments", async () => {
    if (hasIndexedDbSupport()) return;

    await expect(readWorkspace("account-1")).rejects.toMatchObject({
      name: "PersistenceError",
      code: "unavailable",
      operation: "open-database",
    });
  });
});
