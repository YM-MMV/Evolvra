import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ERASURE_FUTURE_TOLERANCE_MS,
  ACCOUNT_ERASURE_OWNER_LEASE_MS,
  accountErasureCheckpointNeedsRecovery,
  actionableLocalErasureCheckpoint,
  finalizingErasureLeaseExpired,
  parseAccountErasureCheckpoint,
  parseLegacyAccountErasureCheckpoints,
  updateAccountErasureCheckpoint,
  type AccountErasureCheckpoint,
} from "@/lib/account-erasure-checkpoint";

const updatedAt = "2026-07-19T12:00:00.000Z";
const updatedAtMs = Date.parse(updatedAt);

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
    persistenceGeneration: 4,
    backup: null,
    owner: null,
    updatedAt,
    ...patch,
  };
}

describe("account-erasure checkpoint validation", () => {
  it("keeps pre-boundary checkpoints readable with a null backup boundary", () => {
    const legacy = { ...checkpoint() } as Record<string, unknown>;
    delete legacy.backup;

    expect(
      parseAccountErasureCheckpoint(legacy, "account-a", updatedAtMs),
    ).toEqual(checkpoint({ backup: null }));
  });

  it("accepts a valid cloud backup boundary and rejects malformed revisions", () => {
    const value = checkpoint({
      backup: {
        workspaceRevision: 17,
        evidenceRevision: 23,
      },
    });

    expect(
      parseAccountErasureCheckpoint(value, "account-a", updatedAtMs),
    ).toEqual(value);

    for (const backup of [
      { workspaceRevision: -1, evidenceRevision: 23 },
      { workspaceRevision: 17.5, evidenceRevision: 23 },
      { workspaceRevision: 17, evidenceRevision: "23" },
      { workspaceRevision: 17 },
    ]) {
      expect(() =>
        parseAccountErasureCheckpoint(
          { ...checkpoint(), backup },
          "account-a",
          updatedAtMs,
        ),
      ).toThrow(/invalid backup boundary/i);
    }
  });

  it("accepts an exact finalizing owner lease for the expected account", () => {
    const value = checkpoint({
      cloud: "finalizing",
      owner: {
        id: "tab-a",
        leaseExpiresAt: new Date(
          updatedAtMs + ACCOUNT_ERASURE_OWNER_LEASE_MS,
        ).toISOString(),
      },
    });

    expect(
      parseAccountErasureCheckpoint(value, "account-a", updatedAtMs),
    ).toEqual(value);
  });

  it("rejects a checkpoint from a different account scope", () => {
    expect(() =>
      parseAccountErasureCheckpoint(
        checkpoint(),
        "account-b",
        updatedAtMs,
      ),
    ).toThrow(/belongs to another account scope/i);
  });

  it("rejects malformed state and a future checkpoint", () => {
    expect(() =>
      parseAccountErasureCheckpoint({
        ...checkpoint(),
        persistenceGeneration: -1,
      }, "account-a", updatedAtMs),
    ).toThrow(/invalid state/i);

    expect(() =>
      parseAccountErasureCheckpoint({
        ...checkpoint(),
        updatedAt: new Date(
          updatedAtMs + ACCOUNT_ERASURE_FUTURE_TOLERANCE_MS + 1,
        ).toISOString(),
      }, "account-a", updatedAtMs),
    ).toThrow(/future updated timestamp/i);
  });

  it("requires finalizing ownership and bounds that lease to its update", () => {
    expect(() =>
      parseAccountErasureCheckpoint({
        ...checkpoint(),
        cloud: "finalizing",
      }, "account-a", updatedAtMs),
    ).toThrow(/no owner lease/i);

    expect(() =>
      parseAccountErasureCheckpoint({
        ...checkpoint(),
        cloud: "complete",
        owner: {
          id: "tab-a",
          leaseExpiresAt: new Date(
            updatedAtMs + ACCOUNT_ERASURE_OWNER_LEASE_MS,
          ).toISOString(),
        },
      }, "account-a", updatedAtMs),
    ).toThrow(/invalid owner lease/i);

    expect(() =>
      parseAccountErasureCheckpoint({
        ...checkpoint(),
        cloud: "finalizing",
        owner: {
          id: "tab-a",
          leaseExpiresAt: new Date(
            updatedAtMs + ACCOUNT_ERASURE_OWNER_LEASE_MS * 2 + 1,
          ).toISOString(),
        },
      }, "account-a", updatedAtMs),
    ).toThrow(/invalid owner lease/i);
  });

  it("validates the complete legacy envelope before returning any entry", () => {
    const valid = {
      version: 1,
      checkpoints: [
        {
          accountId: "account-a",
          cloud: "complete",
          local: "complete",
          updatedAt,
        },
      ],
    };
    expect(parseLegacyAccountErasureCheckpoints(valid, updatedAtMs))
      .toEqual(valid);

    expect(() =>
      parseLegacyAccountErasureCheckpoints({
        version: 1,
        checkpoints: [
          valid.checkpoints[0],
          { ...valid.checkpoints[0], cloud: "pending" },
        ],
      }, updatedAtMs),
    ).toThrow(/repeats an account identifier/i);

    expect(() =>
      parseLegacyAccountErasureCheckpoints({
        version: 1,
        checkpoints: [{
          ...valid.checkpoints[0],
          accountId: "anonymous",
        }],
      }, updatedAtMs),
    ).toThrow(/anonymous workspace/i);
  });
});

describe("account-erasure checkpoint state helpers", () => {
  it("updates only cleanup state and time without mutating durable identity", () => {
    const current = checkpoint();
    const next = updateAccountErasureCheckpoint(
      current,
      { cloud: "finalizing", owner: {
        id: "tab-a",
        leaseExpiresAt: new Date(
          updatedAtMs + ACCOUNT_ERASURE_OWNER_LEASE_MS,
        ).toISOString(),
      } },
      updatedAtMs + 1_000,
    );

    expect(next).toMatchObject({
      accountId: current.accountId,
      attemptId: current.attemptId,
      persistenceGeneration: current.persistenceGeneration,
      cloud: "finalizing",
      owner: { id: "tab-a" },
      updatedAt: new Date(updatedAtMs + 1_000).toISOString(),
    });
    expect(current).toEqual(checkpoint());
  });

  it("treats lease expiry as a query and never changes the checkpoint", () => {
    const current = checkpoint({
      cloud: "finalizing",
      owner: {
        id: "tab-a",
        leaseExpiresAt: new Date(
          updatedAtMs + ACCOUNT_ERASURE_OWNER_LEASE_MS,
        ).toISOString(),
      },
    });

    expect(finalizingErasureLeaseExpired(
      current,
      updatedAtMs + ACCOUNT_ERASURE_OWNER_LEASE_MS - 1,
    )).toBe(false);
    expect(finalizingErasureLeaseExpired(
      current,
      updatedAtMs + ACCOUNT_ERASURE_OWNER_LEASE_MS,
    )).toBe(true);
    expect(current.cloud).toBe("finalizing");
  });

  it("selects only locally pending settled cloud work", () => {
    const pendingCloud = checkpoint();
    const locallyComplete = checkpoint({
      attemptId: "attempt-b",
      cloud: "complete",
      local: "complete",
    });
    const actionable = checkpoint({
      attemptId: "attempt-c",
      cloud: "ambiguous",
    });

    expect(actionableLocalErasureCheckpoint([
      pendingCloud,
      locallyComplete,
      actionable,
    ])).toBe(actionable);
  });

  it("keeps terminal markers quiet and incomplete cleanup recoverable", () => {
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
});
