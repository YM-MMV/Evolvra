import type { EvidenceBlobRecord } from "@/lib/persistence";

export interface RemoteEvidenceSnapshot {
  path: string;
  blob: Blob;
}

export interface EvidenceBlobJournalEntry {
  accountId: string;
  goalId: string;
  evidenceId: string;
  previous?: EvidenceBlobRecord;
}

export class EvidenceCompensationError extends Error {
  readonly originalError: unknown;
  readonly rollbackFailures: unknown[];

  constructor(originalError: unknown, rollbackFailures: unknown[]) {
    super("The evidence operation failed and one or more exact file snapshots could not be restored.");
    this.name = "EvidenceCompensationError";
    this.originalError = originalError;
    this.rollbackFailures = rollbackFailures;
  }
}

async function restoreAllEvidence(
  local: readonly EvidenceBlobRecord[],
  remote: readonly RemoteEvidenceSnapshot[],
  restoreLocal: (snapshot: EvidenceBlobRecord) => Promise<void>,
  restoreRemote: (snapshot: RemoteEvidenceSnapshot) => Promise<void>,
) {
  const failures: unknown[] = [];
  for (const snapshot of remote) {
    try {
      await restoreRemote(snapshot);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const snapshot of local) {
    try {
      await restoreLocal(snapshot);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Deletes captured evidence bytes only while the workspace scope is current.
 * Any byte or metadata failure restores every exact pre-operation snapshot
 * before the original failure is allowed to escape.
 */
export async function deleteEvidenceWithCompensation({
  local,
  remote,
  isScopeCurrent,
  removeLocal,
  removeRemote,
  restoreLocal,
  restoreRemote,
  commitMetadata,
  rollbackMetadata,
}: {
  local: readonly EvidenceBlobRecord[];
  remote: readonly RemoteEvidenceSnapshot[];
  isScopeCurrent: () => boolean;
  removeLocal: (snapshot: EvidenceBlobRecord) => Promise<void>;
  removeRemote: (paths: string[]) => Promise<void>;
  restoreLocal: (snapshot: EvidenceBlobRecord) => Promise<void>;
  restoreRemote: (snapshot: RemoteEvidenceSnapshot) => Promise<void>;
  commitMetadata: () => Promise<void>;
  rollbackMetadata: () => Promise<void>;
}) {
  if (!isScopeCurrent()) throw new Error("The active workspace changed before evidence deletion could start.");
  let deletionStarted = false;
  let metadataStarted = false;
  try {
    metadataStarted = true;
    await commitMetadata();
    if (!isScopeCurrent()) {
      throw new Error("The active workspace changed after evidence metadata was saved.");
    }
    deletionStarted = true;
    if (remote.length) await removeRemote(remote.map((snapshot) => snapshot.path));
    for (const snapshot of local) await removeLocal(snapshot);
    if (!isScopeCurrent()) {
      throw new Error("The active workspace changed while evidence deletion was finishing.");
    }
  } catch (error) {
    const rollbackFailures = deletionStarted
      ? await restoreAllEvidence(local, remote, restoreLocal, restoreRemote)
      : [];
    if (metadataStarted) {
      try {
        await rollbackMetadata();
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length) throw new EvidenceCompensationError(error, rollbackFailures);
    throw error;
  }
}

/** Appends copy operations to a caller-owned journal without losing originals. */
export async function appendEvidenceBlobCopies(
  source: readonly EvidenceBlobRecord[],
  targetAccountId: string,
  journal: EvidenceBlobJournalEntry[],
  {
    readTarget,
    writeTarget,
  }: {
    readTarget: (accountId: string, goalId: string, evidenceId: string) => Promise<EvidenceBlobRecord | null>;
    writeTarget: (record: EvidenceBlobRecord) => Promise<void>;
  },
) {
  for (const item of source) {
    const previous = await readTarget(targetAccountId, item.goalId, item.evidenceId);
    await writeTarget({ ...item, accountId: targetAccountId });
    journal.push({
      accountId: targetAccountId,
      goalId: item.goalId,
      evidenceId: item.evidenceId,
      ...(previous ? { previous } : {}),
    });
  }
}

/** Reverses a copy journal in strict LIFO order and awaits every attempt. */
export async function rollbackEvidenceBlobJournal(
  journal: readonly EvidenceBlobJournalEntry[],
  {
    restore,
    remove,
  }: {
    restore: (record: EvidenceBlobRecord) => Promise<void>;
    remove: (accountId: string, goalId: string, evidenceId: string) => Promise<void>;
  },
) {
  const failures: unknown[] = [];
  for (const item of [...journal].reverse()) {
    try {
      if (item.previous) await restore(item.previous);
      else await remove(item.accountId, item.goalId, item.evidenceId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "One or more copied evidence blobs could not be rolled back.");
  }
}
