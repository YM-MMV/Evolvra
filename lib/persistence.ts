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
// Version 4 separates uncommitted evidence bytes from the live evidence store.
// Opening v4 also fences older bundles that could expose migration bytes before
// their referencing workspace CAS committed.
export const PERSISTENCE_DATABASE_VERSION = 4;
export const LEGACY_WORKSPACE_STORAGE_KEY = "evolvra:workspace:v1";

const WORKSPACE_STORE = "workspaces";
const EVIDENCE_STORE = "evidence";
const EVIDENCE_STAGING_STORE = "evidence-staging";
const ACCOUNT_SCOPE_STORE = "account-scopes";
const ACCOUNT_ERASURE_STORE = "account-erasure-checkpoints";
const ACCOUNT_REMINDER_STORE = "account-reminders";
const LEGACY_IMPORT_CLAIM_STORE = "legacy-import-claims";
const EVIDENCE_ACCOUNT_INDEX = "by-account";
const EVIDENCE_ACCOUNT_GOAL_INDEX = "by-account-goal";
const EVIDENCE_STAGING_ACCOUNT_INDEX = "by-account";

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
  /** Exact anonymous device revision this account has already handled. */
  anonymousHandoff?: AnonymousWorkspaceHandoffAcknowledgement;
  /** Transient read metadata. New writes should omit this after surfacing it to the user. */
  recovery?: WorkspaceRecovery;
}

export interface AnonymousWorkspaceHandoffAcknowledgement {
  generation: PersistenceScopeGeneration;
  localRevision: number;
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
  /** Present on every v4 live record and used by compare-delete. */
  writeId?: string;
}

export interface EvidenceBlobInput {
  accountId: string;
  goalId: string;
  evidenceId: string;
  blob: Blob;
  savedAt?: string;
}

export interface StoredEvidenceBytesRecord {
  accountId: string;
  goalId: string;
  evidenceId: string;
  bytes: ArrayBuffer;
  mimeType: string;
  savedAt: string;
  /** Opaque identity freshly assigned to every live write. */
  writeId?: string;
}

interface StoredStagedEvidenceBytesRecord extends Omit<StoredEvidenceBytesRecord, "writeId"> {
  token: string;
  stagedAt: string;
}

export interface StagedEvidenceBlobWrite {
  readonly token: string;
  readonly record: EvidenceBlobRecord;
}

export interface EvidenceCleanupIntentInput {
  readonly accountId: string;
  readonly goalId: string;
  readonly evidenceId: string;
  readonly expectedWriteId?: string;
  readonly remotePath?: string;
}

/**
 * Durable deletion provenance. It is stored beside staging tokens, never in
 * the live evidence store, and is written before metadata can drop the last
 * reference. Recovery therefore distinguishes an intentional orphan from
 * unrelated unreferenced bytes.
 */
export interface EvidenceCleanupIntent extends EvidenceCleanupIntentInput {
  readonly kind: "cleanup";
  readonly token: string;
  readonly createdAt: string;
}

export type EvidenceBlobRollbackResult = "rolled-back" | "already-absent";
export interface EvidenceBlobDeletionReceipt {
  readonly accountId: string;
  readonly generation: PersistenceScopeGeneration;
  readonly workspaceLocalRevision: number;
  readonly evidenceRevisionAfterDelete: number;
  readonly snapshots: readonly EvidenceBlobRecord[];
}

export type EvidenceBlobDeleteResult =
  | { readonly kind: "deleted"; readonly receipt: EvidenceBlobDeletionReceipt }
  | { readonly kind: "superseded" };

export type PersistenceScopeGeneration = number;

export interface WorkspaceWriteOptions {
  /**
   * Removes every account-scoped live evidence row that is not referenced by
   * the committed current state or undo history. The sweep runs in the same
   * generation-fenced transaction as the workspace CAS, so a late writer is
   * either observed and removed or rejected by the advanced local revision.
   */
  readonly removeUnreferencedEvidence?: boolean;
}

export interface AccountPersistenceScope {
  accountId: string;
  generation: PersistenceScopeGeneration;
  /** Monotonic revision for all committed live evidence mutations. */
  evidenceRevision: number;
  tombstoned: boolean;
  updatedAt: string;
}

export interface AccountPersistenceBackupBoundary {
  accountId: string;
  generation: PersistenceScopeGeneration;
  workspaceLocalRevision: number;
  evidenceRevision: number;
}

export interface AccountWorkspaceRead {
  workspace: WorkspaceEnvelope | null;
  scope: AccountPersistenceScope;
}

export interface AccountPersistenceEraseResult {
  deletedEvidence: number;
  scope: AccountPersistenceScope;
}

export type PortableArchivePersistenceKind = "merge" | "replace";

export interface PortableArchivePersistenceInput {
  envelope: WorkspaceEnvelope;
  evidence: readonly EvidenceBlobRecord[];
  stagedEvidence?: readonly StagedEvidenceBlobWrite[];
  kind: PortableArchivePersistenceKind;
}

export interface PortableArchivePersistenceResult {
  envelope: WorkspaceEnvelope;
  removedSupersededEvidence: number;
}

export type AccountHandoffEvidenceCollisionPolicy =
  | "reject-existing"
  | "replace-inspected-workspace";

export interface AccountHandoffPersistenceInput {
  envelope: WorkspaceEnvelope;
  evidence: readonly EvidenceBlobRecord[];
  stagedEvidence?: readonly StagedEvidenceBlobWrite[];
  collisionPolicy: AccountHandoffEvidenceCollisionPolicy;
  /** Explicitly permits replacing the exact quarantined revision inspected by the caller. */
  replaceQuarantinedWorkspace: boolean;
}

export interface AccountHandoffPersistenceResult {
  envelope: WorkspaceEnvelope;
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

function isAnonymousWorkspaceHandoffAcknowledgement(
  value: unknown,
): value is AnonymousWorkspaceHandoffAcknowledgement {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.generation)
    && Number(value.generation) >= 0
    && isLocalRevision(value.localRevision);
}

function hasWorkspaceMetadata(value: UnknownRecord): boolean {
  return isPersistenceId(value.accountId)
    && typeof value.dirty === "boolean"
    && normalizedStoredLocalRevision(value.localRevision) !== null
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) >= 0
    && (value.serverUpdatedAt === undefined || isIsoDate(value.serverUpdatedAt))
    && isIsoDate(value.savedAt)
    && (value.anonymousHandoff === undefined
      || isAnonymousWorkspaceHandoffAcknowledgement(value.anonymousHandoff))
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
    && isIsoDate(value.savedAt)
    && (value.writeId === undefined || isPersistenceId(value.writeId));
}

function isEvidenceCleanupIntent(value: unknown): value is EvidenceCleanupIntent {
  if (!isRecord(value)) return false;
  return value.kind === "cleanup"
    && isPersistenceId(value.token)
    && isPersistenceId(value.accountId)
    && isPersistenceId(value.goalId)
    && isPersistenceId(value.evidenceId)
    && isIsoDate(value.createdAt)
    && (value.expectedWriteId === undefined || isPersistenceId(value.expectedWriteId))
    && (value.remotePath === undefined
      || (typeof value.remotePath === "string"
        && value.remotePath.length > 0
        && value.remotePath.length <= 1_024))
    && (value.expectedWriteId !== undefined || value.remotePath !== undefined);
}

function cleanupIntentContentsEqual(
  left: EvidenceCleanupIntent,
  right: EvidenceCleanupIntent,
): boolean {
  return left.kind === right.kind
    && left.token === right.token
    && left.accountId === right.accountId
    && left.goalId === right.goalId
    && left.evidenceId === right.evidenceId
    && left.createdAt === right.createdAt
    && left.expectedWriteId === right.expectedWriteId
    && left.remotePath === right.remotePath;
}

/**
 * IndexedDB Blob persistence is not interoperable in every supported WebKit
 * runtime. Store portable bytes plus an allow-listed media type and recreate a
 * Blob at the repository boundary. Legacy Blob records remain readable.
 */
export async function serializeEvidenceBlobRecord(
  record: EvidenceBlobRecord,
): Promise<StoredEvidenceBytesRecord> {
  if (!isEvidenceBlobRecord(record)) {
    throw new PersistenceError(
      "invalid-data",
      "serialize-evidence",
      "Refused to serialize an invalid evidence blob record.",
    );
  }
  const bytes = await record.blob.arrayBuffer();
  if (bytes.byteLength !== record.blob.size) {
    throw new PersistenceError(
      "invalid-data",
      "serialize-evidence",
      "The evidence bytes changed while they were being prepared for device storage.",
    );
  }
  return {
    accountId: record.accountId,
    goalId: record.goalId,
    evidenceId: record.evidenceId,
    bytes,
    mimeType: normalizeEvidenceMimeType(record.blob.type),
    savedAt: record.savedAt,
  };
}

