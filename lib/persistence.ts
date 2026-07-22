import type { AppState } from "@/lib/types";
import { CURRENT_STATE_VERSION, parseImportedState } from "@/lib/state-schema";
import {
  MAX_UNDO_HISTORY_ITEMS,
  trimWorkspaceHistory,
} from "@/lib/provider-state";
import {
  isAllowedEvidenceMimeType,
  isValidEvidenceFileSize,
  normalizeEvidenceMimeType,
} from "@/lib/goal-evidence";

export const PERSISTENCE_DATABASE_NAME = "evolvra-persistence";
export const PERSISTENCE_DATABASE_VERSION = 2;
export const LEGACY_WORKSPACE_STORAGE_KEY = "evolvra:workspace:v1";

const WORKSPACE_STORE = "workspaces";
const EVIDENCE_STORE = "evidence";
const ACCOUNT_SCOPE_STORE = "account-scopes";
const ACCOUNT_ERASURE_STORE = "account-erasure-checkpoints";
const ACCOUNT_REMINDER_STORE = "account-reminders";
const LEGACY_IMPORT_CLAIM_STORE = "legacy-import-claims";
const EVIDENCE_ACCOUNT_INDEX = "by-account";
const EVIDENCE_ACCOUNT_GOAL_INDEX = "by-account-goal";

type UnknownRecord = Record<string, unknown>;

export interface WorkspaceEnvelope {
  accountId: string;
  state: AppState;
  history: AppState[];
  dirty: boolean;
  /** Browser-local compare-and-swap revision. Missing legacy values read as zero. */
  localRevision: number;
  revision: number;
  serverUpdatedAt?: string;
  savedAt: string;
  /** Transient read metadata. New writes should omit this after surfacing it to the user. */
  recovery?: WorkspaceRecovery;
}

export interface WorkspaceRecovery {
  source: "history" | "current";
  recoveredFromHistoryIndex?: number;
  discardedHistoryEntries: number;
  message: string;
}

export interface EvidenceBlobRecord {
  accountId: string;
  goalId: string;
  evidenceId: string;
  blob: Blob;
  savedAt: string;
}

export interface EvidenceBlobInput {
  accountId: string;
  goalId: string;
  evidenceId: string;
  blob: Blob;
  savedAt?: string;
}

export type PersistenceScopeGeneration = number;

export interface AccountPersistenceScope {
  accountId: string;
  generation: PersistenceScopeGeneration;
  tombstoned: boolean;
  updatedAt: string;
}

export interface AccountWorkspaceRead {
  workspace: WorkspaceEnvelope | null;
  scope: AccountPersistenceScope;
}

export interface AccountPersistenceEraseResult {
  deletedEvidence: number;
  scope: AccountPersistenceScope;
}

export interface RawAccountErasureCheckpoint {
  key: IDBValidKey;
  value: unknown;
}

export interface PendingLegacyWorkspaceImport {
  accountId: string;
  status: "pending";
  raw: string;
  capturedAt: string;
}

export interface CommittedLegacyWorkspaceImport {
  accountId: string;
  status: "committed";
  committedAt: string;
}

export interface DisabledLegacyWorkspaceImport {
  accountId: string;
  status: "disabled";
  disabledAt: string;
}

export type LegacyWorkspaceImportJournal =
  | PendingLegacyWorkspaceImport
  | CommittedLegacyWorkspaceImport
  | DisabledLegacyWorkspaceImport;

interface AccountReminderRecord {
  accountId: string;
  dateKey: string;
  updatedAt: string;
}

/**
 * Produces a state-only recovery file. Cloud object paths contain an account
 * identifier, so those paths are removed while local file metadata is kept.
 */
export function privacySafeWorkspaceExport(state: AppState): AppState {
  const safeState = JSON.parse(JSON.stringify(state)) as AppState;
  for (const goal of safeState.goals) {
    goal.evidence = goal.evidence.map((item) => {
      if (item.type !== "file") return item;
      return {
        id: item.id,
        type: "file",
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
      };
    });
  }
  return safeState;
}

export type EvidenceKey = [accountId: string, goalId: string, evidenceId: string];

export type PersistenceErrorCode =
  | "unavailable"
  | "blocked"
  | "open-failed"
  | "transaction-failed"
  | "local-conflict"
  | "scope-conflict"
  | "erasure-fenced"
  | "invalid-argument"
  | "invalid-data";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly operation: string;
  readonly cause?: unknown;

  constructor(code: PersistenceErrorCode, operation: string, message: string, cause?: unknown) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.operation = operation;
    this.cause = cause;
  }
}

export class LocalWorkspaceConflictError extends PersistenceError {
  readonly accountId: string;
  readonly expectedLocalRevision: number;
  readonly actualLocalRevision: number;

  constructor(accountId: string, expectedLocalRevision: number, actualLocalRevision: number) {
    super(
      "local-conflict",
      "write-workspace",
      "Another Evolvra tab saved this private workspace first. The copy open in this tab was not written.",
    );
    this.name = "LocalWorkspaceConflictError";
    this.accountId = accountId;
    this.expectedLocalRevision = expectedLocalRevision;
    this.actualLocalRevision = actualLocalRevision;
  }
}

export class AccountPersistenceScopeError extends PersistenceError {
  readonly accountId: string;
  readonly expectedGeneration: PersistenceScopeGeneration;
  readonly actualGeneration: PersistenceScopeGeneration;

  constructor(
    accountId: string,
    expectedGeneration: PersistenceScopeGeneration,
    actualGeneration: PersistenceScopeGeneration,
    tombstoned: boolean,
  ) {
    super(
      tombstoned ? "erasure-fenced" : "scope-conflict",
      "verify-account-scope",
      tombstoned
        ? "This account is permanently fenced after erasure. No device data was written."
        : "This account scope changed in another tab. No stale device data was written.",
    );
    this.name = "AccountPersistenceScopeError";
    this.accountId = accountId;
    this.expectedGeneration = expectedGeneration;
    this.actualGeneration = actualGeneration;
  }
}

let databasePromise: Promise<IDBDatabase> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));

const isPersistenceId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim();

const isLocalRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const normalizedStoredLocalRevision = (value: unknown): number | null =>
  value === undefined ? 0 : isLocalRevision(value) ? value : null;

const isBlobLike = (value: unknown): value is Blob => {
  if (!isRecord(value)) return false;
  return typeof value.size === "number"
    && typeof value.type === "string"
    && typeof value.arrayBuffer === "function";
};

function isAppState(value: unknown): value is AppState {
  if (!isRecord(value) || value.version !== CURRENT_STATE_VERSION) return false;
  try {
    const parsed = parseImportedState(value);
    return jsonValuesEqual(value, parsed);
  } catch {
    return false;
  }
}

function parseStoredState(value: unknown): AppState | null {
  try {
    return parseImportedState(value);
  } catch {
    return null;
  }
}

function isWorkspaceRecovery(value: unknown): value is WorkspaceRecovery {
  if (!isRecord(value)) return false;
  return (value.source === "history" || value.source === "current")
    && (value.recoveredFromHistoryIndex === undefined
      || (Number.isSafeInteger(value.recoveredFromHistoryIndex) && Number(value.recoveredFromHistoryIndex) >= 0))
    && Number.isSafeInteger(value.discardedHistoryEntries)
    && Number(value.discardedHistoryEntries) >= 0
    && typeof value.message === "string"
    && Boolean(value.message.trim());
}

