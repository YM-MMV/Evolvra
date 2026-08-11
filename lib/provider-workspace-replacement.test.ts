import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import {
  runAuthoritativeWorkspaceReplacement,
  type AuthoritativeWorkspaceReplacementPorts,
} from "@/lib/provider-workspace-replacement";
import type {
  EvidenceBlobRecord,
  EvidenceCleanupIntent,
  EvidenceCleanupIntentInput,
} from "@/lib/persistence";
import type { AppState, GoalFileEvidence } from "@/lib/types";

const ACCOUNT_ID = "user-a";
const GOAL_ID = "goal-a";
const EVIDENCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REMOTE_PATH = `${ACCOUNT_ID}/${GOAL_ID}/${EVIDENCE_ID}/proof.txt`;

function copyState(value: AppState): AppState {
  return JSON.parse(JSON.stringify(value)) as AppState;
}

function fileEvidence(remotePath = REMOTE_PATH): GoalFileEvidence {
  return {
    id: EVIDENCE_ID,
    type: "file",
    name: "proof.txt",
    mimeType: "text/plain",
    size: 5,
    remotePath,
  };
}

function workspace(evidence: GoalFileEvidence[] = [fileEvidence()]): AppState {
  const state = copyState(EMPTY_STATE);
  state.goals = [{
    id: GOAL_ID,
    title: "Evidence",
    description: "",
    areaId: "area-growth",
    model: "open",
    priority: "medium",
    status: "active",
    createdAt: "2026-08-09T12:00:00.000Z",
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

function localEvidence(): EvidenceBlobRecord {
  return {
    accountId: ACCOUNT_ID,
    goalId: GOAL_ID,
    evidenceId: EVIDENCE_ID,
    blob: new Blob(["proof"], { type: "text/plain" }),
    savedAt: "2026-08-09T12:00:00.000Z",
    writeId: "write-one",
  };
}

function cleanupIntent(
  input: EvidenceCleanupIntentInput,
  index: number,
): EvidenceCleanupIntent {
  return {
    kind: "cleanup",
    token: `cleanup-${index}`,
    accountId: input.accountId,
    goalId: input.goalId,
    evidenceId: input.evidenceId,
    createdAt: `2026-08-09T12:00:0${index}.000Z`,
    ...(input.expectedWriteId ? { expectedWriteId: input.expectedWriteId } : {}),
    ...(input.remotePath ? { remotePath: input.remotePath } : {}),
  };
}

describe("authoritative workspace replacement cleanup", () => {
  let events: string[];
  let ports: AuthoritativeWorkspaceReplacementPorts<string>;

  beforeEach(() => {
    events = [];
    let staged = 0;
    ports = {
      listLocalEvidence: async () => {
        events.push("list");
        return [localEvidence()];
      },
      stageCleanup: async (input) => {
        events.push("stage");
        staged += 1;
        return cleanupIntent(input, staged);
      },
      cancelCleanup: async () => {
        events.push("cancel");
      },
      persistTarget: async () => {
        events.push("persist");
        return "committed";
      },
    };
  });

  it("stages exact cleanup before persistence and retains it after commit", async () => {
    const result = await runAuthoritativeWorkspaceReplacement({
      accountId: ACCOUNT_ID,
      sourceStates: [workspace()],
      targetStates: [workspace([])],
    }, ports);

    expect(events).toEqual(["list", "stage", "persist"]);
    expect(result.result).toBe("committed");
    expect(result.cleanupIntents).toEqual([expect.objectContaining({
      expectedWriteId: "write-one",
      remotePath: REMOTE_PATH,
    })]);
  });

  it("does not stage cleanup for evidence retained by the target", async () => {
    const result = await runAuthoritativeWorkspaceReplacement({
      accountId: ACCOUNT_ID,
      sourceStates: [workspace()],
      targetStates: [workspace()],
    }, ports);

    expect(events).toEqual(["list", "persist"]);
    expect(result.cleanupIntents).toEqual([]);
  });

  it("cancels staged intents when a later stage fails", async () => {
    const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const secondPath = `${ACCOUNT_ID}/${GOAL_ID}/${secondId}/second.txt`;
    const source = workspace([
      fileEvidence(),
      { ...fileEvidence(secondPath), id: secondId, name: "second.txt" },
    ]);
    ports.listLocalEvidence = async () => [localEvidence()];
    ports.stageCleanup = vi.fn(async (input) => {
      events.push("stage");
      if (input.evidenceId === secondId) throw new Error("stage failed");
      return cleanupIntent(input, 1);
    });
    const persistTarget = vi.fn(ports.persistTarget);
    ports.persistTarget = persistTarget;

    await expect(runAuthoritativeWorkspaceReplacement({
      accountId: ACCOUNT_ID,
      sourceStates: [source],
      targetStates: [workspace([])],
    }, ports)).rejects.toThrow("stage failed");

    expect(events).toEqual(["stage", "stage", "cancel"]);
    expect(persistTarget).not.toHaveBeenCalled();
  });

  it("cancels every staged intent when persistence fails", async () => {
    ports.persistTarget = async () => {
      events.push("persist");
      throw new Error("local CAS failed");
    };

    await expect(runAuthoritativeWorkspaceReplacement({
      accountId: ACCOUNT_ID,
      sourceStates: [workspace()],
      targetStates: [workspace([])],
    }, ports)).rejects.toThrow("local CAS failed");

    expect(events).toEqual(["list", "stage", "persist", "cancel"]);
  });

  it("reports the original and cancellation failures together", async () => {
    ports.persistTarget = async () => {
      throw new Error("local CAS failed");
    };
    ports.cancelCleanup = async () => {
      throw new Error("journal cancellation failed");
    };

    const operation = runAuthoritativeWorkspaceReplacement({
      accountId: ACCOUNT_ID,
      sourceStates: [workspace()],
      targetStates: [workspace([])],
    }, ports);
    await expect(operation).rejects.toBeInstanceOf(AggregateError);
    await expect(operation).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "local CAS failed" }),
        expect.objectContaining({ message: "journal cancellation failed" }),
      ],
    });
  });
});