export function recoverEvidenceBlobRecord(
  value: unknown,
): EvidenceBlobRecord | null {
  if (isEvidenceBlobRecord(value)) return value;
  if (
    !isRecord(value)
    || !isPersistenceId(value.accountId)
    || !isPersistenceId(value.goalId)
    || !isPersistenceId(value.evidenceId)
    || !(value.bytes instanceof ArrayBuffer)
    || !isAllowedEvidenceMimeType(value.mimeType)
    || !isValidEvidenceFileSize(value.bytes.byteLength)
    || !isIsoDate(value.savedAt)
  ) return null;
  try {
    const record: EvidenceBlobRecord = {
      accountId: value.accountId,
      goalId: value.goalId,
      evidenceId: value.evidenceId,
      blob: new Blob([value.bytes], { type: value.mimeType }),
      savedAt: value.savedAt,
      ...(isPersistenceId(value.writeId) ? { writeId: value.writeId } : {}),
    };
    return isEvidenceBlobRecord(record) ? record : null;
  } catch {
    return null;
  }
}

function arrayBuffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

function storedEvidenceBytesEqual(value: unknown, expected: StoredEvidenceBytesRecord): boolean {
  return isRecord(value)
    && value.accountId === expected.accountId
    && value.goalId === expected.goalId
    && value.evidenceId === expected.evidenceId
    && value.mimeType === expected.mimeType
    && value.bytes instanceof ArrayBuffer
    && arrayBuffersEqual(value.bytes, expected.bytes);
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

  // Every v4 live value has an ownership identity. This cursor is part of the
  // upgrade transaction, so no v4 reader can observe a legacy value between
  // its validation and rewrite.
  const rewrite = evidence.openCursor();
  rewrite.onsuccess = () => {
    const cursor = rewrite.result;
    if (!cursor) return;
    const value = cursor.value;
    if (isRecord(value) && !isPersistenceId(value.writeId)) {
      cursor.update({ ...value, writeId: globalThis.crypto.randomUUID() });
    }
    cursor.continue();
  };

  const staging = database.objectStoreNames.contains(EVIDENCE_STAGING_STORE)
    ? transaction.objectStore(EVIDENCE_STAGING_STORE)
    : database.createObjectStore(EVIDENCE_STAGING_STORE, { keyPath: "token" });
  if (!staging.indexNames.contains(EVIDENCE_STAGING_ACCOUNT_INDEX)) {
    staging.createIndex(EVIDENCE_STAGING_ACCOUNT_INDEX, "accountId", { unique: false });
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
    evidenceRevision: 0,
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
    || (value.evidenceRevision !== undefined
      && (!Number.isSafeInteger(value.evidenceRevision)
        || Number(value.evidenceRevision) < 0))
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
    evidenceRevision: value.evidenceRevision === undefined
      ? 0
      : Number(value.evidenceRevision),
    tombstoned: value.tombstoned,
    updatedAt: value.updatedAt,
  };
}

function nextEvidenceRevision(
  scope: AccountPersistenceScope,
  operation: string,
): AccountPersistenceScope {
  if (scope.evidenceRevision === Number.MAX_SAFE_INTEGER) {
    throw new PersistenceError(
      "invalid-data",
      operation,
      "The browser-local evidence revision is exhausted. Export a backup before resetting local storage.",
    );
  }
  return {
    ...scope,
    evidenceRevision: scope.evidenceRevision + 1,
    updatedAt: new Date().toISOString(),
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

/** Captures every browser-local backup fence coordinate in one transaction. */
export async function readAccountPersistenceBackupBoundary(
  accountId: string,
): Promise<AccountPersistenceBackupBoundary> {
  const key = workspaceKey(accountId);
  return runStoresTransaction(
    [WORKSPACE_STORE, ACCOUNT_SCOPE_STORE],
    "readonly",
    "read-account-backup-boundary",
    async (transaction) => {
      const scope = await accountScopeFromStore(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
      );
      const raw: unknown = await requestResult(
        transaction.objectStore(WORKSPACE_STORE).get(key),
      );
      return {
        accountId: key,
        generation: scope.generation,
        workspaceLocalRevision: persistedWorkspaceLocalRevision(raw, key),
        evidenceRevision: scope.evidenceRevision,
      };
    },
  );
}

function requireAccountPersistenceBackupBoundary(
  rawWorkspace: unknown,
  scope: AccountPersistenceScope,
  expected: AccountPersistenceBackupBoundary,
  operation: string,
): void {
  if (
    expected.accountId !== scope.accountId
    || !isLocalRevision(expected.generation)
    || !isLocalRevision(expected.workspaceLocalRevision)
    || !isLocalRevision(expected.evidenceRevision)
  ) {
    throw new PersistenceError(
      "invalid-argument",
      operation,
      "The browser-local backup boundary is invalid or belongs to another account.",
    );
  }
  if (scope.generation !== expected.generation) {
    throw new AccountPersistenceScopeError(
      scope.accountId,
      expected.generation,
      scope.generation,
      scope.tombstoned,
    );
  }
  requireExactWorkspaceLocalRevision(
    rawWorkspace,
    scope.accountId,
    expected.workspaceLocalRevision,
  );
  if (scope.evidenceRevision !== expected.evidenceRevision) {
    throw new PersistenceError(
      "local-conflict",
      operation,
      "Device evidence changed after the backup was captured.",
    );
  }
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

/**
 * Validates the exact device revision covered by an account-erasure backup.
 * This is called from the same read/write transaction that creates the
 * tombstone and durable checkpoint, so a competing tab cannot slip a save
 * between the comparison and the fence.
 */
export function requireAccountErasureWorkspaceRevision(
  rawWorkspace: unknown,
  accountId: string,
  expectedLocalRevision: number,
): number {
  const key = workspaceKey(accountId);
  if (!isLocalRevision(expectedLocalRevision)) {
    throw new PersistenceError(
      "invalid-argument",
      "begin-account-erasure-fence",
      "The expected browser-local workspace revision must be a non-negative safe integer.",
    );
  }
  const actualLocalRevision = rawWorkspace === undefined
    ? 0
    : recoverWorkspaceEnvelope(rawWorkspace, key).localRevision;
  if (actualLocalRevision !== expectedLocalRevision) {
    throw new LocalWorkspaceConflictError(
      key,
      expectedLocalRevision,
      actualLocalRevision,
    );
  }
  return actualLocalRevision;
}

export async function beginAccountErasurePersistenceFence(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
  checkpoint: Record<string, unknown>,
  options: {
    expectedLocalRevision?: number;
    expectedBackupBoundary?: AccountPersistenceBackupBoundary;
  } = {},
): Promise<{ scope: AccountPersistenceScope; checkpoint: unknown }> {
  const key = workspaceKey(accountId);
  const expected = requireScopeGeneration(expectedGeneration);
  const expectedLocalRevision = options.expectedLocalRevision;
  const expectedBackupBoundary = options.expectedBackupBoundary;
  if (
    expectedLocalRevision !== undefined
    && !isLocalRevision(expectedLocalRevision)
  ) {
    throw new PersistenceError(
      "invalid-argument",
      "begin-account-erasure-fence",
      "The expected browser-local workspace revision must be a non-negative safe integer.",
    );
  }
  if (
    expectedBackupBoundary !== undefined
    && expectedBackupBoundary.accountId !== key
  ) {
    throw new PersistenceError(
      "invalid-argument",
      "begin-account-erasure-fence",
      "The browser-local backup boundary belongs to another account.",
    );
  }
  if (checkpoint.accountId !== key) {
    throw new PersistenceError(
      "invalid-data",
      "begin-account-erasure-fence",
      "The account-erasure intent did not match the persistence scope.",
    );
  }
  return runStoresTransaction(
    [
      WORKSPACE_STORE,
      ACCOUNT_SCOPE_STORE,
      ACCOUNT_ERASURE_STORE,
      ACCOUNT_REMINDER_STORE,
    ],
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
      if (expectedBackupBoundary !== undefined) {
        const rawWorkspace: unknown = await requestResult(
          transaction.objectStore(WORKSPACE_STORE).get(key),
        );
        requireAccountPersistenceBackupBoundary(
          rawWorkspace,
          current,
          expectedBackupBoundary,
          "begin-account-erasure-fence",
        );
      } else if (expectedLocalRevision !== undefined) {
        const rawWorkspace: unknown = await requestResult(
          transaction.objectStore(WORKSPACE_STORE).get(key),
        );
        requireAccountErasureWorkspaceRevision(
          rawWorkspace,
          key,
          expectedLocalRevision,
        );
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
          evidenceRevision: current.evidenceRevision,
          tombstoned: true,
          updatedAt: new Date().toISOString(),
        };
        await requestResult(scopeStore.put(next));
      }
      const storedCheckpoint = { ...checkpoint, persistenceGeneration: next.generation };
      await requestResult(checkpointStore.add(storedCheckpoint));
      return { scope: next, checkpoint: storedCheckpoint };
    },
  );
}

/**
 * Cancels only an erasure attempt that the cloud definitively refused before
 * entering its deleting lifecycle. Workspace, evidence, and reminder data are
 * preserved. Rotating the generation invalidates every writer admitted before
 * the failed tombstone without ever making that old generation writable again.
 */
export async function cancelUnstartedAccountErasurePersistenceFence(
  accountId: string,
  tombstonedGeneration: PersistenceScopeGeneration,
  attemptId: string,
): Promise<AccountPersistenceScope> {
  const key = workspaceKey(accountId);
  const expected = requireScopeGeneration(tombstonedGeneration);
  const attempt = requireId(attemptId, "attemptId");
  return runStoresTransaction(
    [ACCOUNT_SCOPE_STORE, ACCOUNT_ERASURE_STORE],
    "readwrite",
    "cancel-unstarted-account-erasure-fence",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const current = await accountScopeFromStore(scopeStore, key);
      if (!current.tombstoned || current.generation !== expected) {
        throw new AccountPersistenceScopeError(
          key,
          expected,
          current.generation,
          current.tombstoned,
        );
      }
      const checkpointStore = transaction.objectStore(ACCOUNT_ERASURE_STORE);
      const raw: unknown = await requestResult(checkpointStore.get(key));
      if (
        !isRecord(raw)
        || raw.accountId !== key
        || raw.attemptId !== attempt
        || (raw.cloud !== "pending" && raw.cloud !== "failed")
        || raw.local !== "pending"
        || raw.session !== "pending"
        || raw.persistenceGeneration !== expected
      ) {
        throw new PersistenceError(
          "invalid-data",
          "cancel-unstarted-account-erasure-fence",
          "Only the exact unstarted account-erasure checkpoint can be cancelled.",
        );
      }
      if (current.generation === Number.MAX_SAFE_INTEGER) {
        throw new PersistenceError(
          "invalid-data",
          "cancel-unstarted-account-erasure-fence",
          "The account persistence generation is exhausted.",
        );
      }
      const restored: AccountPersistenceScope = {
        accountId: key,
        generation: current.generation + 1,
        evidenceRevision: current.evidenceRevision,
        tombstoned: false,
        updatedAt: new Date().toISOString(),
      };
      await requestResult(scopeStore.put(restored));
      await requestResult(checkpointStore.delete(key));
      return restored;
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
    ...(value.anonymousHandoff === undefined
      ? {}
      : { anonymousHandoff: value.anonymousHandoff as AnonymousWorkspaceHandoffAcknowledgement }),
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
    && jsonValuesEqual(left.anonymousHandoff, right.anonymousHandoff)
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
  const effectiveRequested = current?.anonymousHandoff && !requested.anonymousHandoff
    ? { ...requested, anonymousHandoff: current.anonymousHandoff }
    : requested;
  if (current && workspaceEnvelopeContentsEqual(current, effectiveRequested)) {
    return { action: "no-op", envelope: current };
  }

  const actualLocalRevision = current?.localRevision ?? 0;
  if (actualLocalRevision !== effectiveRequested.localRevision) {
    throw new LocalWorkspaceConflictError(
      effectiveRequested.accountId,
      effectiveRequested.localRevision,
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
      ...effectiveRequested,
      localRevision: actualLocalRevision + 1,
    },
  };
}

/**
 * Portable archive import always advances the exact revision it inspected.
 * Unlike ordinary autosave, identical content is not a no-op: the evidence
 * mutation belongs to the same strict compare-and-swap transaction.
 */
export function preparePortableArchiveWorkspaceWrite(
  current: WorkspaceEnvelope | null,
  requested: WorkspaceEnvelope,
): WorkspaceEnvelope {
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
      "import-portable-archive",
      "The browser-local workspace revision is exhausted. Export a fresh backup before resetting local storage.",
    );
  }
  return {
    ...requested,
    ...(current?.anonymousHandoff && !requested.anonymousHandoff
      ? { anonymousHandoff: current.anonymousHandoff }
      : {}),
    localRevision: actualLocalRevision + 1,
  };
}

