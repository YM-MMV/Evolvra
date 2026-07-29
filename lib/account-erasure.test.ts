import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => {
  type Scope = {
    accountId: string;
    generation: number;
    tombstoned: boolean;
    updatedAt: string;
  };
  const raw = new Map<string, unknown>();
  const scopes = new Map<string, Scope>();
  const erased = vi.fn(async (accountId: string, generation: number) => ({
    deletedEvidence: 0,
    scope: scopes.get(accountId) ?? {
      accountId,
      generation,
      tombstoned: true,
      updatedAt: new Date().toISOString(),
    },
  }));
  return { raw, scopes, erased };
});

vi.mock("@/lib/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/persistence")>();
  return {
    ...actual,
    beginAccountErasurePersistenceFence: vi.fn(async (
      accountId: string,
      expectedGeneration: number,
      checkpoint: Record<string, unknown>,
    ) => {
      const current = persistence.scopes.get(accountId) ?? {
        accountId,
        generation: 0,
        tombstoned: false,
        updatedAt: new Date(0).toISOString(),
      };
      const existing = persistence.raw.get(accountId);
      if (existing !== undefined) {
        if (!current.tombstoned) throw new Error("checkpoint missing tombstone");
        return { scope: current, checkpoint: existing };
      }
      if (current.generation !== expectedGeneration) throw new Error("scope conflict");
      const scope = current.tombstoned ? current : {
        accountId,
        generation: current.generation + 1,
        tombstoned: true,
        updatedAt: new Date().toISOString(),
      };
      persistence.scopes.set(accountId, scope);
      const stored = { ...checkpoint, persistenceGeneration: scope.generation };
      persistence.raw.set(accountId, stored);
      return { scope, checkpoint: stored };
    }),
    recoverOrphanedAccountErasurePersistenceFence: vi.fn(async (
      accountId: string,
      expectedGeneration: number,
      checkpoint: Record<string, unknown>,
    ) => {
      const current = persistence.scopes.get(accountId) ?? {
        accountId,
        generation: 0,
        tombstoned: false,
        updatedAt: new Date(0).toISOString(),
      };
      if (
        !current.tombstoned
        || current.generation !== expectedGeneration
        || checkpoint.cloud !== "ambiguous"
      ) throw new Error("orphan scope conflict");
      const existing = persistence.raw.get(accountId);
      if (existing !== undefined) {
        if (
          !existing
          || typeof existing !== "object"
          || (existing as Record<string, unknown>).accountId !== accountId
          || (existing as Record<string, unknown>).cloud !== "ambiguous"
          || (existing as Record<string, unknown>).persistenceGeneration !== current.generation
        ) throw new Error("different orphan bookkeeping");
        return { scope: current, checkpoint: existing };
      }
      const stored = { ...checkpoint, persistenceGeneration: current.generation };
      persistence.raw.set(accountId, stored);
      return { scope: current, checkpoint: stored };
    }),
    readAccountPersistenceScope: vi.fn(async (accountId: string) =>
      persistence.scopes.get(accountId) ?? {
        accountId,
        generation: 0,
        tombstoned: false,
        updatedAt: new Date(0).toISOString(),
      }),
    listRawAccountErasureCheckpoints: vi.fn(async () =>
      [...persistence.raw].map(([key, value]) => ({ key, value }))),
    readRawAccountErasureCheckpoint: vi.fn(async (accountId: string) =>
      persistence.raw.get(accountId) ?? null),
    mutateRawAccountErasureCheckpoint: vi.fn(async (
      accountId: string,
      mutate: (current: unknown | null) => Record<string, unknown> | null,
    ) => {
      const next = mutate(persistence.raw.get(accountId) ?? null);
      if (next === null) persistence.raw.delete(accountId);
      else persistence.raw.set(accountId, next);
      return next;
    }),
    deleteRawAccountErasureCheckpoint: vi.fn(async (key: IDBValidKey) => {
      persistence.raw.delete(String(key));
    }),
    eraseAccountPersistenceWithTombstone: persistence.erased,
  };
});

