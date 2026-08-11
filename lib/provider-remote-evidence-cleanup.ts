export type RemoteEvidenceCleanupClaim = "claimed" | "referenced";

export type ClaimedRemoteEvidenceCleanupResult =
  | "cancelled-referenced"
  | "completed"
  | "retained-claim-failed"
  | "retained-cancellation-failed"
  | "retained-removal-failed"
  | "retained-completion-failed";

export interface ClaimedRemoteEvidenceCleanupPorts {
  /**
   * Atomically claims the path for deletion, or reports that authoritative
   * metadata still references it. A successful claim fences new references.
   */
  readonly claimCleanup: () => Promise<RemoteEvidenceCleanupClaim>;
  readonly cancelCleanup: () => Promise<unknown>;
  readonly removeRemote: () => Promise<unknown>;
  readonly completeCleanup: () => Promise<unknown>;
}

/**
 * Drains one durable local cleanup intent through its server-side deletion
 * claim. Every ambiguous outcome retains the intent so recovery can retry.
 */
export async function runClaimedRemoteEvidenceCleanup(
  ports: ClaimedRemoteEvidenceCleanupPorts,
): Promise<ClaimedRemoteEvidenceCleanupResult> {
  let claim: RemoteEvidenceCleanupClaim;
  try {
    claim = await ports.claimCleanup();
  } catch {
    return "retained-claim-failed";
  }

  if (claim === "referenced") {
    try {
      await ports.cancelCleanup();
      return "cancelled-referenced";
    } catch {
      return "retained-cancellation-failed";
    }
  }

  try {
    await ports.removeRemote();
  } catch {
    return "retained-removal-failed";
  }

  try {
    await ports.completeCleanup();
    return "completed";
  } catch {
    return "retained-completion-failed";
  }
}
