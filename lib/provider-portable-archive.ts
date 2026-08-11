import { normalizedEvidenceBlob } from "@/lib/goal-evidence";
import {
  createPortableWorkspaceArchive,
  type PortableWorkspaceArchiveArtifact,
  type PortableWorkspaceArchiveCreationReport,
} from "@/lib/portable-workspace-archive";
import { remoteEvidencePath } from "@/lib/provider-evidence";
import type {
  EvidenceBlobRecord,
  PersistenceScopeGeneration,
} from "@/lib/persistence";
import type {
  AppState,
  GoalFileEvidence,
} from "@/lib/types";

export interface PortableArchiveOperationBoundary {
  accountId: string;
  authenticatedAccountId: string | null;
  persistenceGeneration: PersistenceScopeGeneration;
}

export class PortableArchiveScopeChangedError extends Error {
  constructor(message = "The active workspace changed before the portable archive operation finished.") {
    super(message);
    this.name = "PortableArchiveScopeChangedError";
  }
}

export class IncompletePortableArchiveError extends Error {
  readonly report: PortableWorkspaceArchiveCreationReport;

  constructor(report: PortableWorkspaceArchiveCreationReport) {
    super(
      report.missingEvidence.length === 1
        ? "A referenced evidence file is unavailable on this device and in its verified private cloud location. No full backup was downloaded."
        : `${report.missingEvidence.length} referenced evidence files are unavailable on this device and in their verified private cloud locations. No full backup was downloaded.`,
    );
    this.name = "IncompletePortableArchiveError";
    this.report = report;
  }
}

export interface CreateCompletePortableArchiveInput {
  state: AppState;
  boundary: PortableArchiveOperationBoundary;
  createdAt: string;
  isCurrent: () => boolean;
  listLocalEvidence: (
    accountId: string,
    generation: PersistenceScopeGeneration,
  ) => Promise<readonly EvidenceBlobRecord[]>;
  requireExactAuthenticatedAccount: (accountId: string) => Promise<void>;
  downloadRemoteEvidence: (path: string) => Promise<Blob>;
}

function requireCurrent(
  isCurrent: () => boolean,
  message?: string,
): void {
  if (!isCurrent()) throw new PortableArchiveScopeChangedError(message);
}

function referencedFileEvidence(
  state: AppState,
): Array<{ goalId: string; evidence: GoalFileEvidence }> {
  return state.goals.flatMap((goal) =>
    goal.evidence
      .filter((item): item is GoalFileEvidence => item.type === "file")
      .map((evidence) => ({ goalId: goal.id, evidence })));
}

function evidenceKey(goalId: string, evidenceId: string): string {
  return `${goalId}\u0000${evidenceId}`;
}

/**
 * Captures a complete, account-neutral archive. Device bytes are authoritative
 * when present. A cloud download is attempted only for a referenced file that
 * has no device bytes and only for the exact verified signed-in account.
 */
export async function createCompletePortableArchive({
  state,
  boundary,
  createdAt,
  isCurrent,
  listLocalEvidence,
  requireExactAuthenticatedAccount,
  downloadRemoteEvidence,
}: CreateCompletePortableArchiveInput): Promise<PortableWorkspaceArchiveArtifact> {
  requireCurrent(isCurrent);
  const localEvidence = [...await listLocalEvidence(
    boundary.accountId,
    boundary.persistenceGeneration,
  )];
  requireCurrent(
    isCurrent,
    "The active workspace changed while its device evidence was being enumerated.",
  );

  const localKeys = new Set(
    localEvidence.map((item) => evidenceKey(item.goalId, item.evidenceId)),
  );
  const collected = [...localEvidence];
  for (const { goalId, evidence } of referencedFileEvidence(state)) {
    requireCurrent(isCurrent);
    if (localKeys.has(evidenceKey(goalId, evidence.id))) continue;

    const authenticatedAccountId = boundary.authenticatedAccountId;
    const safeRemotePath = authenticatedAccountId === boundary.accountId
      ? remoteEvidencePath(evidence, authenticatedAccountId, goalId)
      : undefined;
    if (!safeRemotePath || !authenticatedAccountId) continue;

    await requireExactAuthenticatedAccount(authenticatedAccountId);
    requireCurrent(
      isCurrent,
      "The signed-in account changed before private evidence could be downloaded.",
    );
    const downloaded = await downloadRemoteEvidence(safeRemotePath);
    await requireExactAuthenticatedAccount(authenticatedAccountId);
    requireCurrent(
      isCurrent,
      "The signed-in account changed while private evidence was being downloaded.",
    );
    const blob = normalizedEvidenceBlob(downloaded, evidence);
    if (!blob) {
      throw new Error(
        `The private cloud copy of "${evidence.name}" does not match its recorded type and size. No full backup was downloaded.`,
      );
    }
    collected.push({
      accountId: boundary.accountId,
      goalId,
      evidenceId: evidence.id,
      blob,
      savedAt: createdAt,
    });
    localKeys.add(evidenceKey(goalId, evidence.id));
  }

  requireCurrent(isCurrent);
  const artifact = await createPortableWorkspaceArchive({
    state,
    sourceAccountId: boundary.accountId,
    evidence: collected,
    createdAt,
  });
  requireCurrent(
    isCurrent,
    "The active workspace changed while the portable archive was being checksummed.",
  );
  if (!artifact.report.complete) {
    throw new IncompletePortableArchiveError(artifact.report);
  }
  return artifact;
}