import {
  ACCOUNT_ERASURE_FUTURE_TOLERANCE_MS,
  ACCOUNT_ERASURE_OWNER_LEASE_MS,
  LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY,
  AccountErasureAttemptReplacedError,
  abandonExpiredFinalizingAccountErasure,
  accountErasureCheckpointNeedsRecovery,
  actionableLocalErasureCheckpoint,
  advanceCloudAccountErasure,
  beginAccountErasureIntent,
  discardCorruptAccountErasureCheckpoint,
  discardLegacyAccountErasureCheckpoints,
  eraseInactiveAccountLocalData,
  finalizingErasureLeaseExpired,
  findAccountErasureCheckpoint,
  listAccountErasureCheckpoints,
  migrateLegacyAccountErasureCheckpoints,
  parseAccountErasureCheckpoint,
  parseLegacyAccountErasureCheckpoints,
  prepareAmbiguousAccountErasureRetry,
  recoverOrphanedAccountErasureIntent,
  resumeLocalAccountErasure,
  safelyDiscardLegacyAccountErasureCheckpoints,
  type AccountErasureCheckpoint,
} from "@/lib/account-erasure";
import { CloudAccountErasureError } from "@/lib/supabase";

const at = "2026-07-19T12:00:00.000Z";
const atMs = Date.parse(at);

function checkpoint(
  patch: Partial<AccountErasureCheckpoint> = {},
): AccountErasureCheckpoint {
  return {
    version: 2,
    accountId: "account-a",
    attemptId: "attempt-a",
    cloud: "pending",
    local: "pending",
    session: "pending",
    persistenceGeneration: 1,
    owner: null,
    updatedAt: at,
    ...patch,
  };
}

beforeEach(() => {
  persistence.raw.clear();
  persistence.scopes.clear();
  persistence.erased.mockClear();
  vi.useRealTimers();
});