function hasWorkspaceMetadata(value: UnknownRecord): boolean {
  return isPersistenceId(value.accountId)
    && typeof value.dirty === "boolean"
    && normalizedStoredLocalRevision(value.localRevision) !== null
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && (value.serverUpdatedAt === undefined || isIsoDate(value.serverUpdatedAt))
    && isIsoDate(value.savedAt)
    && (value.recovery === undefined || isWorkspaceRecovery(value.recovery));
}

export function isWorkspaceEnvelope(value: unknown): value is WorkspaceEnvelope {
  if (!isRecord(value)) return false;
  return hasWorkspaceMetadata(value)
    && isLocalRevision(value.localRevision)
    && isAppState(value.state)
    && Array.isArray(value.history)
    && value.history.length <= MAX_UNDO_HISTORY_ITEMS
    && value.history.every(isAppState)
    && trimWorkspaceHistory(value.history).length === value.history.length;
}

export function isEvidenceBlobRecord(value: unknown): value is EvidenceBlobRecord {
  if (!isRecord(value)) return false;
  const blob = value.blob;
  return isPersistenceId(value.accountId)
    && isPersistenceId(value.goalId)
    && isPersistenceId(value.evidenceId)
    && isBlobLike(blob)
    && isAllowedEvidenceMimeType(normalizeEvidenceMimeType(blob.type))
    && isValidEvidenceFileSize(blob.size)
    && isIsoDate(value.savedAt);
}

function requireId(value: string, field: string): string {
  if (!isPersistenceId(value)) {
    throw new PersistenceError(
      "invalid-argument",
      "validate-key",
      `${field} must be a non-empty identifier without surrounding whitespace.`,
    );
  }
  return value;
}

export function workspaceKey(accountId: string): string {
  return requireId(accountId, "accountId");
}

export function evidenceKey(accountId: string, goalId: string, evidenceId: string): EvidenceKey {
  return [
    requireId(accountId, "accountId"),
    requireId(goalId, "goalId"),
    requireId(evidenceId, "evidenceId"),
  ];
}

export function hasIndexedDbSupport(source: unknown = globalThis): boolean {
  try {
    if (!isRecord(source)) return false;
    const candidate = source.indexedDB;
    return isRecord(candidate) && typeof candidate.open === "function";
  } catch {
    return false;
  }
}

function persistenceError(
  code: PersistenceErrorCode,
  operation: string,
  message: string,
  cause?: unknown,
) {
  return cause instanceof PersistenceError
    ? cause
    : new PersistenceError(code, operation, message, cause);
}

function upgradeDatabase(database: IDBDatabase, transaction: IDBTransaction) {
  if (!database.objectStoreNames.contains(WORKSPACE_STORE)) {
    database.createObjectStore(WORKSPACE_STORE, { keyPath: "accountId" });
  }

  const evidence = database.objectStoreNames.contains(EVIDENCE_STORE)
    ? transaction.objectStore(EVIDENCE_STORE)
    : database.createObjectStore(EVIDENCE_STORE, {
      keyPath: ["accountId", "goalId", "evidenceId"],
    });

  if (!evidence.indexNames.contains(EVIDENCE_ACCOUNT_INDEX)) {
    evidence.createIndex(EVIDENCE_ACCOUNT_INDEX, "accountId", { unique: false });
  }
  if (!evidence.indexNames.contains(EVIDENCE_ACCOUNT_GOAL_INDEX)) {
    evidence.createIndex(EVIDENCE_ACCOUNT_GOAL_INDEX, ["accountId", "goalId"], { unique: false });
  }

  if (!database.objectStoreNames.contains(ACCOUNT_SCOPE_STORE)) {
    database.createObjectStore(ACCOUNT_SCOPE_STORE, { keyPath: "accountId" });
  }
  if (!database.objectStoreNames.contains(ACCOUNT_ERASURE_STORE)) {
    database.createObjectStore(ACCOUNT_ERASURE_STORE, { keyPath: "accountId" });
  }
  if (!database.objectStoreNames.contains(ACCOUNT_REMINDER_STORE)) {
    database.createObjectStore(ACCOUNT_REMINDER_STORE, { keyPath: "accountId" });
  }
  if (!database.objectStoreNames.contains(LEGACY_IMPORT_CLAIM_STORE)) {
    database.createObjectStore(LEGACY_IMPORT_CLAIM_STORE, { keyPath: "accountId" });
  }
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!hasIndexedDbSupport()) {
    throw new PersistenceError(
      "unavailable",
      "open-database",
      "IndexedDB is not available in this environment. Workspace persistence was not attempted.",
    );
  }
  if (databasePromise) return databasePromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const request = globalThis.indexedDB.open(
      PERSISTENCE_DATABASE_NAME,
      PERSISTENCE_DATABASE_VERSION,
    );

    const rejectOnce = (error: PersistenceError) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.onupgradeneeded = () => {
      try {
        if (!request.transaction) {
          throw new Error("IndexedDB did not provide an upgrade transaction.");
        }
        upgradeDatabase(request.result, request.transaction);
      } catch (cause) {
        try {
          request.transaction?.abort();
        } catch {
          // The transaction may already have aborted because of the upgrade error.
        }
        rejectOnce(persistenceError(
          "open-failed",
          "upgrade-database",
          "Could not prepare the IndexedDB persistence stores.",
          cause,
        ));
      }
    };

    request.onblocked = () => rejectOnce(new PersistenceError(
      "blocked",
      "open-database",
      "IndexedDB is blocked by another open Evolvra tab. Close older tabs and try again.",
    ));

    request.onerror = () => rejectOnce(persistenceError(
      "open-failed",
      "open-database",
      "Could not open the IndexedDB persistence database.",
      request.error,
    ));

    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
  });

  databasePromise = opening;
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = null;
  });
  return opening;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("IndexedDB transaction was aborted."),
    );
  });
}

async function runStoresTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  operation: string,
  action: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction(storeNames, mode);
  } catch (cause) {
    throw persistenceError(
      "transaction-failed",
      operation,
      `Could not start the IndexedDB transaction for ${operation}.`,
      cause,
    );
  }

  const completed = transactionCompletion(transaction);
  try {
    const result = await action(transaction);
    await completed;
    return result;
  } catch (cause) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already be complete or aborted.
    }
    try {
      await completed;
    } catch {
      // Preserve the original request or validation error below.
    }
    throw persistenceError(
      "transaction-failed",
      operation,
      `IndexedDB could not complete ${operation}.`,
      cause,
    );
  }
}

async function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: string,
  action: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  let transaction: IDBTransaction;
  try {
    transaction = database.transaction(storeName, mode);
  } catch (cause) {
    throw persistenceError(
      "transaction-failed",
      operation,
      `Could not start the IndexedDB transaction for ${operation}.`,
      cause,
    );
  }

  const completed = transactionCompletion(transaction);
  try {
    const result = await action(transaction.objectStore(storeName));
    await completed;
    return result;
  } catch (cause) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already be complete or aborted.
    }
    try {
      await completed;
    } catch {
      // Preserve the original request or validation error below.
    }
    throw persistenceError(
      "transaction-failed",
      operation,
      `IndexedDB could not complete ${operation}.`,
      cause,
    );
  }
}

