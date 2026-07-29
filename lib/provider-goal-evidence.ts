import { EvidenceCompensationError, type RemoteEvidenceSnapshot } from "@/lib/evidence-operation-journal";
import { normalizedEvidenceBlob, validateGoalEvidenceList } from "@/lib/goal-evidence";
import { remoteEvidencePath } from "@/lib/provider-evidence";
import type {
  EvidenceBlobRecord,
  PersistenceScopeGeneration,
} from "@/lib/persistence";
import type { AppState, GoalEvidence, GoalFileEvidence } from "@/lib/types";
import type { WorkspaceScopeKey } from "@/lib/workspace-scope";

export interface GoalEvidenceOperationScope {
  readonly workspaceScopeKey: WorkspaceScopeKey;
  readonly workspaceGeneration: WorkspaceScopeKey;
  readonly persistenceAccountId: string;
  readonly persistenceGeneration: PersistenceScopeGeneration;
  readonly authenticatedAccountId: string | null;
}

export interface GoalMetadataSnapshot {
  readonly state: AppState;
  readonly history: readonly AppState[];
}

/**
 * A goal-domain transaction boundary. Implementations must return detached
 * snapshots so a later in-memory mutation cannot change rollback data.
 */
export interface GoalEvidenceMetadataTransactions {
  readGoalEvidence(goalId: string): readonly GoalEvidence[] | undefined;
  captureWorkspace(): GoalMetadataSnapshot;
  setGoalFileEvidence(goalId: string, evidence: readonly GoalEvidence[]): void;
  deleteGoalRecords(goalId: string): void;
  restoreWorkspace(snapshot: GoalMetadataSnapshot): void;
  flushDurably(scope: GoalEvidenceOperationScope): Promise<void>;
}