describe("durable account-erasure checkpoints", () => {
  it("atomically rotates the generation, tombstones the account, and stores v2 intent", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });

    expect(begun.scope).toMatchObject({
      accountId: "account-a",
      generation: 1,
      tombstoned: true,
    });
    expect(begun.checkpoint).toMatchObject({
      version: 2,
      accountId: "account-a",
      attemptId: "attempt-a",
      cloud: "pending",
      local: "pending",
      session: "pending",
      persistenceGeneration: 1,
    });
  });

  it("adopts the first durable attempt when two tabs begin from the same generation", async () => {
    const first = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-first",
      now: atMs,
    });
    const second = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-second",
      now: atMs,
    });

    expect(second.checkpoint.attemptId).toBe(first.checkpoint.attemptId);
    expect(second.scope).toEqual(first.scope);
  });

  it("reconstructs an orphan tombstone as ambiguous without rotating its generation", async () => {
    persistence.scopes.set("account-a", {
      accountId: "account-a",
      generation: 7,
      tombstoned: true,
      updatedAt: at,
    });

    const recovered = await recoverOrphanedAccountErasureIntent(
      "account-a",
      7,
      { attemptId: "orphan-recovery", now: atMs },
    );

    expect(recovered.scope).toMatchObject({ generation: 7, tombstoned: true });
    expect(recovered.checkpoint).toMatchObject({
      attemptId: "orphan-recovery",
      cloud: "ambiguous",
      local: "pending",
      session: "pending",
      persistenceGeneration: 7,
    });
  });

  it("never adopts pending bookkeeping that races orphan reconstruction", async () => {
    persistence.scopes.set("account-a", {
      accountId: "account-a",
      generation: 7,
      tombstoned: true,
      updatedAt: at,
    });
    const pending = checkpoint({
      cloud: "pending",
      persistenceGeneration: 7,
    });
    persistence.raw.set("account-a", pending);

    await expect(recoverOrphanedAccountErasureIntent(
      "account-a",
      7,
      { attemptId: "orphan-recovery", now: atMs },
    )).rejects.toThrow(/different orphan bookkeeping/i);
    expect(persistence.raw.get("account-a")).toBe(pending);
  });

  it("will not reconstruct orphan bookkeeping on an unfenced scope", async () => {
    persistence.scopes.set("account-a", {
      accountId: "account-a",
      generation: 7,
      tombstoned: false,
      updatedAt: at,
    });

    await expect(recoverOrphanedAccountErasureIntent(
      "account-a",
      7,
      { attemptId: "unsafe-recovery", now: atMs },
    )).rejects.toThrow(/orphan scope conflict/i);
    expect(persistence.raw.has("account-a")).toBe(false);
  });

  it("never reconstructs or erases an anonymous tombstone as a cloud-account deletion", async () => {
    persistence.scopes.set("anonymous", {
      accountId: "anonymous",
      generation: 3,
      tombstoned: true,
      updatedAt: at,
    });

    await expect(recoverOrphanedAccountErasureIntent(
      "anonymous",
      3,
      { attemptId: "unsafe-anonymous-recovery", now: atMs },
    )).rejects.toThrow(/anonymous workspace cannot be reconstructed/i);
    expect(persistence.raw.has("anonymous")).toBe(false);
    expect(persistence.erased).not.toHaveBeenCalled();
  });

  it("never begins a connected-account erasure for the reserved anonymous scope", async () => {
    await expect(beginAccountErasureIntent(
      "anonymous",
      0,
      { attemptId: "unsafe-anonymous-begin", now: atMs },
    )).rejects.toThrow(/anonymous workspace/i);
    expect(persistence.scopes.has("anonymous")).toBe(false);
    expect(persistence.raw.has("anonymous")).toBe(false);
  });

  it("quarantines corrupt and future records individually without hiding valid accounts", async () => {
    persistence.raw.set("account-a", checkpoint());
    persistence.raw.set("account-b", {
      ...checkpoint({ accountId: "account-b", attemptId: "attempt-b" }),
      updatedAt: new Date(atMs + ACCOUNT_ERASURE_FUTURE_TOLERANCE_MS + 1).toISOString(),
    });

    const inventory = await listAccountErasureCheckpoints(atMs);
    expect(inventory.checkpoints.map((item) => item.accountId)).toEqual(["account-a"]);
    expect(inventory.corrupt).toEqual([expect.objectContaining({ key: "account-b" })]);

    persistence.scopes.set("account-b", {
      accountId: "account-b",
      generation: 4,
      tombstoned: true,
      updatedAt: at,
    });
    await discardCorruptAccountErasureCheckpoint("account-b");
    expect(persistence.raw.has("account-b")).toBe(false);
    // Discarding unreadable bookkeeping never clears the permanent fence.
    expect(persistence.scopes.get("account-b")?.tombstoned).toBe(true);
  });

  it("rejects unsupported versions and ownerless finalizing records", () => {
    expect(() => parseAccountErasureCheckpoint({
      ...checkpoint(),
      version: 3,
    }, "account-a", atMs)).toThrow(/unsupported format/i);
    expect(() => parseAccountErasureCheckpoint({
      ...checkpoint(),
      cloud: "finalizing",
    }, "account-a", atMs)).toThrow(/no owner lease/i);
  });

  it("retains complete markers for integrity but filters them from recovery", () => {
    expect(accountErasureCheckpointNeedsRecovery(checkpoint({
      cloud: "complete",
      local: "complete",
      session: "complete",
    }))).toBe(false);
    expect(accountErasureCheckpointNeedsRecovery(checkpoint({
      cloud: "ambiguous",
      local: "complete",
      session: "complete",
    }))).toBe(false);
    expect(accountErasureCheckpointNeedsRecovery(checkpoint({
      cloud: "complete",
      local: "complete",
      session: "pending",
    }))).toBe(true);
  });

  it("requires explicit abandonment after lease expiry and never promotes by time alone", async () => {
    const finalizing = checkpoint({
      cloud: "finalizing",
      owner: {
        id: "tab-a",
        leaseExpiresAt: new Date(atMs + ACCOUNT_ERASURE_OWNER_LEASE_MS).toISOString(),
      },
    });
    persistence.raw.set("account-a", finalizing);

    expect(finalizingErasureLeaseExpired(finalizing, atMs)).toBe(false);
    await expect(abandonExpiredFinalizingAccountErasure(
      "account-a",
      "attempt-a",
      atMs,
    )).rejects.toThrow(/live lease/i);
    expect((await findAccountErasureCheckpoint("account-a", atMs))?.cloud).toBe("finalizing");

    const expiredAt = atMs + ACCOUNT_ERASURE_OWNER_LEASE_MS + 1;
    expect(finalizingErasureLeaseExpired(finalizing, expiredAt)).toBe(true);
    await expect(abandonExpiredFinalizingAccountErasure(
      "account-a",
      "attempt-a",
      expiredAt,
    )).resolves.toMatchObject({ cloud: "ambiguous", owner: null });
  });

  it("prepares only an exact fully-cleaned ambiguous attempt for explicit retry", async () => {
    const ambiguous = checkpoint({
      cloud: "ambiguous",
      local: "complete",
      session: "complete",
    });
    persistence.raw.set("account-a", ambiguous);

    const prepared = await prepareAmbiguousAccountErasureRetry(
      "account-a",
      "attempt-a",
      atMs + 1,
    );

    expect(prepared).toMatchObject({
      attemptId: "attempt-a",
      cloud: "failed",
      local: "complete",
      session: "complete",
      owner: null,
      updatedAt: new Date(atMs + 1).toISOString(),
    });
  });

  it("does not prepare ambiguous retry before device and session cleanup complete", async () => {
    const incomplete = checkpoint({
      cloud: "ambiguous",
      local: "complete",
      session: "pending",
    });
    persistence.raw.set("account-a", incomplete);

    await expect(prepareAmbiguousAccountErasureRetry(
      "account-a",
      "attempt-a",
      atMs + 1,
    )).rejects.toThrow(/complete device and session cleanup/i);
    expect(await findAccountErasureCheckpoint("account-a", atMs + 1)).toEqual(incomplete);
  });

  it.each(["pending", "failed", "complete"] as const)(
    "preserves a non-ambiguous %s attempt when explicit retry preparation is requested",
    async (cloud) => {
      const existing = checkpoint({
        cloud,
        local: "complete",
        session: "complete",
      });
      persistence.raw.set("account-a", existing);

      await expect(prepareAmbiguousAccountErasureRetry(
        "account-a",
        "attempt-a",
        atMs + 1,
      )).rejects.toThrow(/only an ambiguous account-erasure attempt/i);
      expect(await findAccountErasureCheckpoint("account-a", atMs + 1)).toEqual(existing);
    },
  );

  it("preserves a live finalizing owner during explicit retry preparation", async () => {
    const finalizing = checkpoint({
      cloud: "finalizing",
      local: "complete",
      session: "complete",
      owner: {
        id: "tab-a",
        leaseExpiresAt: new Date(atMs + ACCOUNT_ERASURE_OWNER_LEASE_MS).toISOString(),
      },
    });
    persistence.raw.set("account-a", finalizing);

    await expect(prepareAmbiguousAccountErasureRetry(
      "account-a",
      "attempt-a",
      atMs + 1,
    )).rejects.toThrow(/only an ambiguous account-erasure attempt/i);
    expect(await findAccountErasureCheckpoint("account-a", atMs + 1)).toEqual(finalizing);
  });

  it("does not prepare a retry when a newer attempt replaced the ambiguous one", async () => {
    const replacement = checkpoint({
      attemptId: "attempt-new",
      cloud: "ambiguous",
      local: "complete",
      session: "complete",
    });
    persistence.raw.set("account-a", replacement);

    await expect(prepareAmbiguousAccountErasureRetry(
      "account-a",
      "attempt-a",
      atMs + 1,
    )).rejects.toBeInstanceOf(AccountErasureAttemptReplacedError);
    expect(await findAccountErasureCheckpoint("account-a", atMs + 1)).toEqual(replacement);
  });

  it("throws when a newer attempt replaces a stale callback", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });

    await expect(advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-a",
      eraseCloud: async (onFinalDeletionStarting) => {
        await onFinalDeletionStarting();
        persistence.raw.set("account-a", checkpoint({
          attemptId: "attempt-new",
          persistenceGeneration: 1,
        }));
      },
    })).rejects.toBeInstanceOf(AccountErasureAttemptReplacedError);
    expect((await findAccountErasureCheckpoint("account-a", atMs))?.attemptId)
      .toBe("attempt-new");
  });
});

