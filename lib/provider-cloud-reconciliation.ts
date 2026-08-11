import {
  decideAccountHandoffSource,
  decideAnonymousHandoff,
  decideSyncReconciliation,
  type AnonymousHandoffChoice,
  type AnonymousHandoffDecision,
  type AccountHandoffSourceDecision,
} from "@/lib/sync-reconciliation";

export type ProviderReconciliationSupersededReason =
  | "account"
  | "scope"
  | "handoff"
  | "switch"
  | "local-conflict";

export type ProviderReconciliationCurrentness =
  | { readonly current: true }
  | {
    readonly current: false;
    readonly reason: ProviderReconciliationSupersededReason;
  };

export interface ProviderReconciliationBoundary<
  TScopeKey,
  TPersistenceGeneration,
> {
  readonly accountId: string;
  readonly persistenceAccountId: string;
  readonly workspaceGeneration: TScopeKey;
  readonly workspaceScopeKey: TScopeKey;
  readonly persistenceGeneration: TPersistenceGeneration | undefined;
}

export interface ProviderReconciliationLocal<TState> {
  readonly state: TState;
  readonly revision: unknown;
  readonly dirty: boolean;
  readonly changeVersion: number;
}

export interface ProviderRemoteWorkspaceRow {
  readonly state: unknown;
  readonly revision: unknown;
  readonly updated_at: unknown;
}

export interface ProviderReconciliationTransportResponse {
  readonly data: unknown;
  readonly error: unknown;
  /** PostgREST uses status zero when the request outcome is transport-ambiguous. */
  readonly status?: unknown;
}

export interface ProviderPreparedRemote<TState, TEvidence> {
  readonly state: TState;
  readonly revision: number;
  readonly updatedAt: string;
  readonly needsSave: boolean;
  readonly createdEvidence: readonly TEvidence[];
}

export interface ProviderReconciliationPorts<
  TState,
  TEvidence,
  TScopeKey,
  TPersistenceGeneration,
> {
  readonly inspectCurrentness: (
    boundary: ProviderReconciliationBoundary<TScopeKey, TPersistenceGeneration>,
  ) => ProviderReconciliationCurrentness;
  readonly readLocal: () => ProviderReconciliationLocal<TState>;
  readonly fetchRemote: (
    accountId: string,
  ) => PromiseLike<ProviderReconciliationTransportResponse>;
  readonly saveSnapshot: (
    snapshot: TState,
    expectedRevision: number,
  ) => PromiseLike<ProviderReconciliationTransportResponse>;
  readonly migrateState: (stored: unknown) => TState;
  readonly prepareEvidence: (
    state: TState,
    persistenceAccountId: string,
    persistenceGeneration: TPersistenceGeneration,
  ) => PromiseLike<{
    readonly state: TState;
    readonly changed: boolean;
    readonly createdEvidence: readonly TEvidence[];
  }>;
  readonly rollbackEvidence: (evidence: readonly TEvidence[]) => PromiseLike<void>;
  readonly statesEqual: (left: TState, right: TState) => boolean;
  readonly parseRevision: (value: unknown) => number | null;
  readonly isRevisionConflict: (error: unknown) => boolean;
  readonly readStoredStateVersion: (stored: unknown) => unknown;
  readonly currentStateVersion: number;
  readonly now: () => string;
  readonly onPhase: (phase: "connecting" | "saving") => void;
}

export type ProviderReconciliationOutcome<TState, TEvidence> =
  | {
    readonly kind: "superseded";
    readonly phase: "preflight" | "fetch" | "preparation" | "save";
    readonly reason: ProviderReconciliationSupersededReason;
  }
  | { readonly kind: "remote-read-error"; readonly error: unknown }
  | {
    readonly kind: "invalid-revision";
    readonly phase: "initial" | "prepared";
    readonly source: "local" | "remote";
  }
  | { readonly kind: "preparation-error"; readonly error: unknown }
  | {
    readonly kind: "saved-local";
    readonly remote: ProviderPreparedRemote<TState, TEvidence>;
    readonly localUnchanged: boolean;
  }
  | {
    readonly kind: "conflict";
    readonly remote: ProviderPreparedRemote<TState, TEvidence>;
  }
  | {
    readonly kind: "acknowledged";
    readonly remote: ProviderPreparedRemote<TState, TEvidence>;
  }
  | {
    readonly kind: "adopt-remote";
    readonly remote: ProviderPreparedRemote<TState, TEvidence>;
  }
  | { readonly kind: "revision-conflict"; readonly error: unknown }
  | {
    /**
     * The save may have committed, but an authoritative follow-up read could
     * not yet prove it. Staged evidence must remain available for the retry.
     */
    readonly kind: "ambiguous-save";
    readonly error: unknown;
    readonly verificationError?: unknown;
  }
  | { readonly kind: "error"; readonly error: unknown };

