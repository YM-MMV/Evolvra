import { EvidenceCompensationError } from "@/lib/evidence-operation-journal";
import {
  evidenceBlobsEqual,
  validateGoalEvidenceList,
} from "@/lib/goal-evidence";
import { remoteEvidencePath } from "@/lib/provider-evidence";
import type { RemoteEvidenceCleanupClaim } from "@/lib/provider-remote-evidence-cleanup";
import type {
  EvidenceBlobDeleteResult,
  EvidenceBlobDeletionReceipt,
  EvidenceBlobRecord,
  EvidenceCleanupIntent,
  EvidenceCleanupIntentInput,
  PersistenceScopeGeneration,
  StagedEvidenceBlobWrite,
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
  restoreWorkspace(
    snapshot: GoalMetadataSnapshot,
    expectedCurrent?: GoalMetadataSnapshot,
  ): boolean;
  flushDurably(
    scope: GoalEvidenceOperationScope,
    stagedEvidence?: readonly StagedEvidenceBlobWrite[],
  ): Promise<number>;
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
    snapshots: readonly EvidenceBlobRecord[],
    generation: PersistenceScopeGeneration,
    committedWorkspaceLocalRevision: number,
  ): Promise<EvidenceBlobDeleteResult>;
  stageCleanup(
    input: EvidenceCleanupIntentInput,
    generation: PersistenceScopeGeneration,
  ): Promise<EvidenceCleanupIntent>;
  cancelCleanup(
    intent: EvidenceCleanupIntent,
    generation: PersistenceScopeGeneration,
  ): Promise<"cancelled" | "already-absent">;
}

export interface RemoteGoalEvidenceRepository {
  assertWriteAllowed(): void;
  claim(paths: readonly string[]): Promise<RemoteEvidenceCleanupClaim>;
  remove(paths: readonly string[]): Promise<void>;
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
  readonly stagedEvidence?: readonly StagedEvidenceBlobWrite[];
}

export interface DeleteGoalRequest {
  readonly goalId: string;
  readonly scope: GoalEvidenceOperationScope;
}

export class GoalEvidenceCloudSaveAmbiguousError extends Error {
  readonly originalError: unknown;
  readonly verificationError?: unknown;

  constructor(originalError: unknown, verificationError?: unknown) {
    super("The private cloud save may have committed, but its exact result could not be verified.");
    this.name = "GoalEvidenceCloudSaveAmbiguousError";
    this.originalError = originalError;
    this.verificationError = verificationError;
  }
}

export class GoalEvidenceLocalCommitRetainedError extends Error {
  readonly localRevision: number;
  readonly cloudError: unknown;
  readonly ambiguous: boolean;

  constructor(cloudError: unknown, localRevision: number, ambiguous: boolean) {
    super(ambiguous
      ? "The file change is safe on this device while Evolvra verifies whether the private cloud save committed. Retry sync before cleaning up its cloud object."
      : "The file change is safe on this device, but its private cloud metadata is still unsynced.");
    this.name = "GoalEvidenceLocalCommitRetainedError";
    this.localRevision = localRevision;
    this.cloudError = cloudError;
    this.ambiguous = ambiguous;
  }
}

interface GoalEvidenceCloudResponse {
  readonly data: unknown;
  readonly error: unknown;
  readonly status?: unknown;
}

