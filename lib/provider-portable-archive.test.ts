import { describe, expect, it, vi } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import {
  createCompletePortableArchive,
  PortableArchiveScopeChangedError,
  type PortableArchiveOperationBoundary,
} from "@/lib/provider-portable-archive";
import type { EvidenceBlobRecord } from "@/lib/persistence";
import type { AppState, GoalFileEvidence } from "@/lib/types";

const NOW = "2026-07-29T12:00:00.000Z";
const ACCOUNT_ID = "account-a";

const clone = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

function fileEvidence(
  id = "proof",
  remote = true,
): GoalFileEvidence {
  return {
    id,
    type: "file",
    name: `${id}.txt`,
    mimeType: "text/plain",
    size: 5,
    ...(remote
      ? { remotePath: `${ACCOUNT_ID}/goal-a/${id}/${id}.txt` }
      : {}),
  };
}

function workspace(
  evidence: GoalFileEvidence[] = [fileEvidence()],
): AppState {
  return {
    ...clone(EMPTY_STATE),
    updatedAt: NOW,
    profile: {
      ...clone(EMPTY_STATE.profile),
      displayName: "Archive owner",
      onboarded: true,
    },
    goals: [{
      id: "goal-a",
      title: "Keep the proof portable",
      description: "",
      areaId: EMPTY_STATE.areas[0]?.id ?? "health",
      model: "open",
      priority: "high",
      status: "active",
      createdAt: NOW,
      metrics: [],
      milestones: [],
      quests: [],
      statIds: [],
      checkIns: [],
      evidence,
      notes: "",
    }],
  };
}

function record(
  goalId: string,
  evidenceId: string,
  contents = "proof",
): EvidenceBlobRecord {
  return {
    accountId: ACCOUNT_ID,
    goalId,
    evidenceId,
    blob: new Blob([contents], { type: "text/plain" }),
    savedAt: NOW,
  };
}

const boundary: PortableArchiveOperationBoundary = {
  accountId: ACCOUNT_ID,
  authenticatedAccountId: ACCOUNT_ID,
  persistenceGeneration: 7,
};

describe("complete portable archive collection", () => {
  it("uses exact local bytes without contacting private cloud Storage", async () => {
    const downloadRemoteEvidence = vi.fn();
    const requireExactAuthenticatedAccount = vi.fn();
    const artifact = await createCompletePortableArchive({
      state: workspace(),
      boundary,
      createdAt: NOW,
      isCurrent: () => true,
      listLocalEvidence: async () => [record("goal-a", "proof")],
      requireExactAuthenticatedAccount,
      downloadRemoteEvidence,
    });

    expect(artifact.report.complete).toBe(true);
    expect(artifact.report.includedEvidence).toHaveLength(1);
    expect(requireExactAuthenticatedAccount).not.toHaveBeenCalled();
    expect(downloadRemoteEvidence).not.toHaveBeenCalled();
  });

  it("downloads a remote-only file only after verifying the exact account", async () => {
    const events: string[] = [];
    const artifact = await createCompletePortableArchive({
      state: workspace(),
      boundary,
      createdAt: NOW,
      isCurrent: () => true,
      listLocalEvidence: async () => [],
      requireExactAuthenticatedAccount: async (accountId) => {
        events.push(`auth:${accountId}`);
      },
      downloadRemoteEvidence: async (path) => {
        events.push(`download:${path}`);
        return new Blob(["proof"], { type: "text/plain" });
      },
    });

    expect(artifact.report.complete).toBe(true);
    expect(events).toEqual([
      `auth:${ACCOUNT_ID}`,
      `download:${ACCOUNT_ID}/goal-a/proof/proof.txt`,
      `auth:${ACCOUNT_ID}`,
    ]);
  });

  it("refuses to return an incomplete artifact as a successful full backup", async () => {
    await expect(createCompletePortableArchive({
      state: workspace([fileEvidence("device-only", false)]),
      boundary: { ...boundary, authenticatedAccountId: null },
      createdAt: NOW,
      isCurrent: () => true,
      listLocalEvidence: async () => [],
      requireExactAuthenticatedAccount: vi.fn(),
      downloadRemoteEvidence: vi.fn(),
    })).rejects.toMatchObject({
      name: "IncompletePortableArchiveError",
      report: {
        complete: false,
        missingEvidence: [{
          goalId: "goal-a",
          evidenceId: "device-only",
          key: "evidence/goal-a/device-only",
        }],
      },
    });
  });

  it("rejects a scope change after an awaited remote fallback", async () => {
    let current = true;
    await expect(createCompletePortableArchive({
      state: workspace(),
      boundary,
      createdAt: NOW,
      isCurrent: () => current,
      listLocalEvidence: async () => [],
      requireExactAuthenticatedAccount: async () => undefined,
      downloadRemoteEvidence: async () => {
        current = false;
        return new Blob(["proof"], { type: "text/plain" });
      },
    })).rejects.toBeInstanceOf(PortableArchiveScopeChangedError);
  });
});