function remoteRow(data: unknown): ProviderRemoteWorkspaceRow | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as ProviderRemoteWorkspaceRow;
}

function superseded<
  TScopeKey,
  TPersistenceGeneration,
>(
  boundary: ProviderReconciliationBoundary<TScopeKey, TPersistenceGeneration>,
  ports: Pick<
    ProviderReconciliationPorts<unknown, unknown, TScopeKey, TPersistenceGeneration>,
    "inspectCurrentness"
  >,
  phase: "preflight" | "fetch" | "preparation" | "save",
): Extract<
  ProviderReconciliationOutcome<never, never>,
  { kind: "superseded" }
> | null {
  const currentness = ports.inspectCurrentness(boundary);
  return currentness.current
    ? null
    : { kind: "superseded", phase, reason: currentness.reason };
}

/**
 * Runs one complete remote read/reconcile pass. React state and Supabase stay
 * behind injected ports; the caller applies the typed outcome only while its
 * captured account and workspace boundary remains current.
 */
export async function runProviderCloudReconciliation<
  TState,
  TEvidence,
  TScopeKey,
  TPersistenceGeneration,
>(
  boundary: ProviderReconciliationBoundary<TScopeKey, TPersistenceGeneration>,
  ports: ProviderReconciliationPorts<
    TState,
    TEvidence,
    TScopeKey,
    TPersistenceGeneration
  >,
): Promise<ProviderReconciliationOutcome<TState, TEvidence>> {
  let stagedEvidence: readonly TEvidence[] = [];
  let retainEvidence = false;

  const save = async (
    state: TState,
    expectedRevision: number,
  ): Promise<
    | {
      readonly kind: "saved";
      readonly remote: ProviderPreparedRemote<TState, TEvidence>;
    }
    | {
      readonly kind: "ambiguous";
      readonly error: unknown;
      readonly verificationError?: unknown;
    }
  > => {
    let response: ProviderReconciliationTransportResponse;
    try {
      response = await ports.saveSnapshot(state, expectedRevision);
    } catch (error) {
      if (ports.isRevisionConflict(error)) throw error;
      response = { data: null, error, status: 0 };
    }

    if (response.error && ports.isRevisionConflict(response.error)) {
      throw response.error;
    }
    if (response.error && response.status !== 0) throw response.error;
    if (response.error) {
      const ambiguousError = response.error;
      let verificationError: unknown;

      // From this point onward the compare-and-swap may already reference the
      // staged files. Retain them even if the account/scope boundary becomes
      // stale while the authoritative verification read is in flight.
      retainEvidence = true;
      try {
        ports.onPhase("connecting");
        const verification = await ports.fetchRemote(boundary.accountId);
        if (verification.error) {
          verificationError = verification.error;
        } else {
          const verifiedRow = remoteRow(verification.data);
          const verifiedRevision = ports.parseRevision(verifiedRow?.revision);
          if (
            verifiedRow
            && verifiedRevision !== null
            && verifiedRevision > expectedRevision
            && typeof verifiedRow.updated_at === "string"
          ) {
            const verifiedState = ports.migrateState(verifiedRow.state);
            if (ports.statesEqual(verifiedState, state)) {
              return {
                kind: "saved",
                remote: {
                  state: verifiedState,
                  revision: verifiedRevision,
                  updatedAt: verifiedRow.updated_at,
                  needsSave: false,
                  createdEvidence: [],
                },
              };
            }
          }
        }
      } catch (error) {
        verificationError = error;
      }

      // The request can still finish after an abort, and a later writer can
      // derive a new snapshot from the committed migration. Retaining staged
      // evidence is therefore the only safe response until a later full
      // reconciliation establishes the authoritative cloud state.
      return {
        kind: "ambiguous",
        error: ambiguousError,
        ...(verificationError === undefined ? {} : { verificationError }),
      };
    }

    const row = Array.isArray(response.data)
      ? remoteRow(response.data[0])
      : remoteRow(response.data);
    const revision = ports.parseRevision(row?.revision);
    if (!row || revision === null || typeof row.updated_at !== "string") {
      throw new Error("Private sync returned an invalid revision response.");
    }
    if (stagedEvidence.length) retainEvidence = true;
    return {
      kind: "saved",
      remote: {
        state: ports.migrateState(row.state),
        revision,
        updatedAt: row.updated_at,
        needsSave: false,
        createdEvidence: [],
      },
    };
  };

  const saveOrAmbiguousOutcome = async (
    state: TState,
    expectedRevision: number,
  ): Promise<
    | { readonly kind: "saved"; readonly remote: ProviderPreparedRemote<TState, TEvidence> }
    | Extract<ProviderReconciliationOutcome<TState, TEvidence>, { kind: "ambiguous-save" }>
  > => {
    const result = await save(state, expectedRevision);
    return result.kind === "saved"
      ? result
      : {
        kind: "ambiguous-save",
        error: result.error,
        ...(result.verificationError === undefined
          ? {}
          : { verificationError: result.verificationError }),
      };
  };

  try {
    const staleBeforeFetch = superseded(boundary, ports, "preflight");
    if (staleBeforeFetch) return staleBeforeFetch;

    ports.onPhase("connecting");
    const response = await ports.fetchRemote(boundary.accountId);
    const staleAfterFetch = superseded(boundary, ports, "fetch");
    if (staleAfterFetch) return staleAfterFetch;
    if (response.error) {
      return { kind: "remote-read-error", error: response.error };
    }

    const row = remoteRow(response.data);
    const initialLocal = ports.readLocal();
    const initialDecision = decideSyncReconciliation({
      remoteExists: Boolean(row?.state),
      remoteRevision: row?.revision,
      localRevision: initialLocal.revision,
      localDirty: initialLocal.dirty,
    });

    if (initialDecision.action === "upload-initial") {
      ports.onPhase("saving");
      const saveVersion = initialLocal.changeVersion;
      const saveResult = await saveOrAmbiguousOutcome(
        initialLocal.state,
        initialDecision.expectedRevision,
      );
      const staleAfterSave = superseded(boundary, ports, "save");
      if (staleAfterSave) return staleAfterSave;
      if (saveResult.kind === "ambiguous-save") return saveResult;
      const saved = saveResult.remote;
      return {
        kind: "saved-local",
        remote: saved,
        localUnchanged: ports.readLocal().changeVersion === saveVersion,
      };
    }

    if (initialDecision.action === "invalid-revision" || !row?.state) {
      return {
        kind: "invalid-revision",
        phase: "initial",
        source: initialDecision.action === "invalid-revision"
          ? initialDecision.source
          : "remote",
      };
    }

    const parsedRemoteRevision = ports.parseRevision(row.revision);
    if (parsedRemoteRevision === null) {
      return {
        kind: "invalid-revision",
        phase: "initial",
        source: "remote",
      };
    }
    if (boundary.persistenceGeneration === undefined) {
      throw new Error(
        "The account persistence scope changed before cloud reconciliation could begin.",
      );
    }

    let prepared: Awaited<ReturnType<typeof ports.prepareEvidence>>;
    try {
      prepared = await ports.prepareEvidence(
        ports.migrateState(row.state),
        boundary.persistenceAccountId,
        boundary.persistenceGeneration,
      );
    } catch (error) {
      const staleAfterPreparation = superseded(boundary, ports, "preparation");
      return staleAfterPreparation ?? { kind: "preparation-error", error };
    }
    stagedEvidence = prepared.createdEvidence;
    const staleAfterPreparation = superseded(boundary, ports, "preparation");
    if (staleAfterPreparation) return staleAfterPreparation;

    const remote: ProviderPreparedRemote<TState, TEvidence> = {
      state: prepared.state,
      revision: parsedRemoteRevision,
      updatedAt: typeof row.updated_at === "string"
        ? row.updated_at
        : ports.now(),
      needsSave: prepared.changed
        || ports.readStoredStateVersion(row.state) !== ports.currentStateVersion
        || !ports.statesEqual(row.state as TState, prepared.state),
      createdEvidence: prepared.createdEvidence,
    };
    const local = ports.readLocal();
    const decision = decideSyncReconciliation({
      remoteExists: true,
      remoteRevision: remote.revision,
      localRevision: local.revision,
      localDirty: local.dirty,
      localMatchesRemote: ports.statesEqual(local.state, remote.state),
    });

    if (decision.action === "invalid-revision") {
      await ports.rollbackEvidence(remote.createdEvidence);
      stagedEvidence = [];
      return {
        kind: "invalid-revision",
        phase: "prepared",
        source: decision.source,
      };
    }
    if (decision.action === "conflict") {
      retainEvidence = true;
      return { kind: "conflict", remote };
    }
    if (decision.action === "upload-local") {
      await ports.rollbackEvidence(remote.createdEvidence);
      stagedEvidence = [];
      ports.onPhase("saving");
      const saveVersion = local.changeVersion;
      const saveResult = await saveOrAmbiguousOutcome(
        local.state,
        decision.expectedRevision,
      );
      const staleAfterSave = superseded(boundary, ports, "save");
      if (staleAfterSave) return staleAfterSave;
      if (saveResult.kind === "ambiguous-save") return saveResult;
      const saved = saveResult.remote;
      return {
        kind: "saved-local",
        remote: saved,
        localUnchanged: ports.readLocal().changeVersion === saveVersion,
      };
    }
    if (decision.action === "acknowledge-remote") {
      // A migrated remote document may no longer contain its embedded bytes.
      // Return it to the provider first so the exact local envelope and staging
      // tokens can commit atomically. Only that durable local commit may enable
      // the later cloud autosave of stripped JSON.
      retainEvidence = true;
      return { kind: "acknowledged", remote };
    }
    if (decision.action === "use-remote" && remote.needsSave) {
      retainEvidence = true;
      return { kind: "adopt-remote", remote };
    }

    retainEvidence = true;
    return { kind: "adopt-remote", remote };
  } catch (error) {
    const staleAfterError = superseded(boundary, ports, "save");
    if (staleAfterError) return staleAfterError;
    return ports.isRevisionConflict(error)
      ? { kind: "revision-conflict", error }
      : { kind: "error", error };
  } finally {
    if (stagedEvidence.length && !retainEvidence) {
      await ports.rollbackEvidence(stagedEvidence);
    }
  }
}

