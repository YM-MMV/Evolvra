import {
  beginAccountErasurePersistenceFence,
  disableLegacyWorkspaceImport,
  deleteRawAccountErasureCheckpoint,
  eraseAccountPersistenceWithTombstone,
  readAccountPersistenceScope,
  recoverOrphanedAccountErasurePersistenceFence,
  listRawAccountErasureCheckpoints,
  mutateRawAccountErasureCheckpoint,
  readRawAccountErasureCheckpoint,
  workspaceKey,
  LEGACY_WORKSPACE_STORAGE_KEY,
  type AccountPersistenceScope,
  type LegacyWorkspaceImportJournal,
  type PersistenceScopeGeneration,
} from "@/lib/persistence";
import { LEGACY_LAST_REMINDER_KEY, reminderStorageKey } from "@/lib/reminders";
import { ANONYMOUS_ACCOUNT_ID } from "@/lib/sync-reconciliation";
import { CloudAccountErasureError } from "@/lib/supabase";

/** Retained only to detect and explicitly migrate or discard v1 browser data. */
export const LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY =
  "evolvra:account-erasure-checkpoints:v1";
export const ACCOUNT_ERASURE_CHECKPOINT_VERSION = 2;
export const ACCOUNT_ERASURE_OWNER_LEASE_MS = 30_000;
export const ACCOUNT_ERASURE_FUTURE_TOLERANCE_MS = 5 * 60_000;
export const ACCOUNT_ERASURE_CHANGE_EVENT = "evolvra:account-erasure-change";
const ACCOUNT_ERASURE_BROADCAST_CHANNEL = "evolvra-account-erasure-v2";

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

export interface AccountErasureCheckpoint {
  version: 2;
  accountId: string;
  attemptId: string;
  cloud: CloudErasureStatus;
  local: LocalErasureStatus;
  session: SessionErasureStatus;
  persistenceGeneration: PersistenceScopeGeneration;
  owner: AccountErasureOwnerLease | null;
  updatedAt: string;
}

export interface CorruptAccountErasureCheckpoint {
  key: IDBValidKey;
  reason: string;
}

export interface AccountErasureCheckpointInventory {
  checkpoints: AccountErasureCheckpoint[];
  corrupt: CorruptAccountErasureCheckpoint[];
}

export interface BegunAccountErasureIntent {
  checkpoint: AccountErasureCheckpoint;
  scope: AccountPersistenceScope;
}

interface LegacyAccountErasureCheckpoint {
  accountId: string;
  cloud: "pending" | "finalizing" | "ambiguous" | "complete";
  local: LocalErasureStatus;
  updatedAt: string;
}

interface LegacyAccountErasureEnvelope {
  version: 1;
  checkpoints: LegacyAccountErasureCheckpoint[];
}

export class AccountErasureAttemptReplacedError extends Error {
  readonly accountId: string;
  readonly expectedAttemptId: string;
  readonly actualAttemptId: string;

  constructor(accountId: string, expectedAttemptId: string, actualAttemptId: string) {
    super("A newer account-erasure attempt replaced this request. Refresh before continuing.");
    this.name = "AccountErasureAttemptReplacedError";
    this.accountId = accountId;
    this.expectedAttemptId = expectedAttemptId;
    this.actualAttemptId = actualAttemptId;
  }
}

const activeLocalCleanups = new Map<string, Promise<void>>();

function validatedAccountId(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) {
    throw new Error("The pending account-erasure record contains an invalid account identifier.");
  }
  return workspaceKey(value);
}

function validatedIdentifier(value: unknown, label: string): string {
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
  const accountId = validatedAccountId(candidate.accountId);
  if (expectedAccountId !== undefined && accountId !== validatedAccountId(expectedAccountId)) {
    throw new Error("The pending account-erasure checkpoint belongs to another account scope.");
  }
  const attemptId = validatedIdentifier(candidate.attemptId, "attempt identifier");
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
    if (!candidate.owner || typeof candidate.owner !== "object" || Array.isArray(candidate.owner)) {
      throw new Error("The pending account-erasure checkpoint has an invalid owner lease.");
    }
    const rawOwner = candidate.owner as Record<string, unknown>;
    const id = validatedIdentifier(rawOwner.id, "owner identifier");
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
    const accountId = validatedAccountId(item.accountId);
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
    const updatedAt = parsedTimestamp(item.updatedAt, "legacy updated timestamp", now).value;
    return {
      accountId,
      cloud: item.cloud as LegacyAccountErasureCheckpoint["cloud"],
      local: item.local as LocalErasureStatus,
      updatedAt,
    };
  });
  return { version: 1, checkpoints };
}

