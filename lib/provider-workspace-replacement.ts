import { planWorkspaceReplacementEvidenceCleanup } from "@/lib/provider-goal-evidence";
import type {
  EvidenceBlobRecord,
  EvidenceCleanupIntent,
  EvidenceCleanupIntentInput,
} from "@/lib/persistence";
import type { AppState } from "@/lib/types";

export interface AuthoritativeWorkspaceReplacementInput {
  readonly accountId: string;
  readonly sourceStates: readonly AppState[];
  readonly targetStates: readonly AppState[];
}

export interface AuthoritativeWorkspaceReplacementPorts<TResult> {
  listLocalEvidence(accountId: string): Promise<readonly EvidenceBlobRecord[]>;
  stageCleanup(input: EvidenceCleanupIntentInput): Promise<EvidenceCleanupIntent>;
  cancelCleanup(intent: EvidenceCleanupIntent): Promise<unknown>;
  persistTarget(): Promise<TResult>;
}

export interface AuthoritativeWorkspaceReplacementResult<TResult> {
  readonly result: TResult;
  /**
   * These intents deliberately remain durable after the local target commits.
   * The caller may drain them only after that same target is authoritative in
   * cloud metadata. Crash recovery can therefore distinguish a referenced file
   * from superseded local bytes and private object paths without guessing.
   */
  readonly cleanupIntents: readonly EvidenceCleanupIntent[];
}

async function cancelStagedCleanupOrThrow(
  originalError: unknown,
  intents: readonly EvidenceCleanupIntent[],
  cancelCleanup: (intent: EvidenceCleanupIntent) => Promise<unknown>,
  message: string,
): Promise<never> {
  const results = await Promise.allSettled(
    [...intents].reverse().map((intent) => cancelCleanup(intent)),
  );
  const cancellationFailures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []);
  if (cancellationFailures.length) {
    throw new AggregateError(
      [originalError, ...cancellationFailures],
      message,
    );
  }
  throw originalError;
}

/**
 * Stages exact cleanup provenance before replacing one authoritative workspace
 * with another. A failed stage or local commit cancels only the intents created
 * by this attempt. A successful local commit intentionally retains them until
 * the caller proves the target metadata is authoritative in cloud storage.
 */
export async function runAuthoritativeWorkspaceReplacement<TResult>(
  input: AuthoritativeWorkspaceReplacementInput,
  ports: AuthoritativeWorkspaceReplacementPorts<TResult>,
): Promise<AuthoritativeWorkspaceReplacementResult<TResult>> {
  const localEvidence = await ports.listLocalEvidence(input.accountId);
  const cleanupInputs = planWorkspaceReplacementEvidenceCleanup({
    accountId: input.accountId,
    sourceStates: input.sourceStates,
    targetStates: input.targetStates,
    localEvidence,
  });
  const cleanupIntents: EvidenceCleanupIntent[] = [];

  try {
    for (const cleanupInput of cleanupInputs) {
      cleanupIntents.push(await ports.stageCleanup(cleanupInput));
    }
  } catch (error) {
    return cancelStagedCleanupOrThrow(
      error,
      cleanupIntents,
      ports.cancelCleanup,
      "Workspace replacement cleanup could not be staged or safely cancelled.",
    );
  }

  let result: TResult;
  try {
    result = await ports.persistTarget();
  } catch (error) {
    return cancelStagedCleanupOrThrow(
      error,
      cleanupIntents,
      ports.cancelCleanup,
      "Workspace replacement failed and its cleanup journal could not be fully cancelled.",
    );
  }

  return { result, cleanupIntents };
}