/**
 * Reads the only CAS value that can be trusted from a quarantined envelope.
 * Malformed or missing legacy values use the pre-CAS revision zero, matching
 * the explicit recovery replacement path.
 */
export function quarantinedWorkspaceLocalRevision(value: unknown): number {
  if (!isRecord(value)) return 0;
  return normalizedStoredLocalRevision(value.localRevision) ?? 0;
}

function prepareQuarantinedAccountHandoffWorkspaceWrite(
  raw: unknown,
  requested: WorkspaceEnvelope,
): WorkspaceEnvelope {
  const actualLocalRevision = quarantinedWorkspaceLocalRevision(raw);
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
      "commit-account-handoff",
      "The browser-local workspace revision is exhausted. Erase the quarantined device copy before replacing it.",
    );
  }
  return {
    ...requested,
    localRevision: actualLocalRevision + 1,
  };
}

function validatedAccountHandoffEvidence(
  input: AccountHandoffPersistenceInput,
): EvidenceBlobRecord[] {
  const records = [...input.evidence];
  const keys = new Set<string>();
  for (const record of records) {
    if (!isEvidenceBlobRecord(record) || record.accountId !== input.envelope.accountId) {
      throw new PersistenceError(
        "invalid-data",
        "commit-account-handoff",
        "Account handoff evidence is invalid or belongs to another account.",
      );
    }
    const key = JSON.stringify(evidenceKey(
      record.accountId,
      record.goalId,
      record.evidenceId,
    ));
    if (keys.has(key)) {
      throw new PersistenceError(
        "invalid-data",
        "commit-account-handoff",
        "Account handoff evidence contains a duplicate target key.",
      );
    }
    keys.add(key);
  }
  return records;
}

/**
 * Commits an anonymous-to-account handoff as one IndexedDB transaction.
 *
 * The workspace CAS is evaluated before evidence collisions or writes. Since
 * IndexedDB serialises overlapping readwrite transactions across tabs, a tab
 * that commits the inspected target first advances its workspace revision and
 * makes this whole transaction abort. No compensation then touches that tab's
 * evidence. Replacement semantics therefore apply only to the exact workspace
 * revision the user inspected.
 */
