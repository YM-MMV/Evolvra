import { normalizedEvidenceBlob } from "@/lib/goal-evidence";
import {
  LocalWorkspaceConflictError,
  PersistenceError,
  readAccountPersistenceScope,
  type AccountPersistenceScope,
  type EvidenceBlobRecord,
  type PersistenceScopeGeneration,
} from "@/lib/persistence";
import { remoteEvidencePath } from "@/lib/provider-evidence";
export { workspaceNoticeForActiveAccount } from "@/lib/provider-selectors";
import type { WorkspaceFileEvidenceCopy } from "@/lib/workspace-merge";

export async function prepareAnonymousHandoffEvidenceCopies({
  copies,
  sourceAccountId,
  targetAccountId,
  readSource,
  downloadRemote,
  isCurrent,
  savedAt,
}: {
  copies: readonly WorkspaceFileEvidenceCopy[];
  sourceAccountId: string;
  targetAccountId: string;
  readSource: (
    accountId: string,
    goalId: string,
    evidenceId: string,
  ) => Promise<EvidenceBlobRecord | null>;
  downloadRemote: (path: string) => Promise<Blob>;
  isCurrent: () => boolean;
  savedAt: string;
}): Promise<EvidenceBlobRecord[]> {
  const prepared: EvidenceBlobRecord[] = [];
  for (const copy of copies) {
    if (!isCurrent()) {
      throw new Error("The signed-in account changed before evidence files could be prepared.");
    }
    let local: EvidenceBlobRecord | null;
    try {
      local = await readSource(
        sourceAccountId,
        copy.sourceGoalId,
        copy.sourceEvidenceId,
      );
    } catch (error) {
      if (!(error instanceof PersistenceError) || error.code !== "invalid-data") {
        throw error;
      }
      local = null;
    }
    if (!isCurrent()) {
      throw new Error("The signed-in account changed while evidence files were being prepared.");
    }
    let blob = local ? normalizedEvidenceBlob(local.blob, copy.source) : null;
    if (!blob) {
      const safeRemotePath = remoteEvidencePath(
        copy.source,
        targetAccountId,
        copy.sourceGoalId,
      );
      if (!safeRemotePath) {
        throw new Error(`The file "${copy.source.name}" has no verified device copy or safe path for this account. Reattach it before combining workspaces.`);
      }
      const downloaded = await downloadRemote(safeRemotePath);
      if (!isCurrent()) {
        throw new Error("The signed-in account changed while evidence files were being downloaded.");
      }
      blob = normalizedEvidenceBlob(downloaded, copy.source);
      if (!blob) {
        throw new Error(`The cloud copy of "${copy.source.name}" does not match its recorded type and size. Neither workspace was changed.`);
      }
    }
    prepared.push({
      accountId: targetAccountId,
      goalId: copy.mergedGoalId,
      evidenceId: copy.mergedEvidenceId,
      blob,
      savedAt,
    });
  }
  return prepared;
}

export async function settleOutgoingWorkspaceWrite(
  outgoingAccountId: string,
  write: () => Promise<unknown>,
): Promise<"saved" | "conflicted"> {
  try {
    await write();
    return "saved";
  } catch (error) {
    if (
      error instanceof LocalWorkspaceConflictError
      && error.accountId === outgoingAccountId
    ) return "conflicted";
    throw error;
  }
}

interface AdoptExistingAccountErasureFenceOptions {
  expectedAccountId: string;
  tombstonedGeneration: PersistenceScopeGeneration;
  closeWriterBarrier: () => void;
  drainWriters: () => Promise<void>;
  readScope?: (accountId: string) => Promise<AccountPersistenceScope>;
}

/**
 * Adopts a tombstone created by another tab without ever reopening writers on
 * an uncertain read. The barrier is deliberately installed before the first
 * await; only the exact durable account and generation are accepted afterward.
 */
export async function adoptExistingAccountErasureFence({
  expectedAccountId,
  tombstonedGeneration,
  closeWriterBarrier,
  drainWriters,
  readScope = readAccountPersistenceScope,
}: AdoptExistingAccountErasureFenceOptions): Promise<AccountPersistenceScope> {
  closeWriterBarrier();
  await drainWriters();
  const scope = await readScope(expectedAccountId);
  if (
    scope.accountId !== expectedAccountId
    || !scope.tombstoned
    || scope.generation !== tombstonedGeneration
  ) {
    throw new Error("The durable account-erasure fence does not match the exact recovery checkpoint.");
  }
  return scope;
}