/**
 * Moves every valid v1 entry behind an IDB tombstone before deleting the old
 * shared key. Parsing happens for the complete envelope first, so malformed or
 * future data stays visibly blocking and is never partially accepted.
 */
export async function migrateLegacyAccountErasureCheckpoints(
  storage: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now(),
): Promise<AccountErasureCheckpoint[]> {
  const raw = storage.getItem(LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY);
  if (raw === null) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error("The legacy account-erasure checkpoint is not valid JSON.", {
      cause: error,
    });
  }
  const legacy = parseLegacyAccountErasureCheckpoints(decoded, now);
  const migrated: AccountErasureCheckpoint[] = [];
  for (const item of legacy.checkpoints) {
    const existing = await findAccountErasureCheckpoint(item.accountId, now);
    if (existing) {
      migrated.push(existing);
      continue;
    }
    const scope = await readAccountPersistenceScope(item.accountId);
    const mappedCloud: CloudErasureStatus = item.cloud === "pending"
      ? "failed"
      : item.cloud;
    const checkpoint: Omit<AccountErasureCheckpoint, "persistenceGeneration"> = {
      version: 2,
      accountId: item.accountId,
      attemptId: newAttemptId(),
      cloud: mappedCloud,
      local: item.local,
      session: "pending",
      owner: item.cloud === "finalizing"
        ? {
            id: "legacy-v1-owner",
            // The synthetic lease is deliberately expired. Recovery must still
            // call the explicit abandonment transition before local cleanup.
            leaseExpiresAt: item.updatedAt,
          }
        : null,
      updatedAt: item.updatedAt,
    };
    const armed = await beginAccountErasurePersistenceFence(
      item.accountId,
      scope.generation,
      checkpoint,
    );
    migrated.push(parseAccountErasureCheckpoint(
      armed.checkpoint,
      item.accountId,
      now,
    ));
  }

  // Do not erase a record that an older tab replaced while migration ran.
  const currentRaw = storage.getItem(LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY);
  if (currentRaw !== null && currentRaw !== raw) {
    throw new Error("The legacy account-erasure checkpoint changed during migration. Retry to inspect the newer record.");
  }
  storage.removeItem(LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY);
  for (const item of migrated) notifyAccountErasureChanged(item.accountId);
  return migrated;
}

/** Explicitly discards only unreadable v1 bookkeeping; IDB tombstones remain. */
export function discardLegacyAccountErasureCheckpoints(
  storage: Pick<Storage, "removeItem">,
): void {
  storage.removeItem(LEGACY_ACCOUNT_ERASURE_CHECKPOINT_KEY);
  notifyAccountErasureChanged();
}

/**
 * Explicit destructive repair for unreadable v1 erasure bookkeeping. The old
 * shared workspace is made permanently non-importable and removed before the
 * blocking erasure marker can be discarded. Any failure leaves that marker in
 * place so startup remains closed and the operation can be retried safely.
 */
export async function safelyDiscardLegacyAccountErasureCheckpoints(
  storage: Pick<Storage, "removeItem">,
  disableLegacyImport: (
    accountId: string,
  ) => Promise<LegacyWorkspaceImportJournal> = disableLegacyWorkspaceImport,
): Promise<void> {
  const legacyImport = await disableLegacyImport(ANONYMOUS_ACCOUNT_ID);
  if (
    legacyImport.accountId !== ANONYMOUS_ACCOUNT_ID
    || legacyImport.status === "pending"
  ) {
    throw new Error("Legacy workspace import did not reach a permanent terminal state, so damaged erasure bookkeeping was kept.");
  }
  storage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY);
  storage.removeItem(LEGACY_LAST_REMINDER_KEY);
  discardLegacyAccountErasureCheckpoints(storage);
}