export async function applyAccountHandoffPersistence(
  input: AccountHandoffPersistenceInput,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<AccountHandoffPersistenceResult> {
  if (
    input.collisionPolicy !== "reject-existing"
    && input.collisionPolicy !== "replace-inspected-workspace"
  ) {
    throw new PersistenceError(
      "invalid-argument",
      "commit-account-handoff",
      "Account handoff requires an explicit evidence collision policy.",
    );
  }
  if (!isWorkspaceEnvelope(input.envelope)) {
    throw new PersistenceError(
      "invalid-data",
      "commit-account-handoff",
      `Refused to persist an invalid account handoff workspace envelope (${invalidWorkspaceEnvelopeReason(input.envelope)}).`,
    );
  }
  const records = validatedAccountHandoffEvidence(input);
  const storedRecords = await Promise.all(records.map(serializeEvidenceBlobRecord));
  const preparedEvidence = await preparedStagedEvidenceWrites(
    input.stagedEvidence ?? [],
    input.envelope.accountId,
  );

  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "commit-account-handoff",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
        input.envelope.accountId,
        expectedGeneration,
      );
      const workspaceStore = transaction.objectStore(WORKSPACE_STORE);
      const raw: unknown = await requestResult(
        workspaceStore.get(input.envelope.accountId),
      );

      let storedEnvelope: WorkspaceEnvelope;
      if (raw === undefined) {
        storedEnvelope = preparePortableArchiveWorkspaceWrite(null, input.envelope);
      } else {
        try {
          storedEnvelope = preparePortableArchiveWorkspaceWrite(
            recoverWorkspaceEnvelope(raw, input.envelope.accountId),
            input.envelope,
          );
        } catch (error) {
          if (
            !input.replaceQuarantinedWorkspace
            || !(error instanceof PersistenceError)
            || error.code !== "invalid-data"
          ) {
            throw error;
          }
          storedEnvelope = prepareQuarantinedAccountHandoffWorkspaceWrite(
            raw,
            input.envelope,
          );
        }
      }
      delete storedEnvelope.recovery;

      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
      let removedSupersededEvidence = 0;
      if (input.collisionPolicy === "reject-existing") {
        for (const record of records) {
          const existing = await requestResult(evidenceStore.get(evidenceKey(
            record.accountId,
            record.goalId,
            record.evidenceId,
          )));
          if (existing !== undefined) {
            throw new PersistenceError(
              "local-conflict",
              "commit-account-handoff",
              "Anonymous evidence would overwrite a file committed to the account workspace.",
            );
          }
        }
      } else {
        const retainedKeys = workspaceEvidenceReferences(storedEnvelope).keys;
        const index = evidenceStore.index(EVIDENCE_ACCOUNT_INDEX);
        await new Promise<void>((resolve, reject) => {
          const request = index.openCursor(IDBKeyRange.only(input.envelope.accountId));
          request.onerror = () => reject(
            request.error ?? new Error("Could not inspect superseded account evidence."),
          );
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve();
              return;
            }
            const encodedKey = Array.isArray(cursor.primaryKey)
              ? JSON.stringify(cursor.primaryKey)
              : "";
            if (retainedKeys.has(encodedKey)) {
              cursor.continue();
              return;
            }
            const deletion = cursor.delete();
            deletion.onerror = () => reject(
              deletion.error ?? new Error("Could not remove superseded account evidence."),
            );
            deletion.onsuccess = () => {
              removedSupersededEvidence += 1;
              cursor.continue();
            };
          };
        });
      }

      const promotedEvidence = await promotePreparedStagedEvidence(
        transaction,
        preparedEvidence,
      );
      for (const record of storedRecords) {
        await requestResult(evidenceStore.put({
          ...record,
          writeId: globalThis.crypto.randomUUID(),
        } satisfies StoredEvidenceBytesRecord));
      }
      await requestResult(workspaceStore.put(storedEnvelope));
      if (promotedEvidence || storedRecords.length || removedSupersededEvidence) {
        await requestResult(scopeStore.put(
          nextEvidenceRevision(scope, "commit-account-handoff"),
        ));
      }
      return { envelope: storedEnvelope };
    },
  );
}

function validatedPortableArchiveEvidence(
  input: PortableArchivePersistenceInput,
): EvidenceBlobRecord[] {
  const records = [...input.evidence];
  const keys = new Set<string>();
  for (const record of records) {
    if (!isEvidenceBlobRecord(record) || record.accountId !== input.envelope.accountId) {
      throw new PersistenceError(
        "invalid-data",
        "import-portable-archive",
        "Portable archive evidence is invalid or belongs to another account.",
      );
    }
    const key = JSON.stringify(evidenceKey(
      record.accountId,
      record.goalId,
      record.evidenceId,
    ));
    if (keys.has(key)) {
      throw new PersistenceError(
        "invalid-data",
        "import-portable-archive",
        "Portable archive evidence contains a duplicate target key.",
      );
    }
    keys.add(key);
  }
  return records;
}

/**
 * Commits workspace CAS, evidence collision checks/writes, and replace cleanup
 * in one IndexedDB transaction. IndexedDB serialises overlapping readwrite
 * transactions across tabs, so an abort exposes neither staged bytes nor
 * cleanup and can never compensate over another tab's committed evidence.
 */
export async function applyPortableArchivePersistence(
  input: PortableArchivePersistenceInput,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<PortableArchivePersistenceResult> {
  if (input.kind !== "merge" && input.kind !== "replace") {
    throw new PersistenceError(
      "invalid-argument",
      "import-portable-archive",
      "Portable archive import requires an explicit merge or replace choice.",
    );
  }
  if (!isWorkspaceEnvelope(input.envelope)) {
    throw new PersistenceError(
      "invalid-data",
      "import-portable-archive",
      "Refused to persist an invalid portable archive workspace envelope.",
    );
  }
  const records = validatedPortableArchiveEvidence(input);
  const storedRecords = await Promise.all(
    records.map(serializeEvidenceBlobRecord),
  );
  const preparedEvidence = await preparedStagedEvidenceWrites(
    input.stagedEvidence ?? [],
    input.envelope.accountId,
  );
  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "import-portable-archive",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
        input.envelope.accountId,
        expectedGeneration,
      );
      const workspaceStore = transaction.objectStore(WORKSPACE_STORE);
      const raw: unknown = await requestResult(
        workspaceStore.get(input.envelope.accountId),
      );
      const current = raw === undefined
        ? null
        : recoverWorkspaceEnvelope(raw, input.envelope.accountId);
      const storedEnvelope = preparePortableArchiveWorkspaceWrite(
        current,
        input.envelope,
      );
      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);

      if (input.kind === "merge") {
        for (const record of records) {
          const existing = await requestResult(
            evidenceStore.get(evidenceKey(
              record.accountId,
              record.goalId,
              record.evidenceId,
            )),
          );
          if (existing !== undefined) {
            throw new PersistenceError(
              "local-conflict",
              "import-portable-archive",
              "Imported evidence would overwrite a file committed by another tab.",
            );
          }
        }
      }

      let removedSupersededEvidence = 0;
      if (input.kind === "replace") {
        const retained = new Set(records.map((record) =>
          JSON.stringify(evidenceKey(
            record.accountId,
            record.goalId,
            record.evidenceId,
          ))));
        const index = evidenceStore.index(EVIDENCE_ACCOUNT_INDEX);
        await new Promise<void>((resolve, reject) => {
          const request = index.openCursor(IDBKeyRange.only(input.envelope.accountId));
          request.onerror = () => reject(
            request.error ?? new Error("Could not inspect superseded archive evidence."),
          );
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve();
              return;
            }
            const key = Array.isArray(cursor.primaryKey)
              ? JSON.stringify(cursor.primaryKey)
              : "";
            if (retained.has(key)) {
              cursor.continue();
              return;
            }
            const deletion = cursor.delete();
            deletion.onerror = () => reject(
              deletion.error ?? new Error("Could not remove superseded archive evidence."),
            );
            deletion.onsuccess = () => {
              removedSupersededEvidence += 1;
              cursor.continue();
            };
          };
        });
      }

      const promotedEvidence = await promotePreparedStagedEvidence(
        transaction,
        preparedEvidence,
      );
      for (const record of storedRecords) {
        await requestResult(evidenceStore.put({
          ...record,
          writeId: globalThis.crypto.randomUUID(),
        } satisfies StoredEvidenceBytesRecord));
      }
      await requestResult(workspaceStore.put(storedEnvelope));
      if (promotedEvidence || storedRecords.length || removedSupersededEvidence) {
        await requestResult(scopeStore.put(
          nextEvidenceRevision(scope, "import-portable-archive"),
        ));
      }
      return {
        envelope: storedEnvelope,
        removedSupersededEvidence,
      };
    },
  );
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

async function preparedStagedEvidenceWrites(
  writes: readonly StagedEvidenceBlobWrite[],
  expectedAccountId: string,
): Promise<Array<{
  receipt: StagedEvidenceBlobWrite;
  stored: StoredEvidenceBytesRecord;
}>> {
  const tokens = new Set<string>();
  const prepared = [];
  for (const receipt of writes) {
    if (
      !isPersistenceId(receipt.token)
      || !isEvidenceBlobRecord(receipt.record)
      || receipt.record.accountId !== expectedAccountId
      || tokens.has(receipt.token)
    ) {
      throw new PersistenceError(
        "invalid-argument",
        "promote-staged-evidence",
        "A staged evidence receipt is invalid, duplicated, or belongs to another account.",
      );
    }
    tokens.add(receipt.token);
    prepared.push({
      receipt,
      stored: await serializeEvidenceBlobRecord(receipt.record),
    });
  }
  return prepared;
}

/**
 * Validates and consumes every staging token inside the caller's transaction.
 * Live keys are insert-only here: an exact byte match is shared without a
 * rewrite, while any differing value aborts the whole workspace commit.
 */
