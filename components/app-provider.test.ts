import { describe, expect, it, vi } from "vitest";
import {
  adoptExistingAccountErasureFence,
  prepareAnonymousHandoffEvidenceCopies,
  settleOutgoingWorkspaceWrite,
  workspaceNoticeForActiveAccount,
} from "@/lib/provider-account-boundaries";
import { EMPTY_STATE } from "@/lib/defaults";
import { remoteEvidencePath } from "@/lib/provider-evidence";
import { LocalWorkspaceConflictError, PersistenceError } from "@/lib/persistence";
import { workspaceStatesEqual } from "@/lib/provider-state";
import type { GoalFileEvidence } from "@/lib/types";
import type { WorkspaceFileEvidenceCopy } from "@/lib/workspace-merge";

function fileEvidence(evidenceId: string, path: string): GoalFileEvidence {
  return {
    id: evidenceId,
    type: "file",
    name: "proof.pdf",
    mimeType: "application/pdf",
    size: 120,
    remotePath: path,
  };
}

const EVIDENCE_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVIDENCE_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function evidenceCopy(remotePath?: string): WorkspaceFileEvidenceCopy {
  return {
    sourceGoalId: "goal-1",
    sourceEvidenceId: EVIDENCE_ONE,
    mergedGoalId: "merged-goal-1",
    mergedEvidenceId: EVIDENCE_TWO,
    source: {
      ...fileEvidence(EVIDENCE_ONE, remotePath ?? ""),
      ...(remotePath ? { remotePath } : { remotePath: undefined }),
    },
  };
}

describe("owned remote evidence paths", () => {
  it("accepts only the exact signed-in account, goal, and evidence prefix", () => {
    const validPath = `user-a/goal-1/${EVIDENCE_ONE}/proof.pdf`;
    const value = fileEvidence(EVIDENCE_ONE, validPath);

    expect(remoteEvidencePath(value, "user-a", "goal-1")).toBe(validPath);
    expect(remoteEvidencePath(value, "user-b", "goal-1")).toBeUndefined();
    expect(remoteEvidencePath(value, "user-a", "goal-2")).toBeUndefined();
    expect(remoteEvidencePath(fileEvidence(
      EVIDENCE_TWO,
      validPath,
    ), "user-a", "goal-1")).toBeUndefined();
  });

  it("rejects missing, nested, and traversal-like paths", () => {
    expect(remoteEvidencePath({ ...fileEvidence(EVIDENCE_ONE, ""), remotePath: undefined }, "user-a", "goal-1")).toBeUndefined();
    expect(remoteEvidencePath(fileEvidence(
      EVIDENCE_ONE,
      `user-a/goal-1/${EVIDENCE_ONE}/folder/proof.pdf`,
    ), "user-a", "goal-1")).toBeUndefined();
    expect(remoteEvidencePath(fileEvidence(
      EVIDENCE_ONE,
      `user-a/goal-1/${EVIDENCE_ONE}/..`,
    ), "user-a", "goal-1")).toBeUndefined();
  });
});

describe("anonymous handoff evidence preparation", () => {
  const savedAt = "2026-07-22T12:00:00.000Z";
  const localBlob = new Blob([new Uint8Array(120)], { type: "application/pdf" });

  it("verifies local bytes and remaps them without changing the source key", async () => {
    const downloadRemote = vi.fn<(path: string) => Promise<Blob>>();
    const result = await prepareAnonymousHandoffEvidenceCopies({
      copies: [evidenceCopy()],
      sourceAccountId: "anonymous",
      targetAccountId: "user-a",
      savedAt,
      isCurrent: () => true,
      readSource: async (accountId, goalId, evidenceId) => ({
        accountId,
        goalId,
        evidenceId,
        blob: localBlob,
        savedAt: "2026-07-21T10:00:00.000Z",
      }),
      downloadRemote,
    });

    expect(result).toEqual([{
      accountId: "user-a",
      goalId: "merged-goal-1",
      evidenceId: EVIDENCE_TWO,
      blob: localBlob,
      savedAt,
    }]);
    expect(downloadRemote).not.toHaveBeenCalled();
  });

  it("downloads only an exact authenticated-account path when local bytes are unavailable", async () => {
    const path = `user-a/goal-1/${EVIDENCE_ONE}/proof.pdf`;
    const downloadRemote = vi.fn(async () => localBlob);
    const result = await prepareAnonymousHandoffEvidenceCopies({
      copies: [evidenceCopy(path)],
      sourceAccountId: "anonymous",
      targetAccountId: "user-a",
      savedAt,
      isCurrent: () => true,
      readSource: async () => null,
      downloadRemote,
    });

    expect(downloadRemote).toHaveBeenCalledOnce();
    expect(downloadRemote).toHaveBeenCalledWith(path);
    expect(result[0]).toMatchObject({
      accountId: "user-a",
      goalId: "merged-goal-1",
      evidenceId: EVIDENCE_TWO,
    });
  });

  it("uses an exact remote copy when the local evidence record is corrupt", async () => {
    const path = `user-a/goal-1/${EVIDENCE_ONE}/proof.pdf`;
    const downloadRemote = vi.fn(async () => localBlob);
    await expect(prepareAnonymousHandoffEvidenceCopies({
      copies: [evidenceCopy(path)],
      sourceAccountId: "anonymous",
      targetAccountId: "user-a",
      savedAt,
      isCurrent: () => true,
      readSource: async () => {
        throw new PersistenceError(
          "invalid-data",
          "read-evidence",
          "The local record is corrupt.",
        );
      },
      downloadRemote,
    })).resolves.toHaveLength(1);
    expect(downloadRemote).toHaveBeenCalledWith(path);
  });

  it("aborts before download when neither local bytes nor a target-owned source path can be verified", async () => {
    const downloadRemote = vi.fn(async () => localBlob);
    await expect(prepareAnonymousHandoffEvidenceCopies({
      copies: [evidenceCopy(`another-account/goal-1/${EVIDENCE_ONE}/proof.pdf`)],
      sourceAccountId: "anonymous",
      targetAccountId: "user-a",
      savedAt,
      isCurrent: () => true,
      readSource: async () => null,
      downloadRemote,
    })).rejects.toThrow(/no verified device copy or safe path/i);
    expect(downloadRemote).not.toHaveBeenCalled();
  });

  it("aborts a stale handoff immediately after an asynchronous source read", async () => {
    let current = true;
    await expect(prepareAnonymousHandoffEvidenceCopies({
      copies: [evidenceCopy()],
      sourceAccountId: "anonymous",
      targetAccountId: "user-a",
      savedAt,
      isCurrent: () => current,
      readSource: async (accountId, goalId, evidenceId) => {
        current = false;
        return {
          accountId,
          goalId,
          evidenceId,
          blob: localBlob,
          savedAt,
        };
      },
      downloadRemote: async () => localBlob,
    })).rejects.toThrow(/account changed/i);
  });
});