function requireScopeGeneration(value: number): PersistenceScopeGeneration {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PersistenceError(
      "invalid-argument",
      "validate-account-scope",
      "The account persistence generation must be a non-negative safe integer.",
    );
  }
  return value;
}

function initialAccountPersistenceScope(accountId: string): AccountPersistenceScope {
  return {
    accountId,
    generation: 0,
    tombstoned: false,
    updatedAt: new Date(0).toISOString(),
  };
}

function decodeAccountPersistenceScope(
  value: unknown,
  expectedAccountId: string,
): AccountPersistenceScope {
  if (value === undefined) return initialAccountPersistenceScope(expectedAccountId);
  if (
    !isRecord(value)
    || value.accountId !== expectedAccountId
    || !Number.isSafeInteger(value.generation)
    || Number(value.generation) < 0
    || typeof value.tombstoned !== "boolean"
    || !isIsoDate(value.updatedAt)
  ) {
    throw new PersistenceError(
      "invalid-data",
      "read-account-scope",
      "The account persistence fence is damaged. No account data was read or written.",
    );
  }
  return {
    accountId: expectedAccountId,
    generation: Number(value.generation),
    tombstoned: value.tombstoned,
    updatedAt: value.updatedAt,
  };
}

async function accountScopeFromStore(
  store: IDBObjectStore,
  accountId: string,
): Promise<AccountPersistenceScope> {
  const value: unknown = await requestResult(store.get(accountId));
  return decodeAccountPersistenceScope(value, accountId);
}

async function requireWritableAccountScope(
  store: IDBObjectStore,
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<AccountPersistenceScope> {
  const expected = requireScopeGeneration(expectedGeneration);
  const current = await accountScopeFromStore(store, accountId);
  if (current.tombstoned || current.generation !== expected) {
    throw new AccountPersistenceScopeError(
      accountId,
      expected,
      current.generation,
      current.tombstoned,
    );
  }
  return current;
}

export async function readAccountPersistenceScope(
  accountId: string,
): Promise<AccountPersistenceScope> {
  const key = workspaceKey(accountId);
  return runTransaction(ACCOUNT_SCOPE_STORE, "readonly", "read-account-scope", async (store) =>
    accountScopeFromStore(store, key));
}

export async function listTombstonedAccountPersistenceScopes(): Promise<AccountPersistenceScope[]> {
  return runTransaction(
    ACCOUNT_SCOPE_STORE,
    "readonly",
    "list-tombstoned-account-scopes",
    async (store) => {
      const values: unknown[] = await requestResult(store.getAll());
      return values.map((value) => {
        if (!isRecord(value) || typeof value.accountId !== "string") {
          throw new PersistenceError(
            "invalid-data",
            "list-tombstoned-account-scopes",
            "An account persistence fence is damaged. No account data was opened.",
          );
        }
        return decodeAccountPersistenceScope(value, value.accountId);
      }).filter((scope) => scope.tombstoned);
    },
  );
}

export async function accountPersistenceWriteAllowed(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<boolean> {
  const key = workspaceKey(accountId);
  const expected = requireScopeGeneration(expectedGeneration);
  const current = await readAccountPersistenceScope(key);
  return !current.tombstoned && current.generation === expected;
}

export async function accountErasureTombstoneExists(accountId: string): Promise<boolean> {
  return (await readAccountPersistenceScope(accountId)).tombstoned;
}

export async function beginAccountErasurePersistenceFence(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
  checkpoint: Record<string, unknown>,
): Promise<{ scope: AccountPersistenceScope; checkpoint: unknown }> {
  const key = workspaceKey(accountId);
  const expected = requireScopeGeneration(expectedGeneration);
  if (checkpoint.accountId !== key) {
    throw new PersistenceError(
      "invalid-data",
      "begin-account-erasure-fence",
      "The account-erasure intent did not match the persistence scope.",
    );
  }
  return runStoresTransaction(
    [ACCOUNT_SCOPE_STORE, ACCOUNT_ERASURE_STORE, ACCOUNT_REMINDER_STORE],
    "readwrite",
    "begin-account-erasure-fence",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const current = await accountScopeFromStore(scopeStore, key);
      const checkpointStore = transaction.objectStore(ACCOUNT_ERASURE_STORE);
      const existingCheckpoint: unknown = await requestResult(
        checkpointStore.get(key),
      );
      // Beginning is idempotent across tabs. Once one tab has atomically armed
      // the tombstone and intent, another tab adopts that exact durable attempt
      // instead of overwriting its attempt id or lifecycle progress.
      if (existingCheckpoint !== undefined) {
        if (!current.tombstoned) {
          throw new PersistenceError(
            "invalid-data",
            "begin-account-erasure-fence",
            "An account-erasure checkpoint exists without its permanent persistence fence.",
          );
        }
        return { scope: current, checkpoint: existingCheckpoint };
      }
      let next = current;
      if (current.tombstoned) {
        if (current.generation !== expected) {
          throw new AccountPersistenceScopeError(
            key,
            expected,
            current.generation,
            true,
          );
        }
      } else {
        if (current.generation !== expected) {
          throw new AccountPersistenceScopeError(
            key,
            expected,
            current.generation,
            false,
          );
        }
        if (current.generation === Number.MAX_SAFE_INTEGER) {
          throw new PersistenceError(
            "invalid-data",
            "begin-account-erasure-fence",
            "The account persistence generation is exhausted.",
          );
        }
        next = {
          accountId: key,
          generation: current.generation + 1,
          tombstoned: true,
          updatedAt: new Date().toISOString(),
        };
        await requestResult(scopeStore.put(next));
      }
      const storedCheckpoint = { ...checkpoint, persistenceGeneration: next.generation };
      await requestResult(checkpointStore.add(storedCheckpoint));
      await requestResult(transaction.objectStore(ACCOUNT_REMINDER_STORE).delete(key));
      return { scope: next, checkpoint: storedCheckpoint };
    },
  );
}

/**
 * Reattaches recovery bookkeeping to an already tombstoned scope. Unlike the
 * normal begin path, this can never create a new fence or imply that the cloud
 * deletion RPC has not run; callers must store an explicitly uncertain state.
 */
export async function recoverOrphanedAccountErasurePersistenceFence(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
  checkpoint: Record<string, unknown>,
): Promise<{ scope: AccountPersistenceScope; checkpoint: unknown }> {
  const key = workspaceKey(accountId);
  const expected = requireScopeGeneration(expectedGeneration);
  if (key === "anonymous") {
    throw new PersistenceError(
      "invalid-argument",
      "recover-orphaned-account-erasure-fence",
      "The anonymous workspace cannot be reconstructed as a connected-account erasure.",
    );
  }
  if (checkpoint.accountId !== key || checkpoint.cloud !== "ambiguous") {
    throw new PersistenceError(
      "invalid-data",
      "recover-orphaned-account-erasure-fence",
      "Orphan recovery requires an exact account and an explicitly uncertain cloud outcome.",
    );
  }
  return runStoresTransaction(
    [ACCOUNT_SCOPE_STORE, ACCOUNT_ERASURE_STORE, ACCOUNT_REMINDER_STORE],
    "readwrite",
    "recover-orphaned-account-erasure-fence",
    async (transaction) => {
      const scope = await accountScopeFromStore(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
      );
      if (!scope.tombstoned || scope.generation !== expected) {
        throw new AccountPersistenceScopeError(
          key,
          expected,
          scope.generation,
          scope.tombstoned,
        );
      }
      const checkpointStore = transaction.objectStore(ACCOUNT_ERASURE_STORE);
      const existing: unknown = await requestResult(checkpointStore.get(key));
      if (existing !== undefined) {
        if (
          !isRecord(existing)
          || existing.accountId !== key
          || existing.cloud !== "ambiguous"
          || existing.persistenceGeneration !== scope.generation
        ) {
          throw new PersistenceError(
            "invalid-data",
            "recover-orphaned-account-erasure-fence",
            "Orphan recovery found different or damaged account-erasure bookkeeping and did not replace it.",
          );
        }
        return { scope, checkpoint: existing };
      }
      const storedCheckpoint = { ...checkpoint, persistenceGeneration: scope.generation };
      await requestResult(checkpointStore.add(storedCheckpoint));
      await requestResult(transaction.objectStore(ACCOUNT_REMINDER_STORE).delete(key));
      return { scope, checkpoint: storedCheckpoint };
    },
  );
}

/**
 * Reads reminder delivery metadata in the same transaction as the account
 * generation. Tombstoned accounts intentionally appear to have no reminder.
 */
export async function readAccountReminderDate(accountId: string): Promise<string | null> {
  const key = workspaceKey(accountId);
  return runStoresTransaction(
    [ACCOUNT_SCOPE_STORE, ACCOUNT_REMINDER_STORE],
    "readonly",
    "read-account-reminder",
    async (transaction) => {
      const scope = await accountScopeFromStore(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
      );
      if (scope.tombstoned) return null;
      const raw: unknown = await requestResult(
        transaction.objectStore(ACCOUNT_REMINDER_STORE).get(key),
      );
      if (raw === undefined) return null;
      if (
        !isRecord(raw)
        || raw.accountId !== key
        || typeof raw.dateKey !== "string"
        || raw.dateKey.length === 0
        || !isIsoDate(raw.updatedAt)
      ) {
        throw new PersistenceError(
          "invalid-data",
          "read-account-reminder",
          "The account reminder marker is damaged. No reminder was sent.",
        );
      }
      return raw.dateKey;
    },
  );
}

export async function writeAccountReminderDate(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
  dateKey: string,
): Promise<void> {
  const key = workspaceKey(accountId);
  if (!dateKey.trim()) {
    throw new PersistenceError(
      "invalid-argument",
      "write-account-reminder",
      "The reminder date key must not be empty.",
    );
  }
  await runStoresTransaction(
    [ACCOUNT_SCOPE_STORE, ACCOUNT_REMINDER_STORE],
    "readwrite",
    "write-account-reminder",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
        expectedGeneration,
      );
      const record: AccountReminderRecord = {
        accountId: key,
        dateKey,
        updatedAt: new Date().toISOString(),
      };
      await requestResult(transaction.objectStore(ACCOUNT_REMINDER_STORE).put(record));
    },
  );
}