async function promotePreparedStagedEvidence(
  transaction: IDBTransaction,
  prepared: readonly Awaited<ReturnType<typeof preparedStagedEvidenceWrites>>[number][],
): Promise<boolean> {
  const stagingStore = transaction.objectStore(EVIDENCE_STAGING_STORE);
  const liveStore = transaction.objectStore(EVIDENCE_STORE);
  let liveChanged = false;
  for (const item of prepared) {
    const staged: unknown = await requestResult(stagingStore.get(item.receipt.token));
    if (
      !isRecord(staged)
      || staged.token !== item.receipt.token
      || !storedEvidenceBytesEqual(staged, item.stored)
    ) {
      throw new PersistenceError(
        "local-conflict",
        "promote-staged-evidence",
        "The staged evidence bytes are missing, damaged, or were already consumed by another operation.",
      );
    }
    const key = evidenceKey(
      item.receipt.record.accountId,
      item.receipt.record.goalId,
      item.receipt.record.evidenceId,
    );
    const live: unknown = await requestResult(liveStore.get(key));
    if (live === undefined) {
      await requestResult(liveStore.add({
        ...item.stored,
        writeId: globalThis.crypto.randomUUID(),
      } satisfies StoredEvidenceBytesRecord));
      liveChanged = true;
    } else if (!storedEvidenceBytesEqual(live, item.stored)) {
      throw new PersistenceError(
        "local-conflict",
        "promote-staged-evidence",
        "Migrated evidence would overwrite different bytes committed by another tab.",
      );
    }
    await requestResult(stagingStore.delete(item.receipt.token));
  }
  return liveChanged;
}

/**
 * Atomically compares the caller's expected local revision and stores the next
 * revision. Identical content is a successful no-op even if another same-tab
 * write already advanced the local revision.
 */
export async function writeWorkspace(
  envelope: WorkspaceEnvelope,
  expectedGeneration: PersistenceScopeGeneration,
  stagedEvidence: readonly StagedEvidenceBlobWrite[] = [],
  options: WorkspaceWriteOptions = {},
): Promise<WorkspaceEnvelope> {
  if (!isWorkspaceEnvelope(envelope)) {
    throw new PersistenceError(
      "invalid-data",
      "write-workspace",
      `Refused to persist an invalid workspace envelope (${invalidWorkspaceEnvelopeReason(envelope)}).`,
    );
  }
  const preparedEvidence = await preparedStagedEvidenceWrites(
    stagedEvidence,
    envelope.accountId,
  );
  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "write-workspace",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
        envelope.accountId,
        expectedGeneration,
      );
      const store = transaction.objectStore(WORKSPACE_STORE);
      const raw: unknown = await requestResult(store.get(envelope.accountId));
      const current = raw === undefined
        ? null
        : recoverWorkspaceEnvelope(raw, envelope.accountId);

      const decision = prepareWorkspaceWrite(current, envelope);
      let storedEnvelope = decision.envelope;
      let workspaceWriteRequired = decision.action === "write";
      if (options.removeUnreferencedEvidence && decision.action === "no-op") {
        if (storedEnvelope.localRevision !== envelope.localRevision) {
          throw new LocalWorkspaceConflictError(
            envelope.accountId,
            envelope.localRevision,
            storedEnvelope.localRevision,
          );
        }
        if (storedEnvelope.localRevision === Number.MAX_SAFE_INTEGER) {
          throw new PersistenceError(
            "invalid-data",
            "write-workspace",
            "The browser-local workspace revision is exhausted. Export a backup before resetting local storage.",
          );
        }
        storedEnvelope = {
          ...storedEnvelope,
          localRevision: storedEnvelope.localRevision + 1,
        };
        workspaceWriteRequired = true;
      }
      if (workspaceWriteRequired) {
        delete storedEnvelope.recovery;
        await requestResult(store.put(storedEnvelope));
      }
      const evidenceChanged = await promotePreparedStagedEvidence(
        transaction,
        preparedEvidence,
      );
      let removedUnreferencedEvidence = 0;
      if (options.removeUnreferencedEvidence) {
        const retainedKeys = workspaceEvidenceReferences(storedEnvelope).keys;
        const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
        const index = evidenceStore.index(EVIDENCE_ACCOUNT_INDEX);
        await new Promise<void>((resolve, reject) => {
          const request = index.openCursor(IDBKeyRange.only(envelope.accountId));
          request.onerror = () => reject(
            request.error ?? new Error("Could not inspect replacement evidence."),
          );
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve();
              return;
            }
            const encodedKey = Array.isArray(cursor.primaryKey)
              ? JSON.stringify(cursor.primaryKey)
              : "";
            if (retainedKeys.has(encodedKey)) {
              cursor.continue();
              return;
            }
            const deletion = cursor.delete();
            deletion.onerror = () => reject(
              deletion.error ?? new Error("Could not remove replacement evidence."),
            );
            deletion.onsuccess = () => {
              removedUnreferencedEvidence += 1;
              cursor.continue();
            };
          };
        });
      }
      if (evidenceChanged || removedUnreferencedEvidence) {
        await requestResult(scopeStore.put(
          nextEvidenceRevision(scope, "write-workspace"),
        ));
      }
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
  stagedEvidence: readonly StagedEvidenceBlobWrite[] = [],
): Promise<WorkspaceEnvelope> {
  const requested: WorkspaceEnvelope = { ...envelope, localRevision: 0 };
  if (!isWorkspaceEnvelope(requested)) {
    throw new PersistenceError(
      "invalid-data",
      "replace-quarantined-workspace",
      "Refused to replace a quarantined workspace with an invalid envelope.",
    );
  }
  const preparedEvidence = await preparedStagedEvidenceWrites(
    stagedEvidence,
    requested.accountId,
  );
  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "replace-quarantined-workspace",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
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
      const evidenceChanged = await promotePreparedStagedEvidence(
        transaction,
        preparedEvidence,
      );
      if (evidenceChanged) {
        await requestResult(scopeStore.put(
          nextEvidenceRevision(scope, "replace-quarantined-workspace"),
        ));
      }
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

function evidenceBlobRecord(input: EvidenceBlobInput): EvidenceBlobRecord {
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
  return record;
}

export async function storeEvidenceBlob(
  input: EvidenceBlobInput,
  expectedGeneration: PersistenceScopeGeneration,
  expectedWorkspaceLocalRevision: number,
): Promise<EvidenceBlobRecord> {
  const record = evidenceBlobRecord(input);
  const writeId = globalThis.crypto.randomUUID();
  let committedWriteId = writeId;
  const storedRecord = {
    ...await serializeEvidenceBlobRecord(record),
    writeId,
  } satisfies StoredEvidenceBytesRecord;
  await runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "store-evidence",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
        record.accountId,
        expectedGeneration,
      );
      const rawWorkspace: unknown = await requestResult(
        transaction.objectStore(WORKSPACE_STORE).get(record.accountId),
      );
      requireExactWorkspaceLocalRevision(
        rawWorkspace,
        record.accountId,
        expectedWorkspaceLocalRevision,
      );
      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
      const key = evidenceKey(record.accountId, record.goalId, record.evidenceId);
      const current: unknown = await requestResult(evidenceStore.get(key));
      if (current !== undefined) {
        if (!storedEvidenceBytesEqual(current, storedRecord)) {
          throw new PersistenceError(
            "local-conflict",
            "store-evidence",
            "Evidence storage already contains different bytes for this workspace key.",
          );
        }
        const recovered = recoverEvidenceBlobRecord(current);
        if (!recovered) {
          throw new PersistenceError(
            "invalid-data",
            "store-evidence",
            "The existing evidence record is damaged.",
          );
        }
        if (!isPersistenceId(recovered.writeId)) {
          throw new PersistenceError(
            "invalid-data",
            "store-evidence",
            "The existing evidence record has no live write identity.",
          );
        }
        committedWriteId = recovered.writeId;
        return;
      }
      await requestResult(evidenceStore.add(storedRecord));
      await requestResult(scopeStore.put(nextEvidenceRevision(scope, "store-evidence")));
    },
  );
  return { ...record, writeId: committedWriteId };
}

/**
 * Stores migration bytes under an opaque token. Staging is a separate object
 * store and is therefore never visible to live evidence readers or backups.
 */
export async function stageEvidenceBlob(
  input: EvidenceBlobInput,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<StagedEvidenceBlobWrite> {
  const record = evidenceBlobRecord(input);
  const serialized = await serializeEvidenceBlobRecord(record);
  const token = globalThis.crypto.randomUUID();
  const stagedStored: StoredStagedEvidenceBytesRecord = {
    ...serialized,
    token,
    stagedAt: new Date().toISOString(),
  };

  return runStoresTransaction(
    [EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "stage-evidence",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        record.accountId,
        expectedGeneration,
      );
      await requestResult(
        transaction.objectStore(EVIDENCE_STAGING_STORE).add(stagedStored),
      );
      return { token, record };
    },
  );
}