function newAttemptId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function notifyAccountErasureChanged(accountId?: string) {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(ACCOUNT_ERASURE_CHANGE_EVENT, {
        detail: { accountId: accountId ?? null },
      }));
    }
  } catch {
    // The IndexedDB transition is authoritative; notification is best effort.
  }
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(ACCOUNT_ERASURE_BROADCAST_CHANNEL);
      channel.postMessage({ accountId: accountId ?? null });
      channel.close();
    }
  } catch {
    // Sandboxed browsers may block BroadcastChannel. The local event and
    // startup inventory still provide recovery.
  }
}

export function subscribeToAccountErasureChanges(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const localListener = () => listener();
  window.addEventListener(ACCOUNT_ERASURE_CHANGE_EVENT, localListener);
  let channel: BroadcastChannel | null = null;
  try {
    channel = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(ACCOUNT_ERASURE_BROADCAST_CHANNEL);
  } catch {
    // The same-tab event and startup inventory remain available.
  }
  channel?.addEventListener("message", localListener);
  return () => {
    window.removeEventListener(ACCOUNT_ERASURE_CHANGE_EVENT, localListener);
    channel?.removeEventListener("message", localListener);
    channel?.close();
  };
}

export async function listAccountErasureCheckpoints(
  now = Date.now(),
): Promise<AccountErasureCheckpointInventory> {
  const checkpoints: AccountErasureCheckpoint[] = [];
  const corrupt: CorruptAccountErasureCheckpoint[] = [];
  for (const record of await listRawAccountErasureCheckpoints()) {
    try {
      checkpoints.push(parseAccountErasureCheckpoint(record.value, String(record.key), now));
    } catch (error) {
      corrupt.push({
        key: record.key,
        reason: error instanceof Error
          ? error.message
          : "A pending account-erasure checkpoint could not be read safely.",
      });
    }
  }
  checkpoints.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  return { checkpoints, corrupt };
}

export async function findAccountErasureCheckpoint(
  accountId: string,
  now = Date.now(),
): Promise<AccountErasureCheckpoint | null> {
  const target = validatedAccountId(accountId);
  const raw = await readRawAccountErasureCheckpoint(target);
  return raw === null ? null : parseAccountErasureCheckpoint(raw, target, now);
}

export async function discardCorruptAccountErasureCheckpoint(
  key: IDBValidKey,
): Promise<void> {
  await deleteRawAccountErasureCheckpoint(key);
  notifyAccountErasureChanged(typeof key === "string" ? key : undefined);
}

async function mutateCheckpoint(
  accountId: string,
  attemptId: string,
  mutate: (current: AccountErasureCheckpoint) => AccountErasureCheckpoint | null,
  now = Date.now(),
): Promise<AccountErasureCheckpoint | null> {
  const target = validatedAccountId(accountId);
  const attempt = validatedIdentifier(attemptId, "attempt identifier");
  const result = await mutateRawAccountErasureCheckpoint(target, (raw) => {
    if (raw === null) throw new Error("No pending account-erasure checkpoint was found.");
    const current = parseAccountErasureCheckpoint(raw, target, now);
    // A replaced attempt owns this account now. A stale callback must not
    // mutate or remove it.
    if (current.attemptId !== attempt) {
      throw new AccountErasureAttemptReplacedError(target, attempt, current.attemptId);
    }
    const next = mutate(current);
    return next as unknown as Record<string, unknown> | null;
  });
  notifyAccountErasureChanged(target);
  return result === null ? null : parseAccountErasureCheckpoint(result, target, now);
}

export async function beginAccountErasureIntent(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
  options: { attemptId?: string; now?: number } = {},
): Promise<BegunAccountErasureIntent> {
  const target = validatedAccountId(accountId);
  if (target === ANONYMOUS_ACCOUNT_ID) {
    throw new Error("The anonymous workspace cannot be an account-erasure target.");
  }
  const now = options.now ?? Date.now();
  const checkpoint: Omit<AccountErasureCheckpoint, "persistenceGeneration"> = {
    version: 2,
    accountId: target,
    attemptId: options.attemptId ?? newAttemptId(),
    cloud: "pending",
    local: "pending",
    session: "pending",
    owner: null,
    updatedAt: new Date(now).toISOString(),
  };
  const armed = await beginAccountErasurePersistenceFence(
    target,
    expectedGeneration,
    checkpoint,
  );
  const parsed = parseAccountErasureCheckpoint(armed.checkpoint, target, now);
  notifyAccountErasureChanged(target);
  return { checkpoint: parsed, scope: armed.scope };
}