export async function saveGoalEvidenceCloudMetadataWithVerification({
  state,
  expectedRevision,
  save,
  readAuthoritative,
  migrateState,
  statesEqual,
  parseRevision,
}: {
  readonly state: AppState;
  readonly expectedRevision: number;
  readonly save: () => PromiseLike<GoalEvidenceCloudResponse>;
  readonly readAuthoritative: () => PromiseLike<GoalEvidenceCloudResponse>;
  readonly migrateState: (value: unknown) => AppState;
  readonly statesEqual: (left: AppState, right: AppState) => boolean;
  readonly parseRevision: (value: unknown) => number | null;
}): Promise<{ state: AppState; revision: number; updatedAt: string }> {
  const exactRow = (data: unknown) => {
    const raw = Array.isArray(data) ? data[0] : data;
    if (!raw || typeof raw !== "object") return null;
    const row = raw as { state?: unknown; revision?: unknown; updated_at?: unknown };
    const revision = parseRevision(row.revision);
    if (
      revision === null
      || revision <= expectedRevision
      || typeof row.updated_at !== "string"
    ) return null;
    const migrated = migrateState(row.state);
    return statesEqual(migrated, state)
      ? { state: migrated, revision, updatedAt: row.updated_at }
      : null;
  };

  let ambiguousError: unknown;
  let definiteError: unknown;
  try {
    const response = await save();
    if (!response.error) {
      const exact = exactRow(response.data);
      if (exact) return exact;
      ambiguousError = new Error("Private sync returned an invalid or non-exact save response.");
    } else if (response.status !== 0) {
      definiteError = response.error;
    } else {
      ambiguousError = response.error;
    }
  } catch (error) {
    ambiguousError = error;
  }
  if (definiteError !== undefined) throw definiteError;

  let verificationError: unknown;
  try {
    const verification = await readAuthoritative();
    if (verification.error) verificationError = verification.error;
    else {
      const exact = exactRow(verification.data);
      if (exact) return exact;
      verificationError = new Error("The authoritative cloud snapshot did not prove the submitted file metadata.");
    }
  } catch (error) {
    verificationError = error;
  }
  throw new GoalEvidenceCloudSaveAmbiguousError(
    ambiguousError,
    verificationError,
  );
}

export function requireEvidenceDeletionReceipt(
  result: EvidenceBlobDeleteResult,
): EvidenceBlobDeletionReceipt {
  if (result.kind === "deleted") return result.receipt;
  throw new Error(
    "A newer device copy superseded this deletion. File metadata must be restored instead of leaving unreferenced bytes.",
  );
}

export interface GoalEvidenceRemoteUploadResult {
  readonly remotePath?: string;
  readonly uploadNeedsRetry: boolean;
  readonly cleanupPending: boolean;
  readonly localCommitRetainedError?: GoalEvidenceLocalCommitRetainedError;
}

async function tryCancelEvidenceCleanup(
  intent: EvidenceCleanupIntent | null,
  cancel: (intent: EvidenceCleanupIntent) => Promise<void>,
): Promise<boolean> {
  if (!intent) return true;
  try {
    await cancel(intent);
    return true;
  } catch {
    // The durable journal is deliberately left in place. Recovery first checks
    // current metadata references, so a failed cancellation cannot delete a
    // newly referenced object.
    return false;
  }
}

/**
 * Uploads a new immutable object only after its cleanup intent is durable.
 * A transport failure can mean Storage committed without returning a response,
 * so the journal is retained until metadata references the exact path or a
 * confirmed remove response proves the unreferenced object was cleaned up.
 */