/**
 * Compensation deletes only the opaque staging token. It can never restore,
 * replace, or delete a live evidence value.
 */
export async function rollbackStagedEvidenceBlob(
  write: StagedEvidenceBlobWrite,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<EvidenceBlobRollbackResult> {
  if (
    !isEvidenceBlobRecord(write.record)
    || !isPersistenceId(write.token)
  ) {
    throw new PersistenceError(
      "invalid-argument",
      "rollback-staged-evidence",
      "The staged evidence rollback receipt is invalid.",
    );
  }

  const expected = await serializeEvidenceBlobRecord(write.record);

  return runStoresTransaction(
    [EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "rollback-staged-evidence",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        write.record.accountId,
        expectedGeneration,
      );
      const store = transaction.objectStore(EVIDENCE_STAGING_STORE);
      const current: unknown = await requestResult(store.get(write.token));
      if (current === undefined) return "already-absent";
      if (
        !isRecord(current)
        || current.token !== write.token
        || !storedEvidenceBytesEqual(current, expected)
      ) {
        throw new PersistenceError(
          "invalid-data",
          "rollback-staged-evidence",
          "The staged evidence token contains different or damaged bytes.",
        );
      }
      await requestResult(store.delete(write.token));
      return "rolled-back";
    },
  );
}

export async function stageEvidenceCleanupIntent(
  input: EvidenceCleanupIntentInput,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<EvidenceCleanupIntent> {
  evidenceKey(input.accountId, input.goalId, input.evidenceId);
  if (
    (input.expectedWriteId !== undefined && !isPersistenceId(input.expectedWriteId))
    || (input.remotePath !== undefined
      && (input.remotePath.length === 0
        || input.remotePath.length > 1_024
        || input.remotePath !== input.remotePath.trim()))
    || (input.expectedWriteId === undefined && input.remotePath === undefined)
  ) {
    throw new PersistenceError(
      "invalid-argument",
      "stage-evidence-cleanup",
      "Evidence cleanup requires an exact live write identity or private object path.",
    );
  }
  const intent: EvidenceCleanupIntent = {
    kind: "cleanup",
    token: globalThis.crypto.randomUUID(),
    accountId: input.accountId,
    goalId: input.goalId,
    evidenceId: input.evidenceId,
    createdAt: new Date().toISOString(),
    ...(input.expectedWriteId ? { expectedWriteId: input.expectedWriteId } : {}),
    ...(input.remotePath ? { remotePath: input.remotePath } : {}),
  };
  return runStoresTransaction(
    [EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "stage-evidence-cleanup",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        intent.accountId,
        expectedGeneration,
      );
      await requestResult(
        transaction.objectStore(EVIDENCE_STAGING_STORE).add(intent),
      );
      return intent;
    },
  );
}

export async function cancelEvidenceCleanupIntent(
  intent: EvidenceCleanupIntent,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<"cancelled" | "already-absent"> {
  if (!isEvidenceCleanupIntent(intent)) {
    throw new PersistenceError(
      "invalid-argument",
      "cancel-evidence-cleanup",
      "The evidence cleanup receipt is invalid.",
    );
  }
  return runStoresTransaction(
    [EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "cancel-evidence-cleanup",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        intent.accountId,
        expectedGeneration,
      );
      const store = transaction.objectStore(EVIDENCE_STAGING_STORE);
      const raw: unknown = await requestResult(store.get(intent.token));
      if (raw === undefined) return "already-absent";
      if (!isEvidenceCleanupIntent(raw) || !cleanupIntentContentsEqual(raw, intent)) {
        throw new PersistenceError(
          "invalid-data",
          "cancel-evidence-cleanup",
          "The evidence cleanup token contains different or damaged provenance.",
        );
      }
      await requestResult(store.delete(intent.token));
      return "cancelled";
    },
  );
}

export async function listEvidenceCleanupIntents(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<EvidenceCleanupIntent[]> {
  const key = workspaceKey(accountId);
  return runStoresTransaction(
    [EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readonly",
    "list-evidence-cleanup",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
        expectedGeneration,
      );
      const values: unknown[] = await requestResult(
        transaction.objectStore(EVIDENCE_STAGING_STORE)
          .index(EVIDENCE_STAGING_ACCOUNT_INDEX)
          .getAll(key),
      );
      const intents: EvidenceCleanupIntent[] = [];
      for (const value of values) {
        if (!isRecord(value) || value.kind !== "cleanup") continue;
        if (!isEvidenceCleanupIntent(value) || value.accountId !== key) {
          throw new PersistenceError(
            "invalid-data",
            "list-evidence-cleanup",
            "An evidence cleanup journal entry is damaged.",
          );
        }
        intents.push(value);
      }
      return intents.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
  );
}

export async function markEvidenceCleanupRemoteComplete(
  intent: EvidenceCleanupIntent,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<"updated" | "completed" | "already-absent"> {
  if (!isEvidenceCleanupIntent(intent) || !intent.remotePath) {
    throw new PersistenceError(
      "invalid-argument",
      "complete-remote-evidence-cleanup",
      "Remote cleanup requires an exact durable journal receipt.",
    );
  }
  return runStoresTransaction(
    [EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "complete-remote-evidence-cleanup",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        intent.accountId,
        expectedGeneration,
      );
      const store = transaction.objectStore(EVIDENCE_STAGING_STORE);
      const raw: unknown = await requestResult(store.get(intent.token));
      if (raw === undefined) return "already-absent";
      if (!isEvidenceCleanupIntent(raw) || !cleanupIntentContentsEqual(raw, intent)) {
        throw new PersistenceError(
          "local-conflict",
          "complete-remote-evidence-cleanup",
          "The cleanup journal changed before remote deletion completed.",
        );
      }
      if (raw.expectedWriteId) {
        await requestResult(store.put({ ...raw, remotePath: undefined }));
        return "updated";
      }
      await requestResult(store.delete(raw.token));
      return "completed";
    },
  );
}

export interface EvidenceCleanupRecoveryResult {
  readonly deletedLive: number;
  readonly cancelledReferenced: number;
  readonly pendingRemote: number;
}

function workspaceEvidenceReferences(envelope: WorkspaceEnvelope | null): {
  keys: Set<string>;
  remotePaths: Set<string>;
} {
  const keys = new Set<string>();
  const remotePaths = new Set<string>();
  if (!envelope) return { keys, remotePaths };
  for (const state of [envelope.state, ...envelope.history]) {
    for (const goal of state.goals) {
      for (const item of goal.evidence) {
        if (item.type === "file") {
          keys.add(JSON.stringify(evidenceKey(
            envelope.accountId,
            goal.id,
            item.id,
          )));
          if (item.remotePath) remotePaths.add(item.remotePath);
        }
      }
    }
  }
  return { keys, remotePaths };
}

/**
 * Recovers deletion work after a crash. The authoritative persisted workspace
 * and exact live write identities are checked in the same transaction. A
 * reintroduced reference cancels cleanup; a newer replacement always survives.
 */
export async function recoverLocalEvidenceCleanupIntents(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
): Promise<EvidenceCleanupRecoveryResult> {
  const key = workspaceKey(accountId);
  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "recover-local-evidence-cleanup",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
        key,
        expectedGeneration,
      );
      const rawWorkspace: unknown = await requestResult(
        transaction.objectStore(WORKSPACE_STORE).get(key),
      );
      const envelope = rawWorkspace === undefined
        ? null
        : recoverWorkspaceEnvelope(rawWorkspace, key);
      const references = workspaceEvidenceReferences(envelope);
      const stagingStore = transaction.objectStore(EVIDENCE_STAGING_STORE);
      const values: unknown[] = await requestResult(
        stagingStore.index(EVIDENCE_STAGING_ACCOUNT_INDEX).getAll(key),
      );
      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
      let deletedLive = 0;
      let cancelledReferenced = 0;
      let pendingRemote = 0;
      for (const value of values) {
        if (!isRecord(value) || value.kind !== "cleanup") continue;
        if (!isEvidenceCleanupIntent(value) || value.accountId !== key) {
          throw new PersistenceError(
            "invalid-data",
            "recover-local-evidence-cleanup",
            "An evidence cleanup journal entry is damaged.",
          );
        }
        const encodedKey = JSON.stringify(evidenceKey(
          value.accountId,
          value.goalId,
          value.evidenceId,
        ));
        if (references.keys.has(encodedKey)) {
          if (value.remotePath && !references.remotePaths.has(value.remotePath)) {
            await requestResult(stagingStore.put({
              ...value,
              expectedWriteId: undefined,
            }));
            pendingRemote += 1;
          } else {
            await requestResult(stagingStore.delete(value.token));
            cancelledReferenced += 1;
          }
          continue;
        }
        if (value.expectedWriteId) {
          const live: unknown = await requestResult(evidenceStore.get(JSON.parse(
            encodedKey,
          ) as [string, string, string]));
          if (isRecord(live) && live.writeId === value.expectedWriteId) {
            await requestResult(evidenceStore.delete(JSON.parse(
              encodedKey,
            ) as [string, string, string]));
            deletedLive += 1;
          }
        }
        if (value.remotePath) {
          await requestResult(stagingStore.put({
            ...value,
            expectedWriteId: undefined,
          }));
          pendingRemote += 1;
        } else {
          await requestResult(stagingStore.delete(value.token));
        }
      }
      if (deletedLive) {
        await requestResult(scopeStore.put(
          nextEvidenceRevision(scope, "recover-local-evidence-cleanup"),
        ));
      }
      return { deletedLive, cancelledReferenced, pendingRemote };
    },
  );
}

