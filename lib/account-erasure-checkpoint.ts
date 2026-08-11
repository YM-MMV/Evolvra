import {
  workspaceKey,
  type PersistenceScopeGeneration,
} from "@/lib/persistence";
import { ANONYMOUS_ACCOUNT_ID } from "@/lib/sync-reconciliation";

export const ACCOUNT_ERASURE_CHECKPOINT_VERSION = 2;
export const ACCOUNT_ERASURE_OWNER_LEASE_MS = 30_000;
export const ACCOUNT_ERASURE_FUTURE_TOLERANCE_MS = 5 * 60_000;

export type CloudErasureStatus =
  | "pending"
  | "finalizing"
  | "failed"
  | "ambiguous"
  | "complete";
export type LocalErasureStatus = "pending" | "complete";
export type SessionErasureStatus = "pending" | "complete";

export interface AccountErasureOwnerLease {
  id: string;
  leaseExpiresAt: string;
}

/** Monotonic cloud coordinates captured before and after the full backup. */
export interface AccountErasureCloudBackupBoundary {
  workspaceRevision: number;
  evidenceRevision: number;
}

export interface AccountErasureCheckpoint {
  version: 2;
  accountId: string;
  attemptId: string;
  cloud: CloudErasureStatus;
  local: LocalErasureStatus;
  session: SessionErasureStatus;
  persistenceGeneration: PersistenceScopeGeneration;
  backup: AccountErasureCloudBackupBoundary | null;
  owner: AccountErasureOwnerLease | null;
  updatedAt: string;
}

export interface LegacyAccountErasureCheckpoint {
  accountId: string;
  cloud: "pending" | "finalizing" | "ambiguous" | "complete";
  local: LocalErasureStatus;
  updatedAt: string;
}

export interface LegacyAccountErasureEnvelope {
  version: 1;
  checkpoints: LegacyAccountErasureCheckpoint[];
}

export function validateAccountErasureAccountId(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) {
    throw new Error("The pending account-erasure record contains an invalid account identifier.");
  }
  return workspaceKey(value);
}

export function validateAccountErasureIdentifier(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value !== value.trim()
  ) {
    throw new Error(`The pending account-erasure record contains an invalid ${label}.`);
  }
  return value;
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parsedBackupBoundary(
  value: unknown,
): AccountErasureCloudBackupBoundary | null {
  // Checkpoints created before the cloud backup fence remain readable. They
  // may resume only if the server is already in its deleting lifecycle; a new
  // active-account fence always requires a fresh boundary-aware backup.
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The pending account-erasure checkpoint has an invalid backup boundary.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !validGeneration(candidate.workspaceRevision)
    || !validGeneration(candidate.evidenceRevision)
  ) {
    throw new Error("The pending account-erasure checkpoint has an invalid backup boundary.");
  }
  return {
    workspaceRevision: Number(candidate.workspaceRevision),
    evidenceRevision: Number(candidate.evidenceRevision),
  };
}