export async function commitGoalEvidenceRemoteUpload({
  remotePath,
  blob,
  allowLocalOnly,
  stageCleanup,
  upload,
  download,
  commitMetadata,
  remove,
  cancelCleanup,
}: {
  readonly remotePath: string;
  readonly blob: Blob;
  readonly allowLocalOnly: boolean;
  readonly stageCleanup: () => Promise<EvidenceCleanupIntent | null>;
  readonly upload: () => Promise<void>;
  readonly download: () => Promise<Blob>;
  readonly commitMetadata: (remotePath: string | undefined) => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly cancelCleanup: (intent: EvidenceCleanupIntent) => Promise<void>;
}): Promise<GoalEvidenceRemoteUploadResult> {
  const cleanupIntent = await stageCleanup();
  if (!cleanupIntent) {
    throw new Error("The private upload cleanup journal could not be created.");
  }

  let remoteConfirmed = false;
  let uploadError: unknown;
  try {
    await upload();
    remoteConfirmed = true;
  } catch (error) {
    uploadError = error;
    try {
      remoteConfirmed = await evidenceBlobsEqual(await download(), blob);
    } catch {
      // A failed exact read is ambiguous, never proof that the object is absent.
    }
  }

  if (!remoteConfirmed && !allowLocalOnly) {
    throw uploadError instanceof Error
      ? uploadError
      : new Error("The private cloud upload could not be verified.");
  }

  const metadataRemotePath = remoteConfirmed ? remotePath : undefined;
  try {
    await commitMetadata(metadataRemotePath);
  } catch (error) {
    if (error instanceof GoalEvidenceLocalCommitRetainedError) {
      const cleanupCancelled = metadataRemotePath
        ? await tryCancelEvidenceCleanup(cleanupIntent, cancelCleanup)
        : false;
      return {
        ...(metadataRemotePath ? { remotePath: metadataRemotePath } : {}),
        uploadNeedsRetry: !metadataRemotePath,
        cleanupPending: !cleanupCancelled,
        localCommitRetainedError: error,
      };
    }

    // Metadata did not retain the new reference. A successful remove response
    // is the only immediate outcome that permits cancelling the durable intent.
    try {
      await remove();
      await tryCancelEvidenceCleanup(cleanupIntent, cancelCleanup);
    } catch {
      // Ambiguous removal keeps the cleanup journal for crash-safe recovery.
    }
    throw error;
  }

  if (!metadataRemotePath) {
    return {
      uploadNeedsRetry: true,
      cleanupPending: true,
    };
  }
  const cleanupCancelled = await tryCancelEvidenceCleanup(
    cleanupIntent,
    cancelCleanup,
  );
  return {
    remotePath: metadataRemotePath,
    uploadNeedsRetry: false,
    cleanupPending: !cleanupCancelled,
  };
}

/**
 * Removes one evidence item behind a durable journal and, for cloud bytes, a
 * permanent server-side path claim. Metadata is committed first. A definitive
 * `referenced` response proves no claim was created and permits exact metadata
 * compensation; an ambiguous or successful claim makes the deletion
 * authoritative and leaves the journal to finish any uncertain byte cleanup.
 */
export async function removeSingleGoalEvidenceWithCompensation({
  stageCleanup,
  commitMetadataDeletion,
  claimRemote,
  removeRemote,
  removeLocal,
  restoreMetadata,
  cancelCleanup,
}: {
  readonly stageCleanup: () => Promise<EvidenceCleanupIntent | null>;
  readonly commitMetadataDeletion: () => Promise<number>;
  readonly claimRemote?: () => Promise<RemoteEvidenceCleanupClaim>;
  readonly removeRemote?: () => Promise<void>;
  readonly removeLocal?: (
    committedWorkspaceLocalRevision: number,
  ) => Promise<EvidenceBlobDeletionReceipt>;
  readonly restoreMetadata: () => Promise<void>;
  readonly cancelCleanup: (intent: EvidenceCleanupIntent) => Promise<void>;
}): Promise<{ cleanupPending: boolean }> {
  if (Boolean(removeRemote) !== Boolean(claimRemote)) {
    throw new Error(
      "Remote evidence removal requires an atomic server-side cleanup claim.",
    );
  }
  const cleanupIntent = await stageCleanup();
  if (!cleanupIntent && (claimRemote || removeLocal)) {
    throw new Error(
      "Evidence bytes cannot be removed without a durable cleanup journal.",
    );
  }
  const committedWorkspaceLocalRevision = await commitMetadataDeletion();

  if (claimRemote) {
    let claim: RemoteEvidenceCleanupClaim;
    try {
      claim = await claimRemote();
    } catch {
      // A lost RPC response can mean the permanent claim committed. Restoring
      // metadata could then create a reference that the server must reject.
      return { cleanupPending: true };
    }
    if (claim === "referenced") {
      const rollbackFailures: unknown[] = [];
      try {
        await restoreMetadata();
      } catch (error) {
        rollbackFailures.push(error);
      }
      if (!rollbackFailures.length) {
        const cancelled = await tryCancelEvidenceCleanup(
          cleanupIntent,
          cancelCleanup,
        );
        if (cancelled) {
          throw new Error(
            "A newer cloud workspace still references this evidence file. Reload before removing it.",
          );
        }
        rollbackFailures.push(new Error(
          "The compensated evidence cleanup journal could not be cancelled.",
        ));
      }
      throw new EvidenceCompensationError(
        new Error("The private evidence path is referenced by the current cloud workspace."),
        rollbackFailures,
      );
    }
  }

  let cleanupPending = false;
  if (removeRemote) {
    try {
      await removeRemote();
    } catch {
      cleanupPending = true;
    }
  }
  if (removeLocal) {
    try {
      await removeLocal(committedWorkspaceLocalRevision);
    } catch {
      cleanupPending = true;
    }
  }
  if (cleanupPending) return { cleanupPending: true };

  const cleanupCancelled = await tryCancelEvidenceCleanup(
    cleanupIntent,
    cancelCleanup,
  );
  return { cleanupPending: !cleanupCancelled };
}