/** Deletes abandoned staging rows without touching any live evidence value. */
export async function cleanupAbandonedEvidenceStaging(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
  stagedBefore: string,
): Promise<number> {
  const key = workspaceKey(accountId);
  if (!isIsoDate(stagedBefore)) {
    throw new PersistenceError(
      "invalid-argument",
      "cleanup-evidence-staging",
      "The staging cleanup cutoff must be an ISO timestamp.",
    );
  }
  return runStoresTransaction(
    [EVIDENCE_STAGING_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "cleanup-evidence-staging",
    async (transaction) => {
      await requireWritableAccountScope(
        transaction.objectStore(ACCOUNT_SCOPE_STORE),
        key,
        expectedGeneration,
      );
      const index = transaction.objectStore(EVIDENCE_STAGING_STORE)
        .index(EVIDENCE_STAGING_ACCOUNT_INDEX);
      return new Promise<number>((resolve, reject) => {
        let removed = 0;
        const cursorRequest = index.openCursor(IDBKeyRange.only(key));
        cursorRequest.onerror = () => reject(
          cursorRequest.error ?? new Error("Could not enumerate staged evidence."),
        );
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve(removed);
            return;
          }
          const value = cursor.value;
          if (isRecord(value) && value.kind === "cleanup") {
            if (!isEvidenceCleanupIntent(value)) {
              reject(new PersistenceError(
                "invalid-data",
                "cleanup-evidence-staging",
                "An evidence cleanup journal entry is damaged.",
              ));
              return;
            }
            cursor.continue();
            return;
          }
          if (!isRecord(value) || !isIsoDate(value.stagedAt)) {
            reject(new PersistenceError(
              "invalid-data",
              "cleanup-evidence-staging",
              "A staged evidence record is damaged.",
            ));
            return;
          }
          if (value.stagedAt >= stagedBefore) {
            cursor.continue();
            return;
          }
          const deletion = cursor.delete();
          deletion.onerror = () => reject(
            deletion.error ?? new Error("Could not remove abandoned staged evidence."),
          );
          deletion.onsuccess = () => {
            removed += 1;
            cursor.continue();
          };
        };
      });
    },
  );
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
    const record = recoverEvidenceBlobRecord(value);
    if (!record
      || record.accountId !== key[0]
      || record.goalId !== key[1]
      || record.evidenceId !== key[2]) {
      throw new PersistenceError(
        "invalid-data",
        "read-evidence",
        "The stored evidence record is invalid or belongs to another account or goal.",
      );
    }
    return record;
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
    const records = values.map(recoverEvidenceBlobRecord);
    if (records.some((record) => record === null)) {
      throw new PersistenceError(
        "invalid-data",
        "list-evidence",
        "One or more stored evidence records are invalid.",
      );
    }
    const recovered = records as EvidenceBlobRecord[];
    if (recovered.some((record) => record.accountId !== accountKey
      || (goalKey !== undefined && record.goalId !== goalKey))) {
      throw new PersistenceError(
        "invalid-data",
        "list-evidence",
        "IndexedDB returned evidence outside the requested account scope.",
      );
    }
    return recovered.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    },
  );
}

function persistedWorkspaceLocalRevision(raw: unknown, accountId: string): number {
  return raw === undefined ? 0 : recoverWorkspaceEnvelope(raw, accountId).localRevision;
}

function requireExactWorkspaceLocalRevision(
  raw: unknown,
  accountId: string,
  expectedLocalRevision: number,
): void {
  if (!isLocalRevision(expectedLocalRevision)) {
    throw new PersistenceError(
      "invalid-argument",
      "evidence-revision-fence",
      "The committed workspace revision must be a non-negative safe integer.",
    );
  }
  const actual = persistedWorkspaceLocalRevision(raw, accountId);
  if (actual !== expectedLocalRevision) {
    throw new LocalWorkspaceConflictError(accountId, expectedLocalRevision, actual);
  }
}

export async function deleteEvidenceBlobs(
  snapshots: readonly EvidenceBlobRecord[],
  expectedGeneration: PersistenceScopeGeneration,
  expectedWorkspaceLocalRevision: number,
): Promise<EvidenceBlobDeleteResult> {
  if (!snapshots.length) {
    throw new PersistenceError(
      "invalid-argument",
      "delete-evidence",
      "Evidence deletion requires at least one exact live write snapshot.",
    );
  }
  const accountId = snapshots[0].accountId;
  const keys = new Set<string>();
  for (const snapshot of snapshots) {
    const key = evidenceKey(snapshot.accountId, snapshot.goalId, snapshot.evidenceId);
    const encoded = JSON.stringify(key);
    if (
      !isEvidenceBlobRecord(snapshot)
      || !isPersistenceId(snapshot.writeId)
      || snapshot.accountId !== accountId
      || keys.has(encoded)
    ) {
      throw new PersistenceError(
        "invalid-argument",
        "delete-evidence",
        "Evidence deletion requires unique exact live write snapshots from one account.",
      );
    }
    keys.add(encoded);
  }
  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "delete-evidence",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
        accountId,
        expectedGeneration,
      );
      const rawWorkspace: unknown = await requestResult(
        transaction.objectStore(WORKSPACE_STORE).get(accountId),
      );
      requireExactWorkspaceLocalRevision(
        rawWorkspace,
        accountId,
        expectedWorkspaceLocalRevision,
      );
      const store = transaction.objectStore(EVIDENCE_STORE);
      for (const snapshot of snapshots) {
        const current: unknown = await requestResult(store.get(evidenceKey(
          snapshot.accountId,
          snapshot.goalId,
          snapshot.evidenceId,
        )));
        if (!isRecord(current) || current.writeId !== snapshot.writeId) {
          return { kind: "superseded" };
        }
      }
      for (const snapshot of snapshots) {
        await requestResult(store.delete(evidenceKey(
          snapshot.accountId,
          snapshot.goalId,
          snapshot.evidenceId,
        )));
      }
      const nextScope = nextEvidenceRevision(scope, "delete-evidence");
      await requestResult(scopeStore.put(nextScope));
      return {
        kind: "deleted",
        receipt: {
          accountId,
          generation: expectedGeneration,
          workspaceLocalRevision: expectedWorkspaceLocalRevision,
          evidenceRevisionAfterDelete: nextScope.evidenceRevision,
          snapshots: snapshots.map((snapshot) => ({ ...snapshot })),
        },
      };
    },
  );
}

export async function deleteEvidenceBlob(
  snapshot: EvidenceBlobRecord,
  expectedGeneration: PersistenceScopeGeneration,
  expectedWorkspaceLocalRevision: number,
): Promise<EvidenceBlobDeleteResult> {
  return deleteEvidenceBlobs(
    [snapshot],
    expectedGeneration,
    expectedWorkspaceLocalRevision,
  );
}

/**
 * Compensation restores only an absent key, or shares already-identical live
 * bytes. A newer differing write is never overwritten by stale rollback.
 */