interface LegacyWorkspaceImportClaimMarker {
  accountId: string;
  claimedAt: string;
}

type DecodedLegacyWorkspaceImport =
  | { kind: "absent" }
  | { kind: "journal"; value: LegacyWorkspaceImportJournal }
  | { kind: "legacy-claim"; value: LegacyWorkspaceImportClaimMarker };

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function invalidLegacyWorkspaceImportJournal(operation: string): PersistenceError {
  return new PersistenceError(
    "invalid-data",
    operation,
    "The legacy workspace import journal is malformed and was not changed.",
  );
}

function requireLegacyWorkspaceImportTimestamp(value: string, operation: string): string {
  if (!isIsoDate(value)) {
    throw new PersistenceError(
      "invalid-argument",
      operation,
      "The legacy workspace import journal timestamp must be a valid date.",
    );
  }
  return value;
}

function decodeLegacyWorkspaceImport(
  value: unknown,
  accountId: string,
  operation: string,
): DecodedLegacyWorkspaceImport {
  if (value === undefined) return { kind: "absent" };
  if (!isRecord(value) || value.accountId !== accountId) {
    throw invalidLegacyWorkspaceImportJournal(operation);
  }

  if (
    value.status === "pending"
    && hasOnlyKeys(value, ["accountId", "status", "raw", "capturedAt"])
    && typeof value.raw === "string"
    && isIsoDate(value.capturedAt)
  ) {
    return { kind: "journal", value: value as unknown as PendingLegacyWorkspaceImport };
  }

  if (
    value.status === "committed"
    && hasOnlyKeys(value, ["accountId", "status", "committedAt"])
    && isIsoDate(value.committedAt)
  ) {
    return { kind: "journal", value: value as unknown as CommittedLegacyWorkspaceImport };
  }

  if (
    value.status === "disabled"
    && hasOnlyKeys(value, ["accountId", "status", "disabledAt"])
    && isIsoDate(value.disabledAt)
  ) {
    return { kind: "journal", value: value as unknown as DisabledLegacyWorkspaceImport };
  }

  if (
    value.status === undefined
    && hasOnlyKeys(value, ["accountId", "claimedAt"])
    && isIsoDate(value.claimedAt)
  ) {
    return {
      kind: "legacy-claim",
      value: value as unknown as LegacyWorkspaceImportClaimMarker,
    };
  }

  throw invalidLegacyWorkspaceImportJournal(operation);
}

/**
 * Interprets a journal record without mutating it. Old one-shot claim markers
 * are terminal when no synchronously observed localStorage value is available.
 */
export function parseLegacyWorkspaceImportJournal(
  value: unknown,
  accountId: string,
): LegacyWorkspaceImportJournal | null {
  const key = workspaceKey(accountId);
  const decoded = decodeLegacyWorkspaceImport(value, key, "read-legacy-workspace-import");
  if (decoded.kind === "absent") return null;
  if (decoded.kind === "journal") return decoded.value;
  return {
    accountId: key,
    status: "committed",
    committedAt: decoded.value.claimedAt,
  };
}

/**
 * Computes the atomic capture transition. Existing pending data always wins,
 * so racing tabs adopt the first raw localStorage value durably recorded.
 */
export function prepareLegacyWorkspaceImportCapture(
  value: unknown,
  accountId: string,
  observedRaw: string | null,
  now = new Date().toISOString(),
): LegacyWorkspaceImportJournal {
  const key = workspaceKey(accountId);
  const timestamp = requireLegacyWorkspaceImportTimestamp(now, "capture-legacy-workspace-import");
  const decoded = decodeLegacyWorkspaceImport(value, key, "capture-legacy-workspace-import");

  if (decoded.kind === "journal") return decoded.value;
  if (decoded.kind === "legacy-claim") {
    return observedRaw === null
      ? {
          accountId: key,
          status: "committed",
          committedAt: decoded.value.claimedAt,
        }
      : {
          accountId: key,
          status: "pending",
          raw: observedRaw,
          capturedAt: timestamp,
        };
  }
  return observedRaw === null
    ? { accountId: key, status: "committed", committedAt: timestamp }
    : { accountId: key, status: "pending", raw: observedRaw, capturedAt: timestamp };
}