export type ProviderAccountHandoffPlan =
  | {
    readonly kind: "ready";
    readonly handoff: AnonymousHandoffDecision;
    readonly source: Exclude<
      AccountHandoffSourceDecision,
      { action: "conflict" | "invalid-revision" }
    >;
  }
  | {
    readonly kind: "invalid-revision";
    readonly source: "local" | "remote";
  }
  | {
    readonly kind: "source-conflict";
    readonly localRevision: number;
    readonly remoteRevision: number;
  }
  | { readonly kind: "quarantined-account-missing-cloud" };

/**
 * Produces the source plan for an explicit anonymous-to-account handoff. No
 * copy, merge, or write begins until this plan is ready.
 */
export function planProviderAccountHandoff({
  choice,
  localExists,
  localDirty,
  localRevision,
  remoteExists,
  remoteRevision,
  targetWasQuarantined,
}: {
  readonly choice: AnonymousHandoffChoice;
  readonly localExists: boolean;
  readonly localDirty: boolean;
  readonly localRevision?: unknown;
  readonly remoteExists: boolean;
  readonly remoteRevision?: unknown;
  readonly targetWasQuarantined: boolean;
}): ProviderAccountHandoffPlan {
  const handoff = decideAnonymousHandoff(choice);
  const source = decideAccountHandoffSource({
    localExists,
    localDirty,
    localRevision,
    remoteExists,
    remoteRevision,
  });
  if (source.action === "invalid-revision") {
    return {
      kind: "invalid-revision",
      source: source.source,
    };
  }
  if (source.action === "conflict") {
    return {
      kind: "source-conflict",
      localRevision: source.localRevision,
      remoteRevision: source.remoteRevision,
    };
  }
  if (
    targetWasQuarantined
    && !remoteExists
    && handoff.action === "open-account"
  ) {
    return { kind: "quarantined-account-missing-cloud" };
  }
  return { kind: "ready", handoff, source };
}