export async function restoreEvidenceBlobs(
  receipt: EvidenceBlobDeletionReceipt,
): Promise<"restored" | "already-equal" | "superseded"> {
  if (
    !isPersistenceId(receipt.accountId)
    || !isLocalRevision(receipt.workspaceLocalRevision)
    || !isLocalRevision(receipt.evidenceRevisionAfterDelete)
    || !receipt.snapshots.length
    || receipt.snapshots.some((snapshot) => (
      !isEvidenceBlobRecord(snapshot)
      || snapshot.accountId !== receipt.accountId
    ))
  ) {
    throw new PersistenceError(
      "invalid-argument",
      "restore-evidence",
      "Evidence restoration requires an exact deletion receipt.",
    );
  }
  const stored = await Promise.all(receipt.snapshots.map(async (snapshot) => ({
    snapshot,
    value: await serializeEvidenceBlobRecord(snapshot),
  })));
  return runStoresTransaction(
    [WORKSPACE_STORE, EVIDENCE_STORE, ACCOUNT_SCOPE_STORE],
    "readwrite",
    "restore-evidence",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
        receipt.accountId,
        receipt.generation,
      );
      if (scope.evidenceRevision !== receipt.evidenceRevisionAfterDelete) {
        return "superseded";
      }
      const rawWorkspace: unknown = await requestResult(
        transaction.objectStore(WORKSPACE_STORE).get(receipt.accountId),
      );
      requireExactWorkspaceLocalRevision(
        rawWorkspace,
        receipt.accountId,
        receipt.workspaceLocalRevision,
      );
      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
      let inserted = false;
      for (const item of stored) {
        const current: unknown = await requestResult(evidenceStore.get(evidenceKey(
          item.snapshot.accountId,
          item.snapshot.goalId,
          item.snapshot.evidenceId,
        )));
        if (current !== undefined && !storedEvidenceBytesEqual(current, item.value)) {
          return "superseded";
        }
      }
      for (const item of stored) {
        const key = evidenceKey(
          item.snapshot.accountId,
          item.snapshot.goalId,
          item.snapshot.evidenceId,
        );
        const current: unknown = await requestResult(evidenceStore.get(key));
        if (current !== undefined) continue;
        await requestResult(evidenceStore.add({
          ...item.value,
          writeId: globalThis.crypto.randomUUID(),
        } satisfies StoredEvidenceBytesRecord));
        inserted = true;
      }
      if (inserted) {
        await requestResult(scopeStore.put(nextEvidenceRevision(scope, "restore-evidence")));
      }
      return inserted ? "restored" : "already-equal";
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
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const scope = await requireWritableAccountScope(
        scopeStore,
        key,
        expectedGeneration,
      );
      const deleted = await deleteEvidenceCursor(
        transaction.objectStore(EVIDENCE_STORE).index(EVIDENCE_ACCOUNT_INDEX),
        key,
      );
      if (deleted) {
        await requestResult(scopeStore.put(
          nextEvidenceRevision(scope, "delete-account-evidence"),
        ));
      }
      return deleted;
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
    [
      WORKSPACE_STORE,
      EVIDENCE_STORE,
      EVIDENCE_STAGING_STORE,
      ACCOUNT_SCOPE_STORE,
      ACCOUNT_REMINDER_STORE,
    ],
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
      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
      const [, deletedEvidence] = await Promise.all([
        requestResult(transaction.objectStore(WORKSPACE_STORE).delete(key)),
        deleteEvidenceCursor(evidenceStore.index(EVIDENCE_ACCOUNT_INDEX), key),
        deleteEvidenceCursor(
          transaction.objectStore(EVIDENCE_STAGING_STORE)
            .index(EVIDENCE_STAGING_ACCOUNT_INDEX),
          key,
        ),
        requestResult(transaction.objectStore(ACCOUNT_REMINDER_STORE).delete(key)),
      ]);
      const scope: AccountPersistenceScope = {
        accountId: key,
        generation: current.generation + 1,
        evidenceRevision: deletedEvidence
          ? nextEvidenceRevision(current, "delete-account-persistence").evidenceRevision
          : current.evidenceRevision,
        tombstoned: false,
        updatedAt: new Date().toISOString(),
      };
      await requestResult(scopeStore.put(scope));
      return { deletedEvidence, scope };
    },
  );
}

/**
 * Atomically refuses destructive reset when the persisted workspace revision
 * differs from the revision covered by the person's completed backup.
 */
export async function deleteAccountPersistenceAtRevision(
  accountId: string,
  expectedGeneration: PersistenceScopeGeneration,
  expectedLocalRevision: number,
  expectedEvidenceRevision: number,
): Promise<AccountPersistenceEraseResult> {
  const key = workspaceKey(accountId);
  const expected = requireScopeGeneration(expectedGeneration);
  if (!isLocalRevision(expectedLocalRevision) || !isLocalRevision(expectedEvidenceRevision)) {
    throw new PersistenceError(
      "invalid-argument",
      "delete-account-persistence-at-revision",
      "The backup receipt contains an invalid browser-local revision.",
    );
  }
  return runStoresTransaction(
    [
      WORKSPACE_STORE,
      EVIDENCE_STORE,
      EVIDENCE_STAGING_STORE,
      ACCOUNT_SCOPE_STORE,
      ACCOUNT_REMINDER_STORE,
      LEGACY_IMPORT_CLAIM_STORE,
    ],
    "readwrite",
    "delete-account-persistence-at-revision",
    async (transaction) => {
      const scopeStore = transaction.objectStore(ACCOUNT_SCOPE_STORE);
      const current = await requireWritableAccountScope(scopeStore, key, expected);
      const raw: unknown = await requestResult(
        transaction.objectStore(WORKSPACE_STORE).get(key),
      );
      requireAccountPersistenceBackupBoundary(raw, current, {
        accountId: key,
        generation: expected,
        workspaceLocalRevision: expectedLocalRevision,
        evidenceRevision: expectedEvidenceRevision,
      }, "delete-account-persistence-at-revision");
      if (current.generation === Number.MAX_SAFE_INTEGER) {
        throw new PersistenceError(
          "invalid-data",
          "delete-account-persistence-at-revision",
          "The account persistence generation is exhausted.",
        );
      }
      const evidenceStore = transaction.objectStore(EVIDENCE_STORE);
      const legacyImportStore = transaction.objectStore(LEGACY_IMPORT_CLAIM_STORE);
      const legacyImport: unknown = await requestResult(legacyImportStore.get(key));
      const disabledLegacyImport = prepareLegacyWorkspaceImportDisable(
        legacyImport,
        key,
      );
      const [, deletedEvidence] = await Promise.all([
        requestResult(transaction.objectStore(WORKSPACE_STORE).delete(key)),
        deleteEvidenceCursor(evidenceStore.index(EVIDENCE_ACCOUNT_INDEX), key),
        deleteEvidenceCursor(
          transaction.objectStore(EVIDENCE_STAGING_STORE)
            .index(EVIDENCE_STAGING_ACCOUNT_INDEX),
          key,
        ),
        requestResult(transaction.objectStore(ACCOUNT_REMINDER_STORE).delete(key)),
        requestResult(legacyImportStore.put(disabledLegacyImport)),
      ]);
      const scope: AccountPersistenceScope = {
        accountId: key,
        generation: current.generation + 1,
        evidenceRevision: deletedEvidence
          ? nextEvidenceRevision(current, "delete-account-persistence-at-revision").evidenceRevision
          : current.evidenceRevision,
        tombstoned: false,
        updatedAt: new Date().toISOString(),
      };
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
    [
      WORKSPACE_STORE,
      EVIDENCE_STORE,
      EVIDENCE_STAGING_STORE,
      ACCOUNT_SCOPE_STORE,
      ACCOUNT_REMINDER_STORE,
    ],
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
        deleteEvidenceCursor(
          transaction.objectStore(EVIDENCE_STAGING_STORE)
            .index(EVIDENCE_STAGING_ACCOUNT_INDEX),
          key,
        ),
        requestResult(transaction.objectStore(ACCOUNT_REMINDER_STORE).delete(key)),
      ]);
      return { deletedEvidence, scope };
    },
  );
}

export const indexedDbPersistence = {
  isAvailable: hasIndexedDbSupport,
  readAccountPersistenceScope,
  readAccountPersistenceBackupBoundary,
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
  stageEvidenceBlob,
  rollbackStagedEvidenceBlob,
  stageEvidenceCleanupIntent,
  cancelEvidenceCleanupIntent,
  listEvidenceCleanupIntents,
  markEvidenceCleanupRemoteComplete,
  recoverLocalEvidenceCleanupIntents,
  cleanupAbandonedEvidenceStaging,
  readEvidenceBlob,
  listEvidenceBlobs,
  deleteEvidenceBlob,
  deleteEvidenceBlobs,
  restoreEvidenceBlobs,
  deleteAllAccountEvidence,
  deleteAccountPersistence,
  deleteAccountPersistenceAtRevision,
  applyAccountHandoffPersistence,
  applyPortableArchivePersistence,
  eraseAccountPersistenceWithTombstone,
};