/** Computes the post-persistence transition and removes pending raw data. */
export function prepareLegacyWorkspaceImportCommit(
  value: unknown,
  accountId: string,
  now = new Date().toISOString(),
): LegacyWorkspaceImportJournal {
  const key = workspaceKey(accountId);
  const timestamp = requireLegacyWorkspaceImportTimestamp(now, "commit-legacy-workspace-import");
  const decoded = decodeLegacyWorkspaceImport(value, key, "commit-legacy-workspace-import");

  if (decoded.kind === "absent") {
    throw new PersistenceError(
      "invalid-data",
      "commit-legacy-workspace-import",
      "A legacy workspace import cannot be committed before it is captured.",
    );
  }
  if (decoded.kind === "legacy-claim") {
    return {
      accountId: key,
      status: "committed",
      committedAt: decoded.value.claimedAt,
    };
  }
  if (decoded.value.status !== "pending") return decoded.value;
  return { accountId: key, status: "committed", committedAt: timestamp };
}

/**
 * Computes the permanent repair transition used after corrupt legacy data is
 * deliberately erased. This is the only transition that may replace an
 * unrecognisable journal record.
 */
export function prepareLegacyWorkspaceImportDisable(
  value: unknown,
  accountId: string,
  now = new Date().toISOString(),
): LegacyWorkspaceImportJournal {
  const key = workspaceKey(accountId);
  const timestamp = requireLegacyWorkspaceImportTimestamp(now, "disable-legacy-workspace-import");
  let decoded: DecodedLegacyWorkspaceImport;
  try {
    decoded = decodeLegacyWorkspaceImport(value, key, "disable-legacy-workspace-import");
  } catch (error) {
    if (!(error instanceof PersistenceError) || error.code !== "invalid-data") throw error;
    return { accountId: key, status: "disabled", disabledAt: timestamp };
  }

  if (decoded.kind === "legacy-claim") {
    return {
      accountId: key,
      status: "committed",
      committedAt: decoded.value.claimedAt,
    };
  }
  if (decoded.kind === "journal" && decoded.value.status !== "pending") {
    return decoded.value;
  }
  return { accountId: key, status: "disabled", disabledAt: timestamp };
}

/**
 * Atomically captures or adopts the first synchronously observed legacy
 * localStorage value. Pending raw data remains durable until explicitly
 * committed or disabled.
 */
export async function captureLegacyWorkspaceImport(
  accountId: string,
  observedRaw: string | null,
): Promise<LegacyWorkspaceImportJournal> {
  const key = workspaceKey(accountId);
  return runTransaction(
    LEGACY_IMPORT_CLAIM_STORE,
    "readwrite",
    "capture-legacy-workspace-import",
    async (store) => {
      const existing: unknown = await requestResult(store.get(key));
      const journal = prepareLegacyWorkspaceImportCapture(existing, key, observedRaw);
      await requestResult(store.put(journal));
      return journal;
    },
  );
}

export async function readLegacyWorkspaceImport(
  accountId: string,
): Promise<LegacyWorkspaceImportJournal | null> {
  const key = workspaceKey(accountId);
  return runTransaction(
    LEGACY_IMPORT_CLAIM_STORE,
    "readonly",
    "read-legacy-workspace-import",
    async (store) => {
      const existing: unknown = await requestResult(store.get(key));
      return parseLegacyWorkspaceImportJournal(existing, key);
    },
  );
}

export async function commitLegacyWorkspaceImport(
  accountId: string,
): Promise<LegacyWorkspaceImportJournal> {
  const key = workspaceKey(accountId);
  return runTransaction(
    LEGACY_IMPORT_CLAIM_STORE,
    "readwrite",
    "commit-legacy-workspace-import",
    async (store) => {
      const existing: unknown = await requestResult(store.get(key));
      const journal = prepareLegacyWorkspaceImportCommit(existing, key);
      await requestResult(store.put(journal));
      return journal;
    },
  );
}

export async function disableLegacyWorkspaceImport(
  accountId: string,
): Promise<LegacyWorkspaceImportJournal> {
  const key = workspaceKey(accountId);
  return runTransaction(
    LEGACY_IMPORT_CLAIM_STORE,
    "readwrite",
    "disable-legacy-workspace-import",
    async (store) => {
      const existing: unknown = await requestResult(store.get(key));
      const journal = prepareLegacyWorkspaceImportDisable(existing, key);
      await requestResult(store.put(journal));
      return journal;
    },
  );
}

export async function listRawAccountErasureCheckpoints(): Promise<RawAccountErasureCheckpoint[]> {
  return runTransaction(
    ACCOUNT_ERASURE_STORE,
    "readonly",
    "list-account-erasure-checkpoints",
    async (store) => {
      const [keys, values] = await Promise.all([
        requestResult(store.getAllKeys()),
        requestResult(store.getAll()),
      ]);
      return keys.map((key, index) => ({ key, value: values[index] }));
    },
  );
}

export async function readRawAccountErasureCheckpoint(accountId: string): Promise<unknown | null> {
  const key = workspaceKey(accountId);
  return runTransaction(
    ACCOUNT_ERASURE_STORE,
    "readonly",
    "read-account-erasure-checkpoint",
    async (store) => {
      const value: unknown = await requestResult(store.get(key));
      return value === undefined ? null : value;
    },
  );
}

export async function mutateRawAccountErasureCheckpoint(
  accountId: string,
  mutate: (current: unknown | null) => Record<string, unknown> | null,
): Promise<unknown | null> {
  const key = workspaceKey(accountId);
  return runTransaction(
    ACCOUNT_ERASURE_STORE,
    "readwrite",
    "mutate-account-erasure-checkpoint",
    async (store) => {
      const raw: unknown = await requestResult(store.get(key));
      const next = mutate(raw === undefined ? null : raw);
      if (next === null) {
        await requestResult(store.delete(key));
        return null;
      }
      if (next.accountId !== key) {
        throw new PersistenceError(
          "invalid-data",
          "mutate-account-erasure-checkpoint",
          "The account-erasure checkpoint attempted to cross account scopes.",
        );
      }
      await requestResult(store.put(next));
      return next;
    },
  );
}

export async function deleteRawAccountErasureCheckpoint(key: IDBValidKey): Promise<void> {
  await runTransaction(
    ACCOUNT_ERASURE_STORE,
    "readwrite",
    "delete-account-erasure-checkpoint",
    async (store) => {
      await requestResult(store.delete(key));
    },
  );
}

/**
 * Decodes a raw IndexedDB value and, when necessary, restores the newest valid
 * undo snapshot. Recovery metadata is intentionally returned to the caller so
 * the replacement is never mistaken for an ordinary clean read.
 */