function parsedTimestamp(
  value: unknown,
  label: string,
  now: number,
): { value: string; time: number } {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`The pending account-erasure record has an invalid ${label}.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + ACCOUNT_ERASURE_FUTURE_TOLERANCE_MS) {
    throw new Error(`The pending account-erasure record has an invalid or future ${label}.`);
  }
  return { value, time };
}

export function parseAccountErasureCheckpoint(
  value: unknown,
  expectedAccountId?: string,
  now = Date.now(),
): AccountErasureCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A pending account-erasure checkpoint is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== ACCOUNT_ERASURE_CHECKPOINT_VERSION) {
    throw new Error("The pending account-erasure checkpoint uses an unsupported format.");
  }
  const accountId = validateAccountErasureAccountId(candidate.accountId);
  if (
    expectedAccountId !== undefined
    && accountId !== validateAccountErasureAccountId(expectedAccountId)
  ) {
    throw new Error("The pending account-erasure checkpoint belongs to another account scope.");
  }
  const attemptId = validateAccountErasureIdentifier(
    candidate.attemptId,
    "attempt identifier",
  );
  if (
    !["pending", "finalizing", "failed", "ambiguous", "complete"].includes(
      String(candidate.cloud),
    )
    || !["pending", "complete"].includes(String(candidate.local))
    || !["pending", "complete"].includes(String(candidate.session))
    || !validGeneration(candidate.persistenceGeneration)
  ) {
    throw new Error("A pending account-erasure checkpoint has an invalid state.");
  }
  const updated = parsedTimestamp(candidate.updatedAt, "updated timestamp", now);
  let owner: AccountErasureOwnerLease | null = null;
  if (candidate.owner !== null) {
    if (
      !candidate.owner
      || typeof candidate.owner !== "object"
      || Array.isArray(candidate.owner)
    ) {
      throw new Error("The pending account-erasure checkpoint has an invalid owner lease.");
    }
    const rawOwner = candidate.owner as Record<string, unknown>;
    const id = validateAccountErasureIdentifier(rawOwner.id, "owner identifier");
    const lease = parsedTimestamp(rawOwner.leaseExpiresAt, "owner lease", now);
    if (
      candidate.cloud !== "finalizing"
      || lease.time < updated.time
      || lease.time > updated.time + ACCOUNT_ERASURE_OWNER_LEASE_MS * 2
    ) {
      throw new Error("The pending account-erasure checkpoint has an invalid owner lease.");
    }
    owner = { id, leaseExpiresAt: lease.value };
  } else if (candidate.cloud === "finalizing") {
    throw new Error("A finalizing account-erasure checkpoint has no owner lease.");
  }

  return {
    version: 2,
    accountId,
    attemptId,
    cloud: candidate.cloud as CloudErasureStatus,
    local: candidate.local as LocalErasureStatus,
    session: candidate.session as SessionErasureStatus,
    persistenceGeneration: Number(candidate.persistenceGeneration),
    backup: parsedBackupBoundary(candidate.backup),
    owner,
    updatedAt: updated.value,
  };
}

/** Strictly validates the retired localStorage checkpoint format. */
export function parseLegacyAccountErasureCheckpoints(
  value: unknown,
  now = Date.now(),
): LegacyAccountErasureEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The legacy account-erasure checkpoint root is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.checkpoints)) {
    throw new Error("The legacy account-erasure checkpoint uses an unsupported format.");
  }
  const seen = new Set<string>();
  const checkpoints = candidate.checkpoints.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("A legacy account-erasure checkpoint is invalid.");
    }
    const item = raw as Record<string, unknown>;
    const accountId = validateAccountErasureAccountId(item.accountId);
    if (accountId === ANONYMOUS_ACCOUNT_ID) {
      throw new Error("The anonymous workspace cannot be an account-erasure target.");
    }
    if (seen.has(accountId)) {
      throw new Error("The legacy account-erasure checkpoint repeats an account identifier.");
    }
    seen.add(accountId);
    if (
      !["pending", "finalizing", "ambiguous", "complete"].includes(String(item.cloud))
      || !["pending", "complete"].includes(String(item.local))
    ) {
      throw new Error("A legacy account-erasure checkpoint has an invalid state.");
    }
    const updatedAt = parsedTimestamp(
      item.updatedAt,
      "legacy updated timestamp",
      now,
    ).value;
    return {
      accountId,
      cloud: item.cloud as LegacyAccountErasureCheckpoint["cloud"],
      local: item.local as LocalErasureStatus,
      updatedAt,
    };
  });
  return { version: 1, checkpoints };
}

export function updateAccountErasureCheckpoint(
  current: AccountErasureCheckpoint,
  patch: Partial<Pick<
    AccountErasureCheckpoint,
    "cloud" | "local" | "session" | "owner"
  >>,
  now: number,
): AccountErasureCheckpoint {
  return {
    ...current,
    ...patch,
    updatedAt: new Date(now).toISOString(),
  };
}

export function finalizingErasureLeaseExpired(
  checkpoint: AccountErasureCheckpoint,
  now = Date.now(),
): boolean {
  return checkpoint.cloud === "finalizing"
    && checkpoint.owner !== null
    && Date.parse(checkpoint.owner.leaseExpiresAt) <= now;
}

export function actionableLocalErasureCheckpoint(
  checkpoints: AccountErasureCheckpoint[],
): AccountErasureCheckpoint | null {
  return checkpoints.find((checkpoint) =>
    checkpoint.local === "pending"
    && (checkpoint.cloud === "ambiguous" || checkpoint.cloud === "complete")) ?? null;
}

export function accountErasureCheckpointNeedsRecovery(
  checkpoint: AccountErasureCheckpoint,
): boolean {
  return checkpoint.cloud === "pending"
    || checkpoint.cloud === "finalizing"
    || checkpoint.cloud === "failed"
    || checkpoint.local === "pending"
    || checkpoint.session === "pending";
}
