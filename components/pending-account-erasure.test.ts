import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_ERASURE_FENCE_BLOCKED_MESSAGE,
  exactAccountProvesAmbiguousDeletionFailed,
  hasAnonymousAccountErasureTombstone,
  selectAccountErasureRecoveryCheckpoint,
  shouldFinalizeCompletedTerminalAccount,
} from "@/components/pending-account-erasure";
import type { AccountErasureCheckpoint } from "@/lib/account-erasure";

const at = "2026-07-22T12:00:00.000Z";

function checkpoint(
  accountId: string,
  patch: Partial<AccountErasureCheckpoint> = {},
): AccountErasureCheckpoint {
  return {
    version: 2,
    accountId,
    attemptId: `attempt-${accountId}`,
    cloud: "complete",
    local: "complete",
    session: "complete",
    persistenceGeneration: 2,
    backup: null,
    owner: null,
    updatedAt: at,
    ...patch,
  };
}

describe("provider-bound account-erasure recovery selection", () => {
  it("blocks automatic repair only for a tombstoned anonymous scope", () => {
    expect(hasAnonymousAccountErasureTombstone([
      { accountId: "account-a", tombstoned: true },
      { accountId: "anonymous", tombstoned: false },
    ])).toBe(false);
    expect(hasAnonymousAccountErasureTombstone([
      { accountId: "anonymous", tombstoned: true },
    ])).toBe(true);
    expect(ANONYMOUS_ERASURE_FENCE_BLOCKED_MESSAGE).toMatch(/automatic repair is disabled/i);
  });

  it("keeps an all-complete marker actionable only for its exact terminal session", () => {
    const complete = checkpoint("account-a");

    expect(selectAccountErasureRecoveryCheckpoint(
      [complete],
      "account-a",
      "account-a",
    )).toBe(complete);
    expect(selectAccountErasureRecoveryCheckpoint(
      [complete],
      null,
      null,
    )).toBeNull();
    expect(selectAccountErasureRecoveryCheckpoint(
      [complete],
      "account-b",
      null,
    )).toBeNull();
  });

  it("prioritizes the exact terminal account over unrelated inactive cleanup", () => {
    const exactComplete = checkpoint("account-a");
    const unrelatedPending = checkpoint("account-b", {
      local: "pending",
      session: "pending",
    });

    expect(selectAccountErasureRecoveryCheckpoint(
      [unrelatedPending, exactComplete],
      "account-a",
      "account-a",
    )).toBe(exactComplete);
  });
});

describe("completed terminal-account outcomes", () => {
  it("finalizes a proven-complete exact terminal account even after local and session cleanup completed", () => {
    const complete = checkpoint("account-a");

    expect(shouldFinalizeCompletedTerminalAccount(
      complete,
      "account-a",
      "account-a",
    )).toBe(true);
    expect(shouldFinalizeCompletedTerminalAccount(
      complete,
      "account-b",
      "account-a",
    )).toBe(false);
  });

  it("requires explicit cloud retry instead of finalizing when exact re-auth proves an ambiguous account still exists", () => {
    const ambiguous = checkpoint("account-a", { cloud: "ambiguous" });

    expect(exactAccountProvesAmbiguousDeletionFailed(
      ambiguous,
      "account-a",
    )).toBe(true);
    expect(exactAccountProvesAmbiguousDeletionFailed(
      ambiguous,
      "account-b",
    )).toBe(false);
    expect(shouldFinalizeCompletedTerminalAccount(
      ambiguous,
      "account-a",
      "account-a",
    )).toBe(false);
  });
});