export function recoverWorkspaceEnvelope(
  value: unknown,
  expectedAccountId: string,
): WorkspaceEnvelope {
  const key = workspaceKey(expectedAccountId);
  if (!isRecord(value) || !hasWorkspaceMetadata(value) || value.accountId !== key) {
    throw new PersistenceError(
      "invalid-data",
      "read-workspace",
      "The stored workspace envelope is invalid or belongs to another account.",
    );
  }
  if (!Array.isArray(value.history)) {
    throw new PersistenceError(
      "invalid-data",
      "read-workspace",
      "The stored workspace has no readable undo history to inspect.",
    );
  }

  const localRevision = normalizedStoredLocalRevision(value.localRevision);
  if (localRevision === null) {
    throw new PersistenceError(
      "invalid-data",
      "read-workspace",
      "The stored workspace has an invalid browser-local revision.",
    );
  }

  if (
    isRecord(value.state)
    && typeof value.state.version === "number"
    && Number.isInteger(value.state.version)
    && value.state.version > CURRENT_STATE_VERSION
  ) {
    throw new PersistenceError(
      "invalid-data",
      "read-workspace",
      `The stored workspace uses version ${value.state.version}, which is newer than this app. Nothing was overwritten.`,
    );
  }

  const parsedCurrent = parseStoredState(value.state);
  const inspectedHistoryStart = Math.max(0, value.history.length - MAX_UNDO_HISTORY_ITEMS);
  let validHistory = value.history
    .slice(inspectedHistoryStart)
    .map((snapshot, index) => ({
      snapshot: parseStoredState(snapshot),
      index: inspectedHistoryStart + index,
      migrated: false,
      source: snapshot,
    }))
    .filter((item): item is {
      snapshot: AppState;
      index: number;
      migrated: boolean;
      source: unknown;
    } => Boolean(item.snapshot))
    .map((item) => ({
      ...item,
      migrated: !jsonValuesEqual(item.source, item.snapshot),
    }));
  const retainedHistoryCount = trimWorkspaceHistory(
    validHistory.map((item) => item.snapshot),
  ).length;
  validHistory = retainedHistoryCount === 0
    ? []
    : validHistory.slice(-retainedHistoryCount);
  const discardedHistoryEntries = value.history.length - validHistory.length;
  const currentMigrated = Boolean(parsedCurrent && !jsonValuesEqual(value.state, parsedCurrent));
  const migratedHistoryEntries = validHistory.filter((item) => item.migrated).length;

  const normalizedEnvelope = {
    accountId: key,
    state: parsedCurrent as AppState,
    history: validHistory.map((item) => item.snapshot),
    dirty: (value.dirty as boolean) || currentMigrated || migratedHistoryEntries > 0,
    localRevision,
    revision: value.revision as number,
    ...(value.serverUpdatedAt === undefined ? {} : { serverUpdatedAt: value.serverUpdatedAt as string }),
    savedAt: value.savedAt as string,
    ...(value.recovery === undefined ? {} : { recovery: value.recovery as WorkspaceRecovery }),
  } satisfies WorkspaceEnvelope;

  if (parsedCurrent) {
    if (discardedHistoryEntries === 0 && !currentMigrated && migratedHistoryEntries === 0) {
      return normalizedEnvelope;
    }
    const changes = [
      currentMigrated ? "the current snapshot was upgraded" : "",
      migratedHistoryEntries
        ? `${migratedHistoryEntries} undo ${migratedHistoryEntries === 1 ? "snapshot was" : "snapshots were"} upgraded`
        : "",
      discardedHistoryEntries
        ? `${discardedHistoryEntries} damaged undo ${discardedHistoryEntries === 1 ? "snapshot was" : "snapshots were"} removed`
        : "",
    ].filter(Boolean);
    return {
      ...normalizedEnvelope,
      recovery: {
        source: "current",
        discardedHistoryEntries,
        message: `Your device workspace was validated: ${changes.join("; ")}.`,
      },
    };
  }

  const newest = validHistory.at(-1);
  if (!newest) {
    throw new PersistenceError(
      "invalid-data",
      "read-workspace",
      "The current device workspace is damaged and no valid undo snapshot is available. Nothing was overwritten.",
    );
  }

  const earlierHistory = validHistory
    .filter((item) => item.index < newest.index)
    .map((item) => item.snapshot);
  const stateDate = newest.snapshot.updatedAt;
  return {
    accountId: key,
    state: newest.snapshot,
    history: earlierHistory,
    // A restored device snapshot must not overwrite private cloud data before
    // the account has reconciled and the user has seen the recovery notice.
    dirty: false,
    localRevision,
    revision: value.revision as number,
    ...(value.serverUpdatedAt === undefined ? {} : { serverUpdatedAt: value.serverUpdatedAt as string }),
    savedAt: value.savedAt as string,
    recovery: {
      source: "history",
      recoveredFromHistoryIndex: newest.index,
      discardedHistoryEntries: discardedHistoryEntries + 1,
      message: `The latest device workspace was damaged. Evolvra restored the newest valid undo snapshot from ${stateDate}; review it or export a backup before continuing.`,
    },
  };
}

export async function readWorkspaceWithScope(accountId: string): Promise<AccountWorkspaceRead> {
  const key = workspaceKey(accountId);
  return runStoresTransaction(
    [WORKSPACE_STORE, ACCOUNT_SCOPE_STORE],
    "readonly",
    "read-workspace-with-scope",
    async (transaction) => {
      const scope = await accountScopeFromStore(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
      );
      if (scope.tombstoned) return { workspace: null, scope };
      const value: unknown = await requestResult(
        transaction.objectStore(WORKSPACE_STORE).get(key),
      );
      return {
        workspace: value === undefined ? null : recoverWorkspaceEnvelope(value, key),
        scope,
      };
    },
  );
}

export async function readWorkspace(accountId: string): Promise<WorkspaceEnvelope | null> {
  return (await readWorkspaceWithScope(accountId)).workspace;
}

/** Read-only escape hatch for an explicit user-requested corruption export. */
export async function readRawWorkspace(accountId: string): Promise<unknown | null> {
  const key = workspaceKey(accountId);
  return runTransaction(WORKSPACE_STORE, "readonly", "read-raw-workspace", async (store) => {
    const value: unknown = await requestResult(store.get(key));
    return value === undefined ? null : value;
  });
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonValuesEqual(left[key], right[key]));
}

/** Compares persisted meaning, excluding CAS bookkeeping and write timestamps. */
export function workspaceEnvelopeContentsEqual(
  left: WorkspaceEnvelope,
  right: WorkspaceEnvelope,
): boolean {
  return left.accountId === right.accountId
    && left.dirty === right.dirty
    && left.revision === right.revision
    && left.serverUpdatedAt === right.serverUpdatedAt
    && jsonValuesEqual(left.state, right.state)
    && jsonValuesEqual(left.history, right.history);
}

export type WorkspaceWriteDecision =
  | { action: "no-op"; envelope: WorkspaceEnvelope }
  | { action: "write"; envelope: WorkspaceEnvelope };

