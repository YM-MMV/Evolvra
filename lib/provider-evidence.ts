import {
  deleteEvidenceBlob,
  readEvidenceBlob,
  storeEvidenceBlob,
  type EvidenceBlobRecord,
  type PersistenceScopeGeneration,
} from "@/lib/persistence";
import {
  isStructurallyValidRemoteEvidencePath,
  migrationDataUrlBlob,
  migrationDataUrl,
} from "@/lib/goal-evidence";
import { cloneWorkspaceValue } from "@/lib/provider-state";
import type { AppState, GoalEvidence, GoalFileEvidence } from "@/lib/types";

export interface StagedEvidenceWrite {
  accountId: string;
  goalId: string;
  evidenceId: string;
  scopeGeneration: PersistenceScopeGeneration;
  /** Restored if a later migration step fails; absent means this key was new. */
  previous?: EvidenceBlobRecord;
}

export interface ExternalizedEvidence {
  state: AppState;
  changed: boolean;
  createdEvidence: StagedEvidenceWrite[];
}

/**
 * Produces an account-neutral workspace document for user-selected backups.
 * Private Storage paths are capabilities scoped to the account that created
 * them, so they must never cross the JSON export/import boundary.
 */
export function portableWorkspaceState(source: AppState): AppState {
  const state = cloneWorkspaceValue(source);
  for (const goal of state.goals) {
    goal.evidence = goal.evidence.map((item) => {
      if (item.type !== "file") return item;
      const portable = { ...item };
      delete portable.remotePath;
      return portable;
    });
  }
  return state;
}

async function rollbackOrThrowOriginal(
  error: unknown,
  writes: StagedEvidenceWrite[],
  message: string,
): Promise<never> {
  try {
    await rollbackEvidenceWrites(writes);
  } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], message);
  }
  throw error;
}

export async function rollbackEvidenceWrites(createdEvidence: StagedEvidenceWrite[]) {
  const failures: unknown[] = [];
  for (const item of [...createdEvidence].reverse()) {
    try {
      if (item.previous) {
        await storeEvidenceBlob(item.previous, item.scopeGeneration);
      } else {
        await deleteEvidenceBlob(
          item.accountId,
          item.goalId,
          item.evidenceId,
          item.scopeGeneration,
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "One or more staged evidence writes could not be rolled back.");
}

export async function externalizeEmbeddedEvidence(
  source: AppState,
  accountId: string,
  scopeGeneration: PersistenceScopeGeneration,
): Promise<ExternalizedEvidence> {
  const state = cloneWorkspaceValue(source);
  let changed = false;
  const createdEvidence: StagedEvidenceWrite[] = [];
  try {
    for (const goal of state.goals) {
      const evidence: GoalEvidence[] = [];
      for (const item of goal.evidence) {
        if (item.type !== "file") {
          evidence.push(item);
          continue;
        }
        const dataUrl = migrationDataUrl(item);
        if (!dataUrl) {
          evidence.push(item);
          continue;
        }
        const blob = migrationDataUrlBlob(dataUrl, item);
        if (!blob) {
          throw new Error("Legacy embedded evidence did not match its validated file metadata.");
        }
        const previous = await readEvidenceBlob(
          accountId,
          goal.id,
          item.id,
          scopeGeneration,
        );
        await storeEvidenceBlob(
          { accountId, goalId: goal.id, evidenceId: item.id, blob },
          scopeGeneration,
        );
        createdEvidence.push({
          accountId,
          goalId: goal.id,
          evidenceId: item.id,
          scopeGeneration,
          ...(previous ? { previous } : {}),
        });
        evidence.push({
          id: item.id,
          type: "file",
          name: item.name,
          mimeType: item.mimeType,
          size: item.size,
          ...(item.remotePath ? { remotePath: item.remotePath } : {}),
        });
        changed = true;
      }
      goal.evidence = evidence;
    }
  } catch (error) {
    return rollbackOrThrowOriginal(
      error,
      createdEvidence,
      "Embedded evidence migration failed and staged files could not be fully restored.",
    );
  }
  return { state, changed, createdEvidence };
}

export async function rollbackExternalizedEvidence(result: ExternalizedEvidence) {
  await rollbackEvidenceWrites(result.createdEvidence);
}

export interface ExternalizedWorkspaceHistory extends ExternalizedEvidence {
  history: AppState[];
}

/**
 * Externalizes both the active snapshot and every retained undo snapshot. This
 * prevents legacy base64 payloads from being re-persisted through recovery.
 */
export async function externalizeWorkspaceHistory(
  source: AppState,
  sourceHistory: readonly AppState[],
  accountId: string,
  scopeGeneration: PersistenceScopeGeneration,
): Promise<ExternalizedWorkspaceHistory> {
  const completed: ExternalizedEvidence[] = [];
  try {
    const current = await externalizeEmbeddedEvidence(source, accountId, scopeGeneration);
    completed.push(current);
    const history: AppState[] = [];
    for (const snapshot of sourceHistory) {
      const result = await externalizeEmbeddedEvidence(snapshot, accountId, scopeGeneration);
      completed.push(result);
      history.push(result.state);
    }
    return {
      state: current.state,
      history,
      changed: completed.some((result) => result.changed),
      createdEvidence: completed.flatMap((result) => result.createdEvidence),
    };
  } catch (error) {
    return rollbackOrThrowOriginal(
      error,
      completed.flatMap((result) => result.createdEvidence),
      "Workspace evidence migration failed and prior staged files could not be fully restored.",
    );
  }
}

export function remoteEvidencePath(value: GoalFileEvidence, accountId: string, goalId: string) {
  const path = value.remotePath;
  if (!path || !isStructurallyValidRemoteEvidencePath(path, value.id, goalId)) return undefined;
  const prefix = `${accountId}/${goalId}/${value.id}/`;
  return path.startsWith(prefix) ? path : undefined;
}
