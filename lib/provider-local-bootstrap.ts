import type {
  AccountPersistenceScope,
  AccountWorkspaceRead,
  LegacyWorkspaceImportJournal,
  PersistenceScopeGeneration,
  WorkspaceEnvelope,
} from "@/lib/persistence";
import { PersistenceError } from "@/lib/persistence";
import type {
  ExternalizedEvidence,
  ExternalizedWorkspaceHistory,
} from "@/lib/provider-evidence";
import { trimWorkspaceHistory } from "@/lib/provider-state";
import {
  migrateStoredState,
  UnsupportedStoredWorkspaceVersionError,
} from "@/lib/state-schema";

export interface LegacyWorkspaceObservation {
  readonly raw: string | null;
  readonly readError?: Error;
}

/**
 * Legacy localStorage must be observed synchronously, before IndexedDB work
 * yields to another old-build tab. The callback keeps that browser boundary
 * outside the bootstrap transaction and makes the captured value immutable.
 */
export function observeLegacyWorkspace(
  read: () => string | null,
): LegacyWorkspaceObservation {
  try {
    return Object.freeze({ raw: read() });
  } catch (error) {
    return Object.freeze({
      raw: null,
      readError: error instanceof Error
        ? error
        : new Error("Legacy browser storage could not be read."),
    });
  }
}

export class LocalBootstrapSupersededError extends Error {
  constructor() {
    super("The active workspace changed while local data was being prepared.");
    this.name = "LocalBootstrapSupersededError";
  }
}

export interface LocalBootstrapRequest {
  readonly accountId: string;
  readonly legacy: LegacyWorkspaceObservation;
  /**
   * An account/workspace lifecycle checkpoint. It must throw
   * LocalBootstrapSupersededError when the immutable attempt token is stale.
   */
  readonly ensureCurrent: () => void;
}

export interface LocalBootstrapPersistRequest {
  readonly envelope: Readonly<Omit<WorkspaceEnvelope, "localRevision">>;
  readonly expectedScopeGeneration: PersistenceScopeGeneration;
}

export interface ExternalizeBootstrapStateRequest {
  readonly state: WorkspaceEnvelope["state"];
  readonly accountId: string;
  readonly expectedScopeGeneration: PersistenceScopeGeneration;
}

export interface ExternalizeBootstrapHistoryRequest
  extends ExternalizeBootstrapStateRequest {
  readonly history: readonly WorkspaceEnvelope["state"][];
}

/**
 * Every effectful bootstrap boundary is injected. In particular, this runner
 * never closes over React refs or setters and cannot adopt the returned state.
 */
export interface LocalBootstrapPorts {
  readonly readWorkspace: (accountId: string) => Promise<AccountWorkspaceRead>;
  readonly readRawWorkspace: (accountId: string) => Promise<unknown | null>;
  readonly captureLegacyWorkspaceImport: (
    accountId: string,
    observedRaw: string | null,
  ) => Promise<LegacyWorkspaceImportJournal>;
  readonly commitLegacyWorkspaceImport: (
    accountId: string,
  ) => Promise<LegacyWorkspaceImportJournal>;
  readonly persistWorkspace: (
    request: LocalBootstrapPersistRequest,
  ) => Promise<WorkspaceEnvelope>;
  readonly externalizeEmbeddedEvidence: (
    request: ExternalizeBootstrapStateRequest,
  ) => Promise<ExternalizedEvidence>;
  readonly externalizeWorkspaceHistory: (
    request: ExternalizeBootstrapHistoryRequest,
  ) => Promise<ExternalizedWorkspaceHistory>;
  readonly rollbackExternalizedEvidence: (
    result: ExternalizedEvidence,
  ) => Promise<void>;
  readonly now: () => string;
}

interface LocalBootstrapResultBase {
  readonly accountId: string;
  readonly scope: AccountPersistenceScope;
  /**
   * Safe removal means the journal is terminal or a canonical envelope and its
   * evidence are durable. The caller still owns the synchronous localStorage
   * compare/remove because another old-build tab may have changed the key.
   */
  readonly legacySourceCanBeCleared: boolean;
}

export interface LoadedLocalBootstrapResult extends LocalBootstrapResultBase {
  readonly kind: "loaded";
  readonly source: "device" | "legacy";
  readonly envelope: WorkspaceEnvelope;
  readonly persistedDuringBootstrap: boolean;
  readonly recoveryNotice?: string;
}

export interface EmptyLocalBootstrapResult extends LocalBootstrapResultBase {
  readonly kind: "empty";
}