/** Pure compare-and-swap decision used inside the IndexedDB transaction. */
export function prepareWorkspaceWrite(
  current: WorkspaceEnvelope | null,
  requested: WorkspaceEnvelope,
): WorkspaceWriteDecision {
  if (current && workspaceEnvelopeContentsEqual(current, requested)) {
    return { action: "no-op", envelope: current };
  }

  const actualLocalRevision = current?.localRevision ?? 0;
  if (actualLocalRevision !== requested.localRevision) {
    throw new LocalWorkspaceConflictError(
      requested.accountId,
      requested.localRevision,
      actualLocalRevision,
    );
  }
  if (actualLocalRevision === Number.MAX_SAFE_INTEGER) {
    throw new PersistenceError(
      "invalid-data",
      "write-workspace",
      "The browser-local workspace revision is exhausted. Export a backup before resetting local storage.",
    );
  }

  return {
    action: "write",
    envelope: {
      ...requested,
      localRevision: actualLocalRevision + 1,
    },
  };
}

function invalidWorkspaceEnvelopeReason(value: unknown): string {
  if (!isRecord(value)) return "the envelope is not an object";
  if (!hasWorkspaceMetadata(value) || !isLocalRevision(value.localRevision)) {
    return "the persistence metadata is invalid";
  }
  if (!Array.isArray(value.history)) return "undo history is not an array";
  if (value.history.length > MAX_UNDO_HISTORY_ITEMS) return "undo history exceeds the item limit";

  const stateIssue = (candidate: unknown) => {
    try {
      const parsed = parseImportedState(candidate);
      return jsonValuesEqual(candidate, parsed) ? null : "the state is not canonical";
    } catch (error) {
      return error instanceof Error ? error.message : "the state failed structural validation";
    }
  };
  const currentIssue = stateIssue(value.state);
  if (currentIssue) return `current state: ${currentIssue}`;
  for (let index = 0; index < value.history.length; index += 1) {
    const historyIssue = stateIssue(value.history[index]);
    if (historyIssue) return `undo history item ${index + 1}: ${historyIssue}`;
  }
  if (trimWorkspaceHistory(value.history as AppState[]).length !== value.history.length) {
    return "undo history exceeds the byte budget";
  }
  return "the envelope failed canonical validation";
}

/**
 * Atomically compares the caller's expected local revision and stores the next
 * revision. Identical content is a successful no-op even if another same-tab
 * write already advanced the local revision.
 */
export async function writeWorkspace(
  envelope: WorkspaceEnvelope,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<WorkspaceEnvelope> {
  if (!isWorkspaceEnvelope(envelope)) {
    throw new PersistenceError(
      "invalid-data",
      "write-workspace",
      `Refused to persist an invalid workspace envelope (${invalidWorkspaceEnvelopeReason(envelope)}).`,
    );
  }
  return runStoresTransaction(
    [WORKSPACE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "write-workspace",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        envelope.accountId,
        expectedGeneration,
      );
      const store = transaction.objectStore(WORKSPACE_STORE);
      const raw: unknown = await requestResult(store.get(envelope.accountId));
      const current = raw === undefined
        ? null
        : recoverWorkspaceEnvelope(raw, envelope.accountId);

      const decision = prepareWorkspaceWrite(current, envelope);
      if (decision.action === "no-op") return decision.envelope;

      const storedEnvelope = decision.envelope;
      delete storedEnvelope.recovery;
      await requestResult(store.put(storedEnvelope));
      return storedEnvelope;
    },
  );
}

/**
 * Replaces an unreadable saved envelope only after an explicit restore choice.
 * Unlike normal CAS writes, this path never attempts to decode the quarantined
 * value, but the replacement itself must still be a canonical current envelope.
 */
export async function replaceWorkspaceAfterRecoveryChoice(
  envelope: Omit<WorkspaceEnvelope, "localRevision">,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<WorkspaceEnvelope> {
  const requested: WorkspaceEnvelope = { ...envelope, localRevision: 0 };
  if (!isWorkspaceEnvelope(requested)) {
    throw new PersistenceError(
      "invalid-data",
      "replace-quarantined-workspace",
      "Refused to replace a quarantined workspace with an invalid envelope.",
    );
  }
  return runStoresTransaction(
    [WORKSPACE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "replace-quarantined-workspace",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        requested.accountId,
        expectedGeneration,
      );
      const store = transaction.objectStore(WORKSPACE_STORE);
      const raw: unknown = await requestResult(store.get(requested.accountId));
      const storedLocalRevision = isRecord(raw)
        ? normalizedStoredLocalRevision(raw.localRevision)
        : 0;
      const localRevision = storedLocalRevision ?? 0;
      if (localRevision === Number.MAX_SAFE_INTEGER) {
        throw new PersistenceError(
          "invalid-data",
          "replace-quarantined-workspace",
          "The browser-local workspace revision is exhausted. Erase the quarantined device copy before restoring a backup.",
        );
      }
      const storedEnvelope: WorkspaceEnvelope = {
        ...requested,
        localRevision: localRevision + 1,
      };
      delete storedEnvelope.recovery;
      await requestResult(store.put(storedEnvelope));
      return storedEnvelope;
    },
  );
}

export async function deleteWorkspace(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<void> {
  const key = workspaceKey(accountId);
  await runStoresTransaction(
    [WORKSPACE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "delete-workspace",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
        expectedGeneration,
      );
      await requestResult(transaction.objectStore(WORKSPACE_STORE).delete(key));
    },
  );
}

export async function storeEvidenceBlob(
  input: EvidenceBlobInput,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<EvidenceBlobRecord> {
  evidenceKey(input.accountId, input.goalId, input.evidenceId);
  const mimeType = normalizeEvidenceMimeType(input.blob.type);
  const blob = isAllowedEvidenceMimeType(mimeType) && input.blob.type !== mimeType
    ? input.blob.slice(0, input.blob.size, mimeType)
    : input.blob;
  const record: EvidenceBlobRecord = {
    accountId: input.accountId,
    goalId: input.goalId,
    evidenceId: input.evidenceId,
    blob,
    savedAt: input.savedAt ?? new Date().toISOString(),
  };
  if (!isEvidenceBlobRecord(record)) {
    throw new PersistenceError(
      "invalid-data",
      "store-evidence",
      "Refused to persist an invalid evidence blob record.",
    );
  }
  await runStoresTransaction(
    [EVIDENCE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "store-evidence",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        record.accountId,
        expectedGeneration,
      );
      await requestResult(transaction.objectStore(EVIDENCE_STORE).put(record));
    },
  );
  return record;
}