/**
 * Reconstructs missing bookkeeping for an existing permanent tombstone. With
 * no trustworthy record of the final RPC, the cloud outcome must be ambiguous;
 * recovery may clean local data but can retry cloud deletion only after exact
 * re-authentication and an explicit user action.
 */
export async function recoverOrphanedAccountErasureIntent(
  accountId: string,
  tombstonedGeneration: PersistenceScopeGeneration,
  options: { attemptId?: string; now?: number } = {},
): Promise<BegunAccountErasureIntent> {
  const target = validatedAccountId(accountId);
  if (target === ANONYMOUS_ACCOUNT_ID) {
    throw new Error("The anonymous workspace cannot be reconstructed as a connected-account erasure.");
  }
  const now = options.now ?? Date.now();
  const checkpoint: Omit<AccountErasureCheckpoint, "persistenceGeneration"> = {
    version: 2,
    accountId: target,
    attemptId: options.attemptId ?? newAttemptId(),
    cloud: "ambiguous",
    local: "pending",
    session: "pending",
    owner: null,
    updatedAt: new Date(now).toISOString(),
  };
  const recovered = await recoverOrphanedAccountErasurePersistenceFence(
    target,
    tombstonedGeneration,
    checkpoint,
  );
  const parsed = parseAccountErasureCheckpoint(recovered.checkpoint, target, now);
  notifyAccountErasureChanged(target);
  return { checkpoint: parsed, scope: recovered.scope };
}

function nextCheckpoint(
  current: AccountErasureCheckpoint,
  patch: Partial<Pick<AccountErasureCheckpoint, "cloud" | "local" | "session" | "owner">>,
  now: number,
): AccountErasureCheckpoint {
  return {
    ...current,
    ...patch,
    updatedAt: new Date(now).toISOString(),
  };
}

async function markFinalizing(
  checkpoint: AccountErasureCheckpoint,
  ownerId: string,
  now = Date.now(),
) {
  const owner = validatedIdentifier(ownerId, "owner identifier");
  return mutateCheckpoint(checkpoint.accountId, checkpoint.attemptId, (current) => {
    if (current.cloud === "complete") return current;
    if (current.cloud === "ambiguous") {
      throw new Error("The final account-deletion outcome is already ambiguous and cannot be retried.");
    }
    if (current.cloud === "finalizing") {
      throw new Error(current.owner?.id === owner
        ? "This request already invoked final account deletion."
        : "Another request owns the final account-deletion lease.");
    }
    return nextCheckpoint(current, {
      cloud: "finalizing",
      owner: {
        id: owner,
        leaseExpiresAt: new Date(now + ACCOUNT_ERASURE_OWNER_LEASE_MS).toISOString(),
      },
    }, now);
  }, now);
}

async function requireFinalizingOwnership(
  checkpoint: AccountErasureCheckpoint,
  ownerId: string,
): Promise<AccountErasureCheckpoint> {
  const current = await findAccountErasureCheckpoint(checkpoint.accountId);
  if (!current) {
    throw new Error("The final account-deletion checkpoint was lost before invocation.");
  }
  if (current.attemptId !== checkpoint.attemptId) {
    throw new AccountErasureAttemptReplacedError(
      checkpoint.accountId,
      checkpoint.attemptId,
      current.attemptId,
    );
  }
  if (current.cloud !== "finalizing" || current.owner?.id !== ownerId) {
    throw new Error("This request no longer owns the final account-deletion lease.");
  }
  return current;
}

/**
 * Resolves a final RPC only while this exact caller still owns the finalizing
 * phase. A completed or explicitly ambiguous outcome is idempotent, but no
 * caller may overwrite a different owner's lease or move an earlier phase.
 */
