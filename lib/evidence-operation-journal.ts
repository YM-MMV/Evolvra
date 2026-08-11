/**
 * Reports a failed metadata compensation without offering a byte-restoration
 * primitive. Once a cloud path may be claimed, recreating its bytes or
 * reference would violate the permanent cleanup tombstone.
 */
export class EvidenceCompensationError extends Error {
  readonly originalError: unknown;
  readonly rollbackFailures: unknown[];

  constructor(originalError: unknown, rollbackFailures: unknown[]) {
    super("The evidence operation failed and its metadata could not be safely compensated.");
    this.name = "EvidenceCompensationError";
    this.originalError = originalError;
    this.rollbackFailures = rollbackFailures;
  }
}