export async function readEvidenceBlob(
  accountId: string,
  goalId: string,
  evidenceId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<EvidenceBlobRecord | null> {
  const key = evidenceKey(accountId, goalId, evidenceId);
  return runStoresTransaction(
    [EVIDENCE_STORE, ACCOUNT_SCOPE_STORE],
    "readonly",
    "read-evidence",
    async (transaction) => {
    await requireWritableAccountScope(
      transaction.objectStore(ACCOUNT_SCOPE_STORE),
      key[0],
      expectedGeneration,
    );
    const value: unknown = await requestResult(
      transaction.objectStore(EVIDENCE_STORE).get(key),
    );
    if (value === undefined) return null;
    if (!isEvidenceBlobRecord(value)
      || value.accountId !== key[0]
      || value.goalId !== key[1]
      || value.evidenceId !== key[2]) {
      throw new PersistenceError(
        "invalid-data",
        "read-evidence",
        "The stored evidence record is invalid or belongs to another account or goal.",
      );
    }
    return value;
    },
  );
}

export function listEvidenceBlobs(
  accountId: string,
  goalId: string | undefined,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<EvidenceBlobRecord[]>;
export async function listEvidenceBlobs(
  accountId: string,
  goalId?: string,
  expectedGeneration?: PersistenceScopeGeneration,
): Promise<EvidenceBlobRecord[]> {
  const accountKey = workspaceKey(accountId);
  const goalKey = goalId === undefined ? undefined : requireId(goalId, "goalId");
  if (expectedGeneration === undefined) {
    throw new PersistenceError(
      "invalid-argument",
      "list-evidence",
      "The account persistence generation is required to list evidence.",
    );
  }
  return runStoresTransaction(
    [EVIDENCE_STORE, ACCOUNT_SCOPE_STORE],
    "readonly",
    "list-evidence",
    async (transaction) => {
    await requireWritableAccountScope(
      transaction.objectStore(ACCOUNT_SCOPE_STORE),
      accountKey,
      expectedGeneration,
    );
    const store = transaction.objectStore(EVIDENCE_STORE);
    const index = goalKey === undefined
      ? store.index(EVIDENCE_ACCOUNT_INDEX)
      : store.index(EVIDENCE_ACCOUNT_GOAL_INDEX);
    const query: IDBValidKey = goalKey === undefined ? accountKey : [accountKey, goalKey];
    const values: unknown[] = await requestResult(index.getAll(query));
    if (!values.every(isEvidenceBlobRecord)) {
      throw new PersistenceError(
        "invalid-data",
        "list-evidence",
        "One or more stored evidence records are invalid.",
      );
    }
    const records = values as EvidenceBlobRecord[];
    if (records.some((record) => record.accountId !== accountKey
      || (goalKey !== undefined && record.goalId !== goalKey))) {
      throw new PersistenceError(
        "invalid-data",
        "list-evidence",
        "IndexedDB returned evidence outside the requested account scope.",
      );
    }
    return records.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    },
  );
}

export async function deleteEvidenceBlob(
  accountId: string,
  goalId: string,
  evidenceId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<void> {
  const key = evidenceKey(accountId, goalId, evidenceId);
  await runStoresTransaction(
    [EVIDENCE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "delete-evidence",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key[0],
        expectedGeneration,
      );
      await requestResult(transaction.objectStore(EVIDENCE_STORE).delete(key));
    },
  );
}

function deleteEvidenceCursor(index: IDBIndex, accountId: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let deleted = 0;
    const request = index.openCursor(IDBKeyRange.only(accountId));
    request.onerror = () => reject(request.error ?? new Error("Could not enumerate evidence."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(deleted);
        return;
      }
      const deletion = cursor.delete();
      deletion.onerror = () => reject(deletion.error ?? new Error("Could not delete evidence."));
      deletion.onsuccess = () => {
        deleted += 1;
        cursor.continue();
      };
    };
  });
}

export async function deleteAllAccountEvidence(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<number> {
  const key = workspaceKey(accountId);
  return runStoresTransaction(
    [EVIDENCE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "delete-account-evidence",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
        expectedGeneration,
      );
      return deleteEvidenceCursor(
        transaction.objectStore(EVIDENCE_STORE).index(EVIDENCE_ACCOUNT_INDEX),
        key,
      );
    },
  );
}

/**
 * Atomically rotates an active account generation and erases all device-only
 * data. Rotation makes already-open tabs stale even when this is not erasure.
 */
export async function deleteAccountPersistence(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<AccountPersistenceEraseResult> {
  const key = workspaceKey(accountId);
  const expected = requireScopeGeneration(expectedGeneration);
  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, ACCOUNT_SCOPE_STORE, ACCOUNT_REMINDER_STORE],
    "readwrite",
    "delete-account-persistence",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const current = await requireWritableAccountScope(scopeStore, key, expected);
      if (current.generation === Number.MAX_SAFE_INTEGER) {
        throw new PersistenceError(
          "invalid-data",
          "delete-account-persistence",
          "The account persistence generation is exhausted.",
        );
      }
      const scope: AccountPersistenceScope = {
        accountId: key,
        generation: current.generation + 1,
        tombstoned: false,
        updatedAt: new Date().toISOString(),
      };
      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
      const [, deletedEvidence] = await Promise.all([
        requestResult(transaction.objectStore(WORKSPACE_STORE).delete(key)),
        deleteEvidenceCursor(evidenceStore.index(EVIDENCE_ACCOUNT_INDEX), key),
        requestResult(transaction.objectStore(ACCOUNT_REMINDER_STORE).delete(key)),
      ]);
      await requestResult(scopeStore.put(scope));
      return { deletedEvidence, scope };
    },
  );
}

/**
 * Erases an account behind its permanent erasure tombstone. This is idempotent
 * and deliberately does not clear or rotate the tombstone.
 */
export async function eraseAccountPersistenceWithTombstone(
  accountId: string,
  tombstonedGeneration: PersistenceScopeGeneration,
): Promise<AccountPersistenceEraseResult> {
  const key = workspaceKey(accountId);
  const expected = requireScopeGeneration(tombstonedGeneration);
  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, ACCOUNT_SCOPE_STORE, ACCOUNT_REMINDER_STORE],
    "readwrite",
    "erase-tombstoned-account-persistence",
    async (transaction) => {
      const scope = await accountScopeFromStore(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
      );
      if (!scope.tombstoned || scope.generation !== expected) {
        throw new AccountPersistenceScopeError(
          key,
          expected,
          scope.generation,
          scope.tombstoned,
        );
      }
      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
      const [, deletedEvidence] = await Promise.all([
        requestResult(transaction.objectStore(WORKSPACE_STORE).delete(key)),
        deleteEvidenceCursor(evidenceStore.index(EVIDENCE_ACCOUNT_INDEX), key),
        requestResult(transaction.objectStore(ACCOUNT_REMINDER_STORE).delete(key)),
      ]);
      return { deletedEvidence, scope };
    },
  );
}

export const indexedDbPersistence = {
  isAvailable: hasIndexedDbSupport,
  readAccountPersistenceScope,
  listTombstonedAccountPersistenceScopes,
  readWorkspaceWithScope,
  readAccountReminderDate,
  writeAccountReminderDate,
  captureLegacyWorkspaceImport,
  readLegacyWorkspaceImport,
  commitLegacyWorkspaceImport,
  disableLegacyWorkspaceImport,
  recoverOrphanedAccountErasurePersistenceFence,
  readWorkspace,
  readRawWorkspace,
  writeWorkspace,
  replaceWorkspaceAfterRecoveryChoice,
  deleteWorkspace,
  storeEvidenceBlob,
  readEvidenceBlob,
  listEvidenceBlobs,
  deleteEvidenceBlob,
  deleteAllAccountEvidence,
  deleteAccountPersistence,
  eraseAccountPersistenceWithTombstone,
};