describe("authoritative workspace comparison", () => {
  it("ignores object key ordering while preserving array ordering", () => {
    const reordered = JSON.parse(JSON.stringify(EMPTY_STATE)) as Record<string, unknown>;
    const reverseKeys = (value: Record<string, unknown>) => Object.fromEntries(
      Object.entries(value).reverse(),
    );
    const keyReordered = reverseKeys(reordered);

    expect(workspaceStatesEqual(
      EMPTY_STATE,
      keyReordered as unknown as typeof EMPTY_STATE,
    )).toBe(true);
    expect(workspaceStatesEqual(
      EMPTY_STATE,
      { ...EMPTY_STATE, areas: [...EMPTY_STATE.areas].reverse() },
    )).toBe(false);
  });
});

describe("account transition isolation", () => {
  it("continues opening the destination after the outgoing workspace loses local CAS", async () => {
    const outgoingConflict = new LocalWorkspaceConflictError("account-a", 4, 5);

    await expect(settleOutgoingWorkspaceWrite("account-a", async () => {
      throw outgoingConflict;
    })).resolves.toBe("conflicted");
  });

  it("does not swallow a conflict for any scope except the outgoing workspace", async () => {
    const destinationConflict = new LocalWorkspaceConflictError("account-b", 2, 3);

    await expect(settleOutgoingWorkspaceWrite("account-a", async () => {
      throw destinationConflict;
    })).rejects.toBe(destinationConflict);
  });

  it("never exposes an outgoing account recovery notice during or after a switch", () => {
    const outgoingNotice = {
      accountId: "account-a",
      message: "Account A changed in another tab.",
    };

    expect(workspaceNoticeForActiveAccount(
      outgoingNotice,
      "account-a",
      true,
    )).toBeNull();
    expect(workspaceNoticeForActiveAccount(
      outgoingNotice,
      "account-b",
      false,
    )).toBeNull();
    expect(workspaceNoticeForActiveAccount(
      outgoingNotice,
      "account-a",
      false,
    )).toBe(outgoingNotice);
  });
});

describe("existing account-erasure fence adoption", () => {
  it("closes the writer barrier before awaiting a drain and accepts only the exact tombstone", async () => {
    const events: string[] = [];
    let releaseDrain!: () => void;
    const draining = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const adoption = adoptExistingAccountErasureFence({
      expectedAccountId: "account-a",
      tombstonedGeneration: 4,
      closeWriterBarrier: () => { events.push("barrier"); },
      drainWriters: async () => {
        events.push("drain");
        await draining;
      },
      readScope: async () => {
        events.push("read");
        return {
          accountId: "account-a",
          generation: 4,
          evidenceRevision: 0,
          tombstoned: true,
          updatedAt: "2026-07-22T12:00:00.000Z",
        };
      },
    });

    expect(events).toEqual(["barrier", "drain"]);
    releaseDrain();
    await expect(adoption).resolves.toMatchObject({
      accountId: "account-a",
      generation: 4,
      tombstoned: true,
    });
    expect(events).toEqual(["barrier", "drain", "read"]);
  });

  it.each([
    ["another account", { accountId: "account-b", generation: 4, tombstoned: true }],
    ["an old generation", { accountId: "account-a", generation: 3, tombstoned: true }],
    ["an unfenced scope", { accountId: "account-a", generation: 4, tombstoned: false }],
  ])("keeps recovery rejected for %s", async (_label, scope) => {
    let barrierClosed = false;
    await expect(adoptExistingAccountErasureFence({
      expectedAccountId: "account-a",
      tombstonedGeneration: 4,
      closeWriterBarrier: () => { barrierClosed = true; },
      drainWriters: async () => undefined,
      readScope: async () => ({
        ...scope,
        evidenceRevision: 0,
        updatedAt: "2026-07-22T12:00:00.000Z",
      }),
    })).rejects.toThrow(/does not match/i);
    expect(barrierClosed).toBe(true);
  });
});