interface UnsuccessfulLocalBootstrapResult {
  readonly accountId: string;
  readonly message: string;
  readonly error: unknown;
  readonly scope?: AccountPersistenceScope;
  readonly rawJson?: string;
  readonly rollbackError?: unknown;
  readonly canonicalWorkspacePersisted: boolean;
  readonly legacySourceCanBeCleared: false;
}

export interface QuarantinedLocalBootstrapResult
  extends UnsuccessfulLocalBootstrapResult {
  readonly kind: "quarantined";
}

export interface FailedLocalBootstrapResult
  extends UnsuccessfulLocalBootstrapResult {
  readonly kind: "failed";
}

export interface SupersededLocalBootstrapResult {
  readonly kind: "superseded";
  readonly accountId: string;
  readonly error: LocalBootstrapSupersededError;
  readonly rollbackError?: unknown;
  readonly legacySourceCanBeCleared: false;
}

export type LocalBootstrapResult =
  | LoadedLocalBootstrapResult
  | EmptyLocalBootstrapResult
  | QuarantinedLocalBootstrapResult
  | FailedLocalBootstrapResult
  | SupersededLocalBootstrapResult;

const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Saved data could not be read. A safe empty workspace was opened.";

function shouldQuarantineBootstrapFailure(
  error: unknown,
  pendingLegacyRaw: string | undefined,
  legacyReadError: Error | undefined,
) {
  return pendingLegacyRaw !== undefined
    || legacyReadError !== undefined
    || error instanceof SyntaxError
    || error instanceof UnsupportedStoredWorkspaceVersionError
    || (error instanceof PersistenceError && error.code === "invalid-data");
}

async function recoveryRawJson(
  accountId: string,
  fallback: string | undefined,
  readRawWorkspace: LocalBootstrapPorts["readRawWorkspace"],
) {
  try {
    const raw = await readRawWorkspace(accountId);
    if (raw !== null) {
      const serialized = JSON.stringify(raw, null, 2);
      if (typeof serialized === "string") return serialized;
    }
  } catch {
    // The original bootstrap failure remains the actionable error.
  }
  return fallback;
}

function workspaceWrite(
  envelope: WorkspaceEnvelope,
  state: WorkspaceEnvelope["state"],
  history: WorkspaceEnvelope["history"],
  dirty: boolean,
  savedAt: string,
): Omit<WorkspaceEnvelope, "localRevision"> {
  return {
    accountId: envelope.accountId,
    state,
    history,
    dirty,
    revision: envelope.revision,
    ...(envelope.serverUpdatedAt
      ? { serverUpdatedAt: envelope.serverUpdatedAt }
      : {}),
    savedAt,
    ...(envelope.anonymousHandoff
      ? { anonymousHandoff: envelope.anonymousHandoff }
      : {}),
  };
}

/**
 * Loads the anonymous device workspace as a compensated transaction.
 *
 * Evidence writes become durable only when a canonical envelope referencing
 * them is persisted. Failures before that point restore exact prior blobs;
 * failures after it deliberately keep the blobs because the envelope owns
 * them. A pending legacy journal is committed only after that same boundary.
 */