export interface GoalEvidenceScopeCoordinator {
  isCurrent(scope: GoalEvidenceOperationScope): boolean;
  runExclusive<T>(
    scope: GoalEvidenceOperationScope,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface LocalGoalEvidenceRepository {
  list(
    accountId: string,
    goalId: string,
    generation: PersistenceScopeGeneration,
  ): Promise<readonly EvidenceBlobRecord[]>;
  remove(
    snapshot: EvidenceBlobRecord,
    generation: PersistenceScopeGeneration,
  ): Promise<void>;
  restore(
    snapshot: EvidenceBlobRecord,
    generation: PersistenceScopeGeneration,
  ): Promise<void>;
}

export interface RemoteGoalEvidenceRepository {
  assertWriteAllowed(): void;
  download(path: string): Promise<Blob>;
  remove(paths: readonly string[]): Promise<void>;
  restore(snapshot: RemoteEvidenceSnapshot): Promise<void>;
}

export interface GoalEvidenceActionPorts {
  readonly metadata: GoalEvidenceMetadataTransactions;
  readonly scope: GoalEvidenceScopeCoordinator;
  readonly localEvidence: LocalGoalEvidenceRepository;
  readonly remoteEvidence: RemoteGoalEvidenceRepository;
}

export interface SetGoalFileEvidenceRequest {
  readonly goalId: string;
  readonly evidence: readonly GoalEvidence[];
  readonly scope: GoalEvidenceOperationScope;
}

export interface DeleteGoalRequest {
  readonly goalId: string;
  readonly scope: GoalEvidenceOperationScope;
}

function copyEvidence(evidence: readonly GoalEvidence[]): GoalEvidence[] {
  return evidence.map((item) => ({ ...item }));
}

function assertCurrentScope(
  coordinator: GoalEvidenceScopeCoordinator,
  scope: GoalEvidenceOperationScope,
  message: string,
) {
  if (!coordinator.isCurrent(scope)) throw new Error(message);
}

async function restoreEvidenceBytes(
  local: readonly EvidenceBlobRecord[],
  remote: readonly RemoteEvidenceSnapshot[],
  persistenceGeneration: PersistenceScopeGeneration,
  repositories: Pick<GoalEvidenceActionPorts, "localEvidence" | "remoteEvidence">,
) {
  const failures: unknown[] = [];
  for (const snapshot of remote) {
    try {
      await repositories.remoteEvidence.restore(snapshot);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const snapshot of local) {
    try {
      await repositories.localEvidence.restore(snapshot, persistenceGeneration);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export function createGoalEvidenceActions({
  metadata,
  scope: scopeCoordinator,
  localEvidence,
  remoteEvidence,
}: GoalEvidenceActionPorts) {
  return {
    async setGoalFileEvidence({
      goalId,
      evidence,
      scope,
    }: SetGoalFileEvidenceRequest): Promise<void> {
      assertCurrentScope(
        scopeCoordinator,
        scope,
        "The active workspace changed before the file update finished.",
      );
      const currentEvidence = metadata.readGoalEvidence(goalId);
      if (!currentEvidence) {
        throw new Error("The file's goal no longer exists in this workspace.");
      }
      const previousEvidence = copyEvidence(currentEvidence);
      const safeEvidence = copyEvidence(evidence);
      validateGoalEvidenceList(safeEvidence, goalId);
      metadata.setGoalFileEvidence(goalId, safeEvidence);
      try {
        await metadata.flushDurably(scope);
      } catch (error) {
        if (scopeCoordinator.isCurrent(scope)) {
          metadata.setGoalFileEvidence(goalId, previousEvidence);
          try {
            await metadata.flushDurably(scope);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Evidence metadata could not be saved or durably restored.",
            );
          }
        }
        throw error;
      }
    },

    async deleteGoal({ goalId, scope }: DeleteGoalRequest): Promise<void> {
      return scopeCoordinator.runExclusive(scope, async () => {
        assertCurrentScope(
          scopeCoordinator,
          scope,
          "The active workspace changed before deletion could start.",
        );
        const goalEvidence = metadata.readGoalEvidence(goalId);
        if (!goalEvidence) return;

        const previousWorkspace = metadata.captureWorkspace();
        const remoteFiles = scope.authenticatedAccountId
          ? goalEvidence.filter((item): item is GoalFileEvidence => (
              item.type === "file" && Boolean(item.remotePath)
            ))
          : [];
        const remotePaths = remoteFiles.map((item) => remoteEvidencePath(
          item,
          scope.authenticatedAccountId!,
          goalId,
        ));
        if (remotePaths.some((path) => !path)) {
          throw new Error("A private evidence path is invalid. No goal data or file bytes were deleted.");
        }

        const safeRemotePaths = remotePaths.filter((path): path is string => Boolean(path));
        const remoteSnapshots: RemoteEvidenceSnapshot[] = [];
        if (safeRemotePaths.length) {
          remoteEvidence.assertWriteAllowed();
          for (let index = 0; index < safeRemotePaths.length; index += 1) {
            const blob = await remoteEvidence.download(safeRemotePaths[index]);
            const verified = normalizedEvidenceBlob(blob, remoteFiles[index]);
            if (!verified) {
              throw new Error(
                "A private evidence file did not match its recorded type and size. "
                + "No goal data or file bytes were deleted.",
              );
            }
            remoteSnapshots.push({ path: safeRemotePaths[index], blob: verified });
          }
        }

        const localSnapshots = await localEvidence.list(
          scope.persistenceAccountId,
          goalId,
          scope.persistenceGeneration,
        );
        assertCurrentScope(
          scopeCoordinator,
          scope,
          "The active workspace changed before evidence deletion could start.",
        );

        let metadataStarted = false;
        let byteDeletionStarted = false;
        try {
          metadataStarted = true;
          metadata.deleteGoalRecords(goalId);
          await metadata.flushDurably(scope);
          assertCurrentScope(
            scopeCoordinator,
            scope,
            "The active workspace changed after evidence metadata was saved.",
          );

          byteDeletionStarted = true;
          if (remoteSnapshots.length) {
            await remoteEvidence.remove(remoteSnapshots.map((snapshot) => snapshot.path));
          }
          for (const snapshot of localSnapshots) {
            await localEvidence.remove(snapshot, scope.persistenceGeneration);
          }
          assertCurrentScope(
            scopeCoordinator,
            scope,
            "The active workspace changed while evidence deletion was finishing.",
          );
        } catch (error) {
          const rollbackFailures = byteDeletionStarted
            ? await restoreEvidenceBytes(
                localSnapshots,
                remoteSnapshots,
                scope.persistenceGeneration,
                { localEvidence, remoteEvidence },
              )
            : [];

          /*
           * Metadata may point at the old snapshots only after every byte has
           * been restored. If any restore fails, retaining the durable deletion
           * is the only state that cannot reference known-missing bytes.
           */
          if (metadataStarted && rollbackFailures.length === 0) {
            try {
              assertCurrentScope(
                scopeCoordinator,
                scope,
                "The active workspace changed before goal metadata could be restored.",
              );
              metadata.restoreWorkspace(previousWorkspace);
              await metadata.flushDurably(scope);
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
          }
          if (rollbackFailures.length) {
            throw new EvidenceCompensationError(error, rollbackFailures);
          }
          throw error;
        }
      });
    },
  };
}