describe("legacy account-erasure checkpoint migration", () => {
  const memoryStorage = (initial: string | null) => {
    let value = initial;
    return {
      getItem: vi.fn(() => value),
      removeItem: vi.fn(() => { value = null; }),
      current: () => value,
    };
  };

  it("rejects duplicate, malformed, and future v1 records before arming a fence", () => {
    expect(() => parseLegacyAccountErasureCheckpoints({
      version: 1,
      checkpoints: [
        { accountId: "account-a", cloud: "pending", local: "pending", updatedAt: at },
        { accountId: "account-a", cloud: "complete", local: "complete", updatedAt: at },
      ],
    }, atMs)).toThrow(/repeats an account/i);
    expect(() => parseLegacyAccountErasureCheckpoints({
      version: 1,
      checkpoints: [{
        accountId: " account-a ",
        cloud: "pending",
        local: "pending",
        updatedAt: at,
      }],
    }, atMs)).toThrow(/accountId|identifier/i);
    expect(() => parseLegacyAccountErasureCheckpoints({
      version: 1,
      checkpoints: [{
        accountId: "anonymous",
        cloud: "complete",
        local: "complete",
        updatedAt: at,
      }],
    }, atMs)).toThrow(/anonymous workspace/i);
    expect(() => parseLegacyAccountErasureCheckpoints({
      version: 1,
      checkpoints: [{
        accountId: "account-a",
        cloud: "pending",
        local: "pending",
        updatedAt: new Date(atMs + ACCOUNT_ERASURE_FUTURE_TOLERANCE_MS + 1).toISOString(),
      }],
    }, atMs)).toThrow(/future/i);
    expect(persistence.scopes.size).toBe(0);
  });

  it("arms every exact tombstone before removing valid v1 bookkeeping", async () => {
    const storage = memoryStorage(JSON.stringify({
      version: 1,
      checkpoints: [
        { accountId: "account-a", cloud: "pending", local: "pending", updatedAt: at },
        { accountId: "account-b", cloud: "finalizing", local: "complete", updatedAt: at },
      ],
    }));

    const migrated = await migrateLegacyAccountErasureCheckpoints(storage, atMs + 1);

    expect(storage.current()).toBeNull();
    expect(persistence.scopes.get("account-a")).toMatchObject({ tombstoned: true, generation: 1 });
    expect(persistence.scopes.get("account-b")).toMatchObject({ tombstoned: true, generation: 1 });
    expect(migrated).toEqual([
      expect.objectContaining({ accountId: "account-a", cloud: "failed", local: "pending" }),
      expect.objectContaining({
        accountId: "account-b",
        cloud: "finalizing",
        local: "complete",
        owner: expect.objectContaining({ leaseExpiresAt: at }),
      }),
    ]);
  });

  it("surfaces legacy removal failure after durable fences and supports explicit discard", async () => {
    const raw = JSON.stringify({
      version: 1,
      checkpoints: [{
        accountId: "account-a",
        cloud: "ambiguous",
        local: "pending",
        updatedAt: at,
      }],
    });
    const storage = {
      getItem: vi.fn(() => raw),
      removeItem: vi.fn(() => { throw new Error("legacy storage blocked"); }),
    };

    await expect(migrateLegacyAccountErasureCheckpoints(storage, atMs + 1))
      .rejects.toThrow(/legacy storage blocked/i);
    expect(persistence.scopes.get("account-a")?.tombstoned).toBe(true);
    expect(persistence.raw.has("account-a")).toBe(true);
    expect(() => discardLegacyAccountErasureCheckpoints(storage))
      .toThrow(/legacy storage blocked/i);
  });

  it("permanently disables legacy import and removes shared data before discarding damaged erasure bookkeeping", async () => {
    const removed: string[] = [];
    const order: string[] = [];
    const storage = {
      removeItem: vi.fn((key: string) => {
        removed.push(key);
        order.push(`remove:${key}`);
      }),
    };

    await safelyDiscardLegacyAccountErasureCheckpoints(storage, async (accountId) => {
      expect(accountId).toBe("anonymous");
      order.push("disable-import");
      return {
        accountId: "anonymous",
        status: "disabled",
        disabledAt: at,
      };
    });

    expect(order[0]).toBe("disable-import");
    expect(removed.at(-1)).toBe(LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY);
    expect(removed).toContain("evolvra:workspace:v1");
    expect(removed).toContain("evolvra:reminder:last-delivered");
  });

  it("keeps damaged erasure bookkeeping blocking when old shared data cannot be removed", async () => {
    const removed: string[] = [];
    const storage = {
      removeItem: vi.fn((key: string) => {
        if (key === "evolvra:workspace:v1") throw new Error("legacy workspace blocked");
        removed.push(key);
      }),
    };

    await expect(safelyDiscardLegacyAccountErasureCheckpoints(
      storage,
      async () => ({
        accountId: "anonymous",
        status: "disabled",
        disabledAt: at,
      }),
    )).rejects.toThrow(/legacy workspace blocked/i);
    expect(removed).not.toContain(LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY);
  });

  it("keeps damaged erasure bookkeeping when legacy import is not terminal", async () => {
    const removed: string[] = [];
    const storage = {
      removeItem: vi.fn((key: string) => { removed.push(key); }),
    };

    await expect(safelyDiscardLegacyAccountErasureCheckpoints(
      storage,
      async () => ({
        accountId: "anonymous",
        status: "pending",
        raw: "legacy workspace",
        capturedAt: at,
      }),
    )).rejects.toThrow(/permanent terminal state/i);
    expect(removed).toEqual([]);
  });
});