function workspaceEvidenceKey(goalId: string, evidenceId: string): string {
  return JSON.stringify([goalId, evidenceId]);
}

/**
 * Plans exact cleanup provenance before an authoritative workspace replaces
 * the device copy. Only bytes or account-owned object paths that lose their
 * final metadata reference are selected. The returned write identities make
 * later crash recovery safe when another tab writes the same evidence key.
 */
export function planWorkspaceReplacementEvidenceCleanup({
  accountId,
  sourceStates,
  targetStates,
  localEvidence,
}: {
  readonly accountId: string;
  readonly sourceStates: readonly AppState[];
  readonly targetStates: readonly AppState[];
  readonly localEvidence: readonly EvidenceBlobRecord[];
}): EvidenceCleanupIntentInput[] {
  const targetKeys = new Set<string>();
  const targetRemotePaths = new Set<string>();
  for (const state of targetStates) {
    for (const goal of state.goals) {
      for (const item of goal.evidence) {
        if (item.type !== "file") continue;
        targetKeys.add(workspaceEvidenceKey(goal.id, item.id));
        const path = remoteEvidencePath(item, accountId, goal.id);
        if (path) targetRemotePaths.add(path);
      }
    }
  }

  const localByKey = new Map<string, EvidenceBlobRecord>();
  for (const record of localEvidence) {
    if (record.accountId !== accountId) continue;
    localByKey.set(
      workspaceEvidenceKey(record.goalId, record.evidenceId),
      record,
    );
  }

  const discarded = new Map<string, {
    goalId: string;
    evidenceId: string;
    removeLocal: boolean;
    remotePaths: Set<string>;
  }>();
  for (const state of sourceStates) {
    for (const goal of state.goals) {
      for (const item of goal.evidence) {
        if (item.type !== "file") continue;
        const key = workspaceEvidenceKey(goal.id, item.id);
        const removeLocal = !targetKeys.has(key);
        const path = remoteEvidencePath(item, accountId, goal.id);
        const removeRemote = Boolean(path && !targetRemotePaths.has(path));
        if (!removeLocal && !removeRemote) continue;
        const existing = discarded.get(key) ?? {
          goalId: goal.id,
          evidenceId: item.id,
          removeLocal: false,
          remotePaths: new Set<string>(),
        };
        existing.removeLocal ||= removeLocal;
        if (removeRemote && path) existing.remotePaths.add(path);
        discarded.set(key, existing);
      }
    }
  }

  const inputs: EvidenceCleanupIntentInput[] = [];
  for (const [key, item] of discarded) {
    const local = item.removeLocal ? localByKey.get(key) : undefined;
    if (local && !local.writeId) {
      throw new Error(
        "A discarded device evidence record has no exact live write identity.",
      );
    }
    const paths = [...item.remotePaths].sort();
    if (!paths.length) {
      if (local?.writeId) {
        inputs.push({
          accountId,
          goalId: item.goalId,
          evidenceId: item.evidenceId,
          expectedWriteId: local.writeId,
        });
      }
      continue;
    }
    paths.forEach((remotePath, index) => {
      inputs.push({
        accountId,
        goalId: item.goalId,
        evidenceId: item.evidenceId,
        ...(index === 0 && local?.writeId
          ? { expectedWriteId: local.writeId }
          : {}),
        remotePath,
      });
    });
  }
  return inputs;
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

async function cancelCleanupIntents(
  intents: readonly EvidenceCleanupIntent[],
  generation: PersistenceScopeGeneration,
  localEvidence: LocalGoalEvidenceRepository,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const intent of intents) {
    try {
      await localEvidence.cancelCleanup(intent, generation);
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
      stagedEvidence,
    }: SetGoalFileEvidenceRequest): Promise<number> {
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
        return await metadata.flushDurably(scope, stagedEvidence);
      } catch (error) {
        if (error instanceof GoalEvidenceLocalCommitRetainedError) throw error;
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
        if (safeRemotePaths.length) remoteEvidence.assertWriteAllowed();

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
        let deletedWorkspace: GoalMetadataSnapshot | null = null;
        const cleanupIntents: EvidenceCleanupIntent[] = [];
        try {
          const cleanupByEvidence = new Map<string, EvidenceCleanupIntentInput>();
          for (const snapshot of localSnapshots) {
            if (!snapshot.writeId) {
              throw new Error("A device evidence record has no exact live write identity.");
            }
            cleanupByEvidence.set(snapshot.evidenceId, {
              accountId: scope.persistenceAccountId,
              goalId,
              evidenceId: snapshot.evidenceId,
              expectedWriteId: snapshot.writeId,
            });
          }
          for (let index = 0; index < remoteFiles.length; index += 1) {
            const file = remoteFiles[index];
            const existing = cleanupByEvidence.get(file.id);
            cleanupByEvidence.set(file.id, {
              accountId: scope.persistenceAccountId,
              goalId,
              evidenceId: file.id,
              ...(existing?.expectedWriteId
                ? { expectedWriteId: existing.expectedWriteId }
                : {}),
              remotePath: safeRemotePaths[index],
            });
          }
          for (const input of cleanupByEvidence.values()) {
            cleanupIntents.push(await localEvidence.stageCleanup(
              input,
              scope.persistenceGeneration,
            ));
          }
          metadataStarted = true;
          metadata.deleteGoalRecords(goalId);
          deletedWorkspace = metadata.captureWorkspace();
          const committedWorkspaceLocalRevision = await metadata.flushDurably(scope);
          assertCurrentScope(
            scopeCoordinator,
            scope,
            "The active workspace changed after evidence metadata was saved.",
          );

          if (safeRemotePaths.length) {
            let claim: RemoteEvidenceCleanupClaim;
            try {
              claim = await remoteEvidence.claim(safeRemotePaths);
            } catch {
              // The claim response is ambiguous and may have permanently
              // fenced every path. Keep deletion metadata and journals; crash
              // recovery can safely retry the same idempotent batch.
              return;
            }
            if (claim === "referenced") {
              throw new Error(
                "A newer cloud workspace still references this goal's evidence. Reload before deleting it.",
              );
            }
          }

          let cleanupPending = false;
          if (safeRemotePaths.length) {
            try {
              await remoteEvidence.remove(safeRemotePaths);
            } catch {
              cleanupPending = true;
            }
          }
          if (localSnapshots.length) {
            try {
              requireEvidenceDeletionReceipt(await localEvidence.remove(
                localSnapshots,
                scope.persistenceGeneration,
                committedWorkspaceLocalRevision,
              ));
            } catch {
              cleanupPending = true;
            }
          }
          if (cleanupPending) return;
          await cancelCleanupIntents(
            cleanupIntents,
            scope.persistenceGeneration,
            localEvidence,
          );
        } catch (error) {
          const rollbackFailures: unknown[] = [];
          if (metadataStarted) {
            try {
              assertCurrentScope(
                scopeCoordinator,
                scope,
                "The active workspace changed before goal metadata could be restored.",
              );
              if (!metadata.restoreWorkspace(
                previousWorkspace,
                deletedWorkspace ?? undefined,
              )) {
                throw new Error(
                  "The workspace changed after deletion; unrelated edits were preserved instead of restoring a stale whole-workspace snapshot.",
                );
              }
              await metadata.flushDurably(scope);
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
          }
          if (rollbackFailures.length === 0) {
            rollbackFailures.push(...await cancelCleanupIntents(
              cleanupIntents,
              scope.persistenceGeneration,
              localEvidence,
            ));
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