async function resolveOwnedFinalizing(
  checkpoint: AccountErasureCheckpoint,
  ownerId: string,
  outcome: "ambiguous" | "complete",
): Promise<AccountErasureCheckpoint> {
  const resolved = await mutateCheckpoint(
    checkpoint.accountId,
    checkpoint.attemptId,
    (current) => {
      if (current.cloud === "complete" || current.cloud === "ambiguous") {
        return current;
      }
      if (current.cloud !== "finalizing" || current.owner?.id !== ownerId) {
        throw new Error("This request no longer owns the final account-deletion lease.");
      }
      return nextCheckpoint(current, { cloud: outcome, owner: null }, Date.now());
    },
  );
  if (!resolved) {
    throw new Error("The final account-deletion checkpoint was lost.");
  }
  return resolved;
}

async function heartbeatFinalizing(
  checkpoint: AccountErasureCheckpoint,
  ownerId: string,
  now = Date.now(),
) {
  return mutateCheckpoint(checkpoint.accountId, checkpoint.attemptId, (current) => {
    if (current.cloud !== "finalizing" || current.owner?.id !== ownerId) return current;
    return nextCheckpoint(current, {
      owner: {
        id: ownerId,
        leaseExpiresAt: new Date(now + ACCOUNT_ERASURE_OWNER_LEASE_MS).toISOString(),
      },
    }, now);
  }, now);
}

export async function abandonExpiredFinalizingAccountErasure(
  accountId: string,
  attemptId: string,
  now = Date.now(),
): Promise<AccountErasureCheckpoint> {
  const updated = await mutateCheckpoint(accountId, attemptId, (current) => {
    if (current.cloud !== "finalizing" || !current.owner) return current;
    if (Date.parse(current.owner.leaseExpiresAt) > now) {
      throw new Error("The original account-deletion request still owns a live lease.");
    }
    return nextCheckpoint(current, { cloud: "ambiguous", owner: null }, now);
  }, now);
  if (!updated) throw new Error("No pending account-erasure checkpoint was found.");
  return updated;
}

/**
 * Reopens only a fully device-cleaned ambiguous attempt for an explicit cloud
 * retry. The caller must first verify the exact live account and obtain a
 * deliberate user action; recovery code must never invoke this automatically.
 */