describe("cloud erasure outcomes", () => {
  it("allows only one same-attempt caller to invoke final deletion", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let finishFirst!: () => void;
    let firstReady!: () => void;
    let secondReady!: () => void;
    let firstInvoked!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstFinish = new Promise<void>((resolve) => { finishFirst = resolve; });
    const firstReadyPromise = new Promise<void>((resolve) => { firstReady = resolve; });
    const secondReadyPromise = new Promise<void>((resolve) => { secondReady = resolve; });
    const firstInvokedPromise = new Promise<void>((resolve) => { firstInvoked = resolve; });
    let firstFinalCalls = 0;
    let secondFinalCalls = 0;

    // Both callers read the same pending checkpoint before either is allowed to
    // acquire the finalizing phase.
    const first = advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-a",
      eraseCloud: async (onFinalDeletionStarting) => {
        firstReady();
        await firstGate;
        await onFinalDeletionStarting();
        firstFinalCalls += 1;
        firstInvoked();
        await firstFinish;
      },
    });
    const second = advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-b",
      eraseCloud: async (onFinalDeletionStarting) => {
        secondReady();
        await secondGate;
        await onFinalDeletionStarting();
        secondFinalCalls += 1;
      },
    });
    await Promise.all([firstReadyPromise, secondReadyPromise]);

    releaseFirst();
    await firstInvokedPromise;
    const secondFailure = expect(second).rejects.toThrow(/another request owns.*lease/i);
    releaseSecond();
    await secondFailure;
    expect(await findAccountErasureCheckpoint("account-a")).toMatchObject({
      cloud: "finalizing",
      owner: { id: "tab-a" },
    });

    finishFirst();
    await expect(first).resolves.toMatchObject({ cloud: "complete" });
    expect(firstFinalCalls).toBe(1);
    expect(secondFinalCalls).toBe(0);
  });

  it("never steals or downgrades another request's finalizing lease", async () => {
    const leased = checkpoint({
      cloud: "finalizing",
      owner: {
        id: "tab-a",
        leaseExpiresAt: new Date(atMs + ACCOUNT_ERASURE_OWNER_LEASE_MS).toISOString(),
      },
    });
    persistence.raw.set("account-a", leased);

    await expect(advanceCloudAccountErasure({
      checkpoint: leased,
      ownerId: "tab-b",
      eraseCloud: async (onFinalDeletionStarting) => {
        await onFinalDeletionStarting();
      },
    })).rejects.toThrow(/already owns.*lease/i);
    expect(await findAccountErasureCheckpoint("account-a", atMs)).toMatchObject({
      cloud: "finalizing",
      owner: { id: "tab-a" },
    });
  });

  it("preserves a lease won concurrently after this caller read pending", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });
    const leased = checkpoint({
      cloud: "finalizing",
      owner: {
        id: "tab-a",
        leaseExpiresAt: new Date(atMs + ACCOUNT_ERASURE_OWNER_LEASE_MS).toISOString(),
      },
    });

    await expect(advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-b",
      eraseCloud: async () => {
        persistence.raw.set("account-a", leased);
        throw new Error("lost the final lease race");
      },
    })).rejects.toThrow(/lost the final lease race/i);
    expect(await findAccountErasureCheckpoint("account-a", atMs)).toMatchObject({
      cloud: "finalizing",
      owner: { id: "tab-a" },
    });
  });

  it("does not make a post-final failure ambiguous after ownership changes", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });
    const replacementOwner = checkpoint({
      cloud: "finalizing",
      owner: {
        id: "tab-b",
        leaseExpiresAt: new Date(atMs + ACCOUNT_ERASURE_OWNER_LEASE_MS).toISOString(),
      },
    });

    await expect(advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-a",
      eraseCloud: async (onFinalDeletionStarting) => {
        await onFinalDeletionStarting();
        persistence.raw.set("account-a", replacementOwner);
        throw new Error("tab-a lost its final response");
      },
    })).rejects.toThrow(/no longer owns.*lease/i);
    expect(await findAccountErasureCheckpoint("account-a", atMs)).toMatchObject({
      cloud: "finalizing",
      owner: { id: "tab-b" },
    });
  });

  it("does not record success after ownership changes", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });
    const replacementOwner = checkpoint({
      cloud: "finalizing",
      owner: {
        id: "tab-b",
        leaseExpiresAt: new Date(atMs + ACCOUNT_ERASURE_OWNER_LEASE_MS).toISOString(),
      },
    });

    await expect(advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-a",
      eraseCloud: async (onFinalDeletionStarting) => {
        await onFinalDeletionStarting();
        persistence.raw.set("account-a", replacementOwner);
      },
    })).rejects.toThrow(/no longer owns.*lease/i);
    expect(await findAccountErasureCheckpoint("account-a", atMs)).toMatchObject({
      cloud: "finalizing",
      owner: { id: "tab-b" },
    });
  });

  it("preserves an explicitly ambiguous outcome after a late success", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });
    const ambiguous = checkpoint({
      cloud: "ambiguous",
      updatedAt: new Date(atMs + 1).toISOString(),
    });

    const result = await advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-a",
      eraseCloud: async (onFinalDeletionStarting) => {
        await onFinalDeletionStarting();
        persistence.raw.set("account-a", ambiguous);
      },
    });

    expect(result).toMatchObject({
      cloud: "ambiguous",
      checkpoint: {
        cloud: "ambiguous",
        owner: null,
        updatedAt: ambiguous.updatedAt,
      },
    });
  });

  it("never invokes cloud deletion again after an ambiguous final outcome", async () => {
    const ambiguous = checkpoint({ cloud: "ambiguous" });
    persistence.raw.set("account-a", ambiguous);
    const eraseCloud = vi.fn(async () => undefined);

    const result = await advanceCloudAccountErasure({
      checkpoint: ambiguous,
      eraseCloud,
    });

    expect(result.cloud).toBe("ambiguous");
    expect(eraseCloud).not.toHaveBeenCalled();
  });

  it("records a returned lost response as ambiguous and actionable", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });
    const result = await advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-a",
      eraseCloud: async (onFinalDeletionStarting) => {
        await onFinalDeletionStarting();
        throw new CloudAccountErasureError(
          "account",
          "delete response lost",
          new Error("network closed"),
          true,
          0,
          true,
        );
      },
    });

    expect(result).toMatchObject({ cloud: "ambiguous", warning: "delete response lost" });
    expect(actionableLocalErasureCheckpoint([result.checkpoint])?.accountId)
      .toBe("account-a");
  });

  it("maps a final RPC rejection to ambiguous instead of retryable failure", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });

    const result = await advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-a",
      eraseCloud: async (onFinalDeletionStarting) => {
        await onFinalDeletionStarting();
        throw new CloudAccountErasureError(
          "account",
          "transaction rejected",
          new Error("server rejected"),
          false,
          500,
          false,
        );
      },
    });
    expect(result).toMatchObject({
      cloud: "ambiguous",
      warning: "transaction rejected",
    });
    expect((await findAccountErasureCheckpoint("account-a"))?.cloud).toBe("ambiguous");
  });

  it("keeps an untyped post-final exception terminal and non-retryable", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });

    const result = await advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      ownerId: "tab-a",
      eraseCloud: async (onFinalDeletionStarting) => {
        await onFinalDeletionStarting();
        throw new Error("connection vanished after invocation");
      },
    });

    expect(result).toMatchObject({
      cloud: "ambiguous",
      warning: "connection vanished after invocation",
    });
    expect((await findAccountErasureCheckpoint("account-a"))?.cloud).toBe("ambiguous");
  });

  it("keeps a pre-final failure terminal and preserves the tombstone", async () => {
    const begun = await beginAccountErasureIntent("account-a", 0, {
      attemptId: "attempt-a",
      now: atMs,
    });

    await expect(advanceCloudAccountErasure({
      checkpoint: begun.checkpoint,
      eraseCloud: async () => {
        throw new CloudAccountErasureError("evidence", "Storage unavailable");
      },
    })).rejects.toThrow(/storage unavailable/i);
    expect((await findAccountErasureCheckpoint("account-a"))?.cloud).toBe("failed");
    expect(persistence.scopes.get("account-a")?.tombstoned).toBe(true);
  });
});