export async function runLocalWorkspaceBootstrap(
  request: Readonly<LocalBootstrapRequest>,
  ports: Readonly<LocalBootstrapPorts>,
): Promise<LocalBootstrapResult> {
  let scope: AccountPersistenceScope | undefined;
  let stagedEvidence: ExternalizedEvidence | null = null;
  let canonicalWorkspacePersisted = false;
  let pendingLegacyRaw: string | undefined;

  try {
    request.ensureCurrent();
    const read = await ports.readWorkspace(request.accountId);
    request.ensureCurrent();
    scope = read.scope;
    if (scope.tombstoned) {
      throw new Error("The anonymous workspace persistence scope is unexpectedly fenced.");
    }
    if (request.legacy.readError) throw request.legacy.readError;

    const legacyJournal = await ports.captureLegacyWorkspaceImport(
      request.accountId,
      request.legacy.raw,
    );
    request.ensureCurrent();
    pendingLegacyRaw = legacyJournal.status === "pending"
      ? legacyJournal.raw
      : undefined;

    if (read.workspace) {
      const envelope = read.workspace;
      const recovered = await ports.externalizeWorkspaceHistory({
        state: migrateStoredState(envelope.state),
        history: trimWorkspaceHistory(
          envelope.history.map((item) => migrateStoredState(item)),
        ),
        accountId: envelope.accountId,
        expectedScopeGeneration: scope.generation,
      });
      stagedEvidence = recovered;
      request.ensureCurrent();

      const recoveredDirty = envelope.recovery?.source === "history"
        ? false
        : envelope.dirty || recovered.changed;
      let resultEnvelope: WorkspaceEnvelope = {
        ...envelope,
        state: recovered.state,
        history: recovered.history,
        dirty: recoveredDirty,
      };
      let persistedDuringBootstrap = false;
      if (legacyJournal.status === "pending" || recovered.changed) {
        resultEnvelope = await ports.persistWorkspace({
          envelope: workspaceWrite(
            envelope,
            recovered.state,
            recovered.history,
            recoveredDirty,
            ports.now(),
          ),
          expectedScopeGeneration: scope.generation,
        });
        canonicalWorkspacePersisted = true;
        persistedDuringBootstrap = true;
        request.ensureCurrent();
      }

      if (legacyJournal.status === "pending") {
        await ports.commitLegacyWorkspaceImport(request.accountId);
        request.ensureCurrent();
      }

      return {
        kind: "loaded",
        accountId: request.accountId,
        scope,
        source: "device",
        envelope: resultEnvelope,
        persistedDuringBootstrap,
        ...(envelope.recovery?.message
          ? { recoveryNotice: envelope.recovery.message }
          : {}),
        legacySourceCanBeCleared: true,
      };
    }

    if (pendingLegacyRaw === undefined) {
      return {
        kind: "empty",
        accountId: request.accountId,
        scope,
        legacySourceCanBeCleared: true,
      };
    }

    const recovered = await ports.externalizeEmbeddedEvidence({
      state: migrateStoredState(JSON.parse(pendingLegacyRaw)),
      accountId: request.accountId,
      expectedScopeGeneration: scope.generation,
    });
    stagedEvidence = recovered;
    request.ensureCurrent();
    const persisted = await ports.persistWorkspace({
      envelope: {
        accountId: request.accountId,
        state: recovered.state,
        history: [],
        dirty: true,
        revision: 0,
        savedAt: ports.now(),
      },
      expectedScopeGeneration: scope.generation,
    });
    canonicalWorkspacePersisted = true;
    request.ensureCurrent();
    await ports.commitLegacyWorkspaceImport(request.accountId);
    request.ensureCurrent();

    return {
      kind: "loaded",
      accountId: request.accountId,
      scope,
      source: "legacy",
      envelope: persisted,
      persistedDuringBootstrap: true,
      legacySourceCanBeCleared: true,
    };
  } catch (error) {
    let rollbackError: unknown;
    if (stagedEvidence && !canonicalWorkspacePersisted) {
      try {
        await ports.rollbackExternalizedEvidence(stagedEvidence);
      } catch (failure) {
        rollbackError = failure;
      }
    }

    if (error instanceof LocalBootstrapSupersededError && !rollbackError) {
      return {
        kind: "superseded",
        accountId: request.accountId,
        error,
        legacySourceCanBeCleared: false,
      };
    }

    const combinedError = rollbackError
      ? new AggregateError(
        [error, rollbackError],
        "Local workspace bootstrap failed and staged evidence could not be fully restored.",
      )
      : error;
    const base = {
      accountId: request.accountId,
      message: errorMessage(error),
      error: combinedError,
      ...(scope ? { scope } : {}),
      ...(rollbackError ? { rollbackError } : {}),
      canonicalWorkspacePersisted,
      legacySourceCanBeCleared: false as const,
    };

    if (shouldQuarantineBootstrapFailure(
      error,
      pendingLegacyRaw,
      request.legacy.readError,
    )) {
      const rawJson = await recoveryRawJson(
        request.accountId,
        pendingLegacyRaw ?? request.legacy.raw ?? undefined,
        ports.readRawWorkspace,
      );
      return {
        kind: "quarantined",
        ...base,
        ...(rawJson !== undefined ? { rawJson } : {}),
      };
    }
    return { kind: "failed", ...base };
  }
}

export interface DisableLocalLegacyImportRequest {
  readonly accountId: string;
  readonly ensureCurrent: () => void;
}

export interface DisableLocalLegacyImportPorts {
  readonly disableLegacyWorkspaceImport: (
    accountId: string,
  ) => Promise<LegacyWorkspaceImportJournal>;
}

/**
 * Explicit repair action for a quarantined legacy journal. The caller must
 * still erase/replace the quarantined workspace under the same lifecycle token.
 */
export async function disableLocalBootstrapLegacyImport(
  request: Readonly<DisableLocalLegacyImportRequest>,
  ports: Readonly<DisableLocalLegacyImportPorts>,
) {
  request.ensureCurrent();
  const journal = await ports.disableLegacyWorkspaceImport(request.accountId);
  request.ensureCurrent();
  return {
    journal,
    legacySourceCanBeCleared: journal.status !== "pending",
  } as const;
}