export async function prepareAmbiguousAccountErasureRetry(
  accountId: string,
  attemptId: string,
  now = Date.now(),
): Promise<AccountErasureCheckpoint> {
  const updated = await mutateCheckpoint(accountId, attemptId, (current) => {
    if (
      current.cloud !== "ambiguous"
      || current.local !== "complete"
      || current.session !== "complete"
    ) {
      throw new Error(
        "Only an ambiguous account-erasure attempt with complete device and session cleanup can be explicitly retried.",
      );
    }
    return nextCheckpoint(current, { cloud: "failed", owner: null }, now);
  }, now);
  if (!updated) throw new Error("No ambiguous account-erasure checkpoint was found.");
  return updated;
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

export interface AdvanceCloudAccountErasureOptions {
  checkpoint: AccountErasureCheckpoint;
  ownerId?: string;
  eraseCloud: (onFinalDeletionStarting: () => Promise<void>) => Promise<unknown>;
}

export interface AdvanceCloudAccountErasureResult {
  cloud: "ambiguous" | "complete";
  warning: string | null;
  checkpoint: AccountErasureCheckpoint;
}

export async function advanceCloudAccountErasure({
  checkpoint,
  ownerId = newAttemptId(),
  eraseCloud,
}: AdvanceCloudAccountErasureOptions): Promise<AdvanceCloudAccountErasureResult> {
  const target = validatedAccountId(checkpoint.accountId);
  const owner = validatedIdentifier(ownerId, "owner identifier");
  const durable = await findAccountErasureCheckpoint(target);
  if (!durable || durable.attemptId !== checkpoint.attemptId) {
    throw new Error("This account-erasure attempt is no longer the active durable request.");
  }
  if (durable.cloud === "complete") {
    return { cloud: "complete", warning: null, checkpoint: durable };
  }
  if (durable.cloud === "ambiguous") {
    return {
      cloud: "ambiguous",
      warning: "The final account-deletion outcome is already uncertain and was not invoked again.",
      checkpoint: durable,
    };
  }
  if (durable.cloud === "finalizing") {
    throw new Error("A final account-deletion request already owns the durable lease.");
  }

  let finalRpcInvoked = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatFailure: unknown = null;
  try {
    await eraseCloud(async () => {
      const finalizing = await markFinalizing(durable, owner);
      if (
        !finalizing
        || finalizing.attemptId !== durable.attemptId
        || finalizing.cloud !== "finalizing"
        || finalizing.owner?.id !== owner
      ) {
        throw new Error("The final account-deletion attempt lost its durable ownership.");
      }
      // The acquisition above is atomic. Re-read immediately before returning
      // to the cloud adapter, whose next operation is the final destructive RPC.
      await requireFinalizingOwnership(finalizing, owner);
      finalRpcInvoked = true;
      heartbeatTimer = setInterval(() => {
        void heartbeatFinalizing(durable, owner).catch((error) => {
          heartbeatFailure ??= error;
        });
      }, Math.max(1_000, Math.floor(ACCOUNT_ERASURE_OWNER_LEASE_MS / 3)));
    });
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const finalOutcomeMayBeUncertain = finalRpcInvoked || (
      error instanceof CloudAccountErasureError
      && error.stage === "account"
      && error.accountDeletionMayHaveSucceeded
    );
    if (finalOutcomeMayBeUncertain) {
      const resolved = await resolveOwnedFinalizing(durable, owner, "ambiguous");
      if (resolved.cloud === "complete") {
        return { cloud: "complete", warning: null, checkpoint: resolved };
      }
      return {
        cloud: "ambiguous",
        warning: error instanceof Error
          ? error.message
          : "The final cloud deletion response was lost.",
        checkpoint: resolved,
      };
    }

    // Only failures that happen before the final RPC is invoked are retryable.
    const failed = await mutateCheckpoint(target, durable.attemptId, (current) => {
      // This caller may only fail the exact pre-final phase that it observed.
      // A concurrent owner or settled outcome is returned unchanged.
      if (current.cloud !== durable.cloud || current.owner !== null) return current;
      if (current.cloud !== "pending" && current.cloud !== "failed") return current;
      if (current.cloud === "failed") return current;
      return nextCheckpoint(current, {
        cloud: "failed",
        owner: null,
      }, Date.now());
    });
    if (!failed) throw error;
    if (failed.cloud === "complete") {
      return { cloud: "complete", warning: null, checkpoint: failed };
    }
    if (failed.cloud === "ambiguous") {
      return {
        cloud: "ambiguous",
        warning: "Another request already recorded an uncertain final account-deletion outcome.",
        checkpoint: failed,
      };
    }
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  const resolved = await resolveOwnedFinalizing(durable, owner, "complete");
  if (resolved.cloud === "ambiguous") {
    return {
      cloud: "ambiguous",
      warning: "Final account deletion returned after its durable lease was explicitly abandoned, so the recorded outcome remains uncertain.",
      checkpoint: resolved,
    };
  }
  return {
    cloud: "complete",
    warning: heartbeatFailure
      ? "Cloud deletion finished, but one device checkpoint heartbeat could not be saved."
      : null,
    checkpoint: resolved,
  };
}

function runSerializedLocalCleanup(accountId: string, cleanup: () => Promise<void>) {
  const target = validatedAccountId(accountId);
  const active = activeLocalCleanups.get(target);
  if (active) return active;
  const operation = Promise.resolve().then(cleanup);
  activeLocalCleanups.set(target, operation);
  const release = () => {
    if (activeLocalCleanups.get(target) === operation) activeLocalCleanups.delete(target);
  };
  void operation.then(release, release);
  return operation;
}

/** Removes only a tombstoned account and surfaces legacy marker failures. */
export async function eraseInactiveAccountLocalData(
  checkpoint: AccountErasureCheckpoint,
  legacyStorage?: Pick<Storage, "removeItem">,
  erasePersistence: (
    targetAccountId: string,
    generation: number,
  ) => Promise<unknown> = eraseAccountPersistenceWithTombstone,
) {
  const target = validatedAccountId(checkpoint.accountId);
  await erasePersistence(target, checkpoint.persistenceGeneration);
  // Old builds used localStorage for reminder delivery. A failure here is not
  // silently treated as complete because it can retain account-linked data.
  legacyStorage?.removeItem(reminderStorageKey(target));
}

export interface ResumeLocalAccountErasureOptions {
  checkpoint: AccountErasureCheckpoint;
  workspaceSwitching: boolean;
  /** True when switching is the deliberate terminal erasure barrier. */
  terminalFenced?: boolean;
  getAuthenticatedAccountId: () => Promise<string | null>;
  finishActiveAccountErasure?: (
    accountId: string,
    tombstonedGeneration: number,
    clearSession: () => Promise<string | null>,
  ) => Promise<{ sessionWarning: string | null }>;
  eraseInactiveAccount?: (checkpoint: AccountErasureCheckpoint) => Promise<void>;
  clearExactAccountSession: (accountId: string) => Promise<string | null>;
}

export interface ResumeLocalAccountErasureResult {
  erasedActiveAccount: boolean;
  sessionWarning: string | null;
  checkpoint: AccountErasureCheckpoint | null;
}

async function recordCleanupProgress(
  checkpoint: AccountErasureCheckpoint,
  patch: Partial<Pick<AccountErasureCheckpoint, "local" | "session">>,
): Promise<AccountErasureCheckpoint | null> {
  return mutateCheckpoint(checkpoint.accountId, checkpoint.attemptId, (current) => {
    // The permanent tombstone needs a permanent, readable completion marker.
    // Deleting this checkpoint would make a successful erasure
    // indistinguishable from a corrupt orphan on the next bootstrap.
    return nextCheckpoint(current, patch, Date.now());
  });
}

export async function resumeLocalAccountErasure({
  checkpoint,
  workspaceSwitching,
  terminalFenced = false,
  getAuthenticatedAccountId,
  finishActiveAccountErasure,
  eraseInactiveAccount = (target) => eraseInactiveAccountLocalData(target),
  clearExactAccountSession,
}: ResumeLocalAccountErasureOptions): Promise<ResumeLocalAccountErasureResult> {
  const target = validatedAccountId(checkpoint.accountId);
  const durable = await findAccountErasureCheckpoint(target);
  if (!durable || durable.attemptId !== checkpoint.attemptId) {
    throw new Error("No matching pending local account cleanup was found.");
  }
  if (durable.cloud !== "ambiguous" && durable.cloud !== "complete") {
    throw new Error(durable.cloud === "finalizing"
      ? "Final cloud account deletion is still owned by another request, so the device copy was kept."
      : "Cloud account deletion has not reached the final step, so the device copy was kept.");
  }
  if (workspaceSwitching && !terminalFenced) {
    throw new Error("Wait for the active workspace transition before retrying device cleanup.");
  }

  let freshAccountId = await getAuthenticatedAccountId();
  const erasedActiveAccount = freshAccountId === target;
  let sessionWarning: string | null = null;

  if (durable.local === "pending") {
    await runSerializedLocalCleanup(target, async () => {
      if (erasedActiveAccount && finishActiveAccountErasure) {
        const result = await finishActiveAccountErasure(
          target,
          durable.persistenceGeneration,
          async () => {
            const immediatelyCurrent = await getAuthenticatedAccountId();
            if (immediatelyCurrent !== target) return null;
            return clearExactAccountSession(target);
          },
        );
        sessionWarning = result.sessionWarning;
      } else {
        await eraseInactiveAccount(durable);
      }
    });
    await recordCleanupProgress(durable, { local: "complete" });
  }

  freshAccountId = await getAuthenticatedAccountId();
  if (freshAccountId === target && !sessionWarning) {
    // Re-check immediately before clearing so a different account that signed
    // in during cleanup is never signed out.
    if (await getAuthenticatedAccountId() === target) {
      sessionWarning = await clearExactAccountSession(target);
    }
  }
  if (freshAccountId !== target || !sessionWarning) {
    await recordCleanupProgress(durable, { session: "complete" });
  }

  return {
    erasedActiveAccount,
    sessionWarning,
    checkpoint: await findAccountErasureCheckpoint(target),
  };
}