describe("resumable local and session cleanup", () => {
  it("finishes the exact active account through the provider and removes only safe-complete bookkeeping", async () => {
    const durable = checkpoint({ cloud: "complete" });
    persistence.raw.set("account-a", durable);
    let authenticatedAccountId: string | null = "account-a";
    const clearExactAccountSession = vi.fn(async (target: string) => {
      expect(target).toBe("account-a");
      authenticatedAccountId = null;
      return null;
    });
    const finishActiveAccountErasure = vi.fn(async (
      _target: string,
      _generation: number,
      clearSession: () => Promise<string | null>,
    ) => ({ sessionWarning: await clearSession() }));

    const result = await resumeLocalAccountErasure({
      checkpoint: durable,
      workspaceSwitching: true,
      terminalFenced: true,
      getAuthenticatedAccountId: async () => authenticatedAccountId,
      finishActiveAccountErasure,
      clearExactAccountSession,
    });

    expect(result).toMatchObject({
      erasedActiveAccount: true,
      sessionWarning: null,
      checkpoint: {
        cloud: "complete",
        local: "complete",
        session: "complete",
      },
    });
    expect(finishActiveAccountErasure).toHaveBeenCalledWith(
      "account-a",
      1,
      expect.any(Function),
    );
    expect(clearExactAccountSession).toHaveBeenCalledOnce();
    expect(persistence.scopes.get("account-a")).toBeUndefined();
  });

  it("never signs out another account while cleaning an inactive tombstone", async () => {
    const durable = checkpoint({ cloud: "ambiguous" });
    persistence.raw.set("account-a", durable);
    const eraseInactiveAccount = vi.fn(async () => undefined);
    const clearExactAccountSession = vi.fn(async () => null);

    const result = await resumeLocalAccountErasure({
      checkpoint: durable,
      workspaceSwitching: false,
      getAuthenticatedAccountId: async () => "account-b",
      eraseInactiveAccount,
      clearExactAccountSession,
    });

    expect(eraseInactiveAccount).toHaveBeenCalledWith(durable);
    expect(clearExactAccountSession).not.toHaveBeenCalled();
    expect(result.checkpoint).toMatchObject({
      cloud: "ambiguous",
      local: "complete",
      session: "complete",
    });
  });

  it("keeps session pending when exact-account sign-out reports failure", async () => {
    const durable = checkpoint({ cloud: "complete", local: "complete" });
    persistence.raw.set("account-a", durable);
    const warning = "Local session could not be cleared.";

    const result = await resumeLocalAccountErasure({
      checkpoint: durable,
      workspaceSwitching: false,
      getAuthenticatedAccountId: async () => "account-a",
      clearExactAccountSession: async () => warning,
    });

    expect(result.sessionWarning).toBe(warning);
    expect(result.checkpoint).toMatchObject({ session: "pending" });
  });

  it("surfaces legacy reminder removal failure after tombstoned IDB cleanup", async () => {
    const durable = checkpoint({ cloud: "ambiguous" });
    const storage = {
      removeItem: vi.fn(() => { throw new Error("localStorage blocked"); }),
    };

    await expect(eraseInactiveAccountLocalData(
      durable,
      storage,
      persistence.erased,
    )).rejects.toThrow(/localStorage blocked/i);
    expect(persistence.erased).toHaveBeenCalledWith("account-a", 1);
  });
});
