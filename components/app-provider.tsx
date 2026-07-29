"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppActionsProvider,
  ProviderStatusProvider,
  WorkspaceDataProvider,
  type AppActionsContextValue,
  type AppContextValue,
  type AnonymousWorkspaceHandoff,
  type LocalWorkspaceConflict,
  type ProviderStatusContextValue,
  type QuarantinedRecovery,
  type SyncConflict,
  type WorkspaceDataContextValue,
} from "@/components/app-context";
import { useProviderAuth } from "@/components/use-provider-auth";
import { EMPTY_STATE } from "@/lib/defaults";
import {
  adoptExistingAccountErasureFence,
  prepareAnonymousHandoffEvidenceCopies,
  settleOutgoingWorkspaceWrite,
} from "@/lib/provider-account-boundaries";
import {
  deleteGoalRecordsDraft,
  setGoalFileEvidenceDraft,
} from "@/lib/provider-domain-commands";
import {
  createProviderDomainActions,
  type ProviderDomainActions,
} from "@/lib/provider-command-bindings";
import {
  appendEvidenceBlobCopies,
  EvidenceCompensationError,
  rollbackEvidenceBlobJournal,
  type EvidenceBlobJournalEntry,
} from "@/lib/evidence-operation-journal";
import {
  createGoalEvidenceActions,
  type GoalEvidenceOperationScope,
} from "@/lib/provider-goal-evidence";
import {
  disableLocalBootstrapLegacyImport,
  LocalBootstrapSupersededError,
  observeLegacyWorkspace,
  runLocalWorkspaceBootstrap,
} from "@/lib/provider-local-bootstrap";
import {
  workspaceNoticeForActiveAccount,
  type SyncStatus,
} from "@/lib/provider-selectors";
import {
  externalizeEmbeddedEvidence,
  externalizeWorkspaceHistory,
  portableWorkspaceState,
  rollbackEvidenceWrites,
  rollbackExternalizedEvidence,
  type StagedEvidenceWrite,
} from "@/lib/provider-evidence";
import {
  adoptAuthoritativeWorkspaceState,
  cloneWorkspaceValue,
  runNonUndoableWorkspaceMutation,
  runUndoableWorkspaceMutation,
  trimWorkspaceHistory,
  workspaceStatesEqual,
} from "@/lib/provider-state";
import {
  captureLegacyWorkspaceImport,
  commitLegacyWorkspaceImport,
  deleteAccountPersistence,
  deleteEvidenceBlob,
  disableLegacyWorkspaceImport,
  eraseAccountPersistenceWithTombstone,
  listEvidenceBlobs,
  readEvidenceBlob,
  readAccountPersistenceScope,
  readRawWorkspace,
  readWorkspaceWithScope,
  replaceWorkspaceAfterRecoveryChoice,
  storeEvidenceBlob,
  writeWorkspace,
  AccountPersistenceScopeError,
  LocalWorkspaceConflictError,
  PersistenceError,
  type AccountPersistenceScope,
  type PersistenceScopeGeneration,
  type WorkspaceEnvelope,
  LEGACY_WORKSPACE_STORAGE_KEY,
  workspaceKey,
} from "@/lib/persistence";
import { LEGACY_LAST_REMINDER_KEY, reminderStorageKey } from "@/lib/reminders";
import {
  CURRENT_STATE_VERSION,
  migrateStoredState,
  parseImportedState,
  UnsupportedStoredWorkspaceVersionError,
  WorkspaceImportError,
} from "@/lib/state-schema";
import {
  getSupabase,
  saveWorkspaceSnapshotWithDeadline,
  supabaseConfigured,
} from "@/lib/supabase";
import {
  canWriteCloud,
  canPersistWorkspaceAutomatically,
  decideAccountHandoffSource,
  decideAccountSwitch,
  decideAnonymousHandoff,
  decideConflictResolution,
  decideRemoteMigrationCompletion,
  decideSyncReconciliation,
  hasMeaningfulWorkspace,
  isWorkspaceRevisionConflict,
  nextWorkspaceScopeKey,
  parseWorkspaceRevision,
  persistenceAccountId,
  type WorkspaceScopeEvent,
} from "@/lib/sync-reconciliation";
import type {
  AppState,
  GoalFileEvidence,
} from "@/lib/types";
import {
  createWorkspaceOperationCoordinator,
  WorkspaceOperationStartRejectedError,
} from "@/lib/workspace-operation-coordinator";
import {
  INITIAL_WORKSPACE_SCOPE_KEY,
  incrementWorkspaceScopeKey,
  type WorkspaceScopeKey,
} from "@/lib/workspace-scope";
import {
  mergeAnonymousWorkspace,
  workspaceMergeFileEvidenceCopies,
  type WorkspaceFileEvidenceCopy,
} from "@/lib/workspace-merge";

interface PendingAnonymousHandoff {
  accountId: string;
}

interface RemoteSnapshot {
  state: AppState;
  revision: number;
  updatedAt: string;
  needsSave: boolean;
  createdEvidence: StagedEvidenceWrite[];
}

export { remoteEvidencePath } from "@/lib/provider-evidence";
export { workspaceStatesEqual } from "@/lib/provider-state";
export {
  useApp,
  useAppActions,
  useProviderStatus,
  useWorkspaceData,
} from "@/components/app-context";

const clone = cloneWorkspaceValue;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const [workspaceScopeKey, setWorkspaceScopeKey] = useState(INITIAL_WORKSPACE_SCOPE_KEY);
  const [persistenceScopeGeneration, setPersistenceScopeGeneration] = useState<PersistenceScopeGeneration>(0);
  const [terminalErasureAccountId, setTerminalErasureAccountId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(supabaseConfigured ? "connecting" : "local");
  const [canUndo, setCanUndo] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [localWorkspaceConflict, setLocalWorkspaceConflict] = useState<LocalWorkspaceConflict | null>(null);
  const [quarantinedRecovery, setQuarantinedRecovery] = useState<QuarantinedRecovery | null>(null);
  const [syncConflict, setSyncConflict] = useState<SyncConflict | null>(null);
  const [accountHandoff, setAccountHandoff] = useState<AnonymousWorkspaceHandoff | null>(null);
  const [cloudWriteAllowed, setCloudWriteAllowed] = useState(false);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const [metadataEpoch, setMetadataEpoch] = useState(0);
  const [localPersistenceEpoch, setLocalPersistenceEpoch] = useState(0);
  const [workspaceOperations] = useState(createWorkspaceOperationCoordinator);
  const history = useRef<AppState[]>([]);
  const authenticatedUserId = useRef<string | null>(null);
  const remoteLoaded = useRef(false);
  const reconciledAccount = useRef<string | null>(null);
  const activeAccount = useRef<string | null>(null);
  const accountSwitching = useRef(false);
  const cloudSaveAccount = useRef<string | null>(null);
  const reconciliationAccount = useRef<string | null>(null);
  const reconciliationPending = useRef(false);
  const terminalErasureAccount = useRef<string | null>(null);
  const localChangeVersion = useRef(0);
  const workspaceGeneration = useRef(INITIAL_WORKSPACE_SCOPE_KEY);
  const workspaceScopeKeyRef = useRef(INITIAL_WORKSPACE_SCOPE_KEY);
  const revision = useRef(0);
  const serverUpdatedAt = useRef<string | undefined>(undefined);
  const dirty = useRef(false);
  const localPersistencePending = useRef<{
    accountId: string;
    changeVersion: number;
  } | null>(null);
  const remoteConflict = useRef<RemoteSnapshot | null>(null);
  const pendingAccountHandoff = useRef<PendingAnonymousHandoff | null>(null);
  const quarantinedAccounts = useRef(new Set<string>());
  const localConflictAccounts = useRef(new Set<string>());
  const expectedLocalRevisions = useRef(new Map<string, number>());
  const persistenceScopeGenerations = useRef(new Map<string, PersistenceScopeGeneration>());
  const localWriteQueues = useRef(new Map<string, Promise<void>>());
  const recoveryNotice = useRef<string | null>(null);
  const latestState = useRef(state);

  const observeAuthBoundary = useCallback((observedAccountId: string | null) => {
    if (activeAccount.current !== observedAccountId) {
      accountSwitching.current = true;
      setWorkspaceSwitching(true);
    }
    setCloudWriteAllowed(false);
    authenticatedUserId.current = observedAccountId;
  }, []);

  const {
    user,
    resolved: authResolved,
    bootstrapError: authBootstrapError,
    signIn,
    signOutSession,
    forgetObservedAccount,
  } = useProviderAuth(undefined, observeAuthBoundary);

  const advanceWorkspaceScope = useCallback((event: WorkspaceScopeEvent) => {
    const next = nextWorkspaceScopeKey(workspaceScopeKeyRef.current, event);
    workspaceScopeKeyRef.current = next;
    setWorkspaceScopeKey(next);
  }, []);

  const runWorkspaceFileOperation = useCallback(<T,>(
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
    operation: () => T | PromiseLike<T>,
  ) => workspaceOperations.run(
    expectedWorkspaceScopeKey,
    operation,
    () => expectedWorkspaceScopeKey === workspaceScopeKeyRef.current
      && !accountSwitching.current
      && terminalErasureAccount.current === null,
  ), [workspaceOperations]);

  const reportPersistenceError = useCallback((message: string) => {
    setPersistenceError(message);
  }, []);

  const localPersistenceIsPending = useCallback(() => {
    const pending = localPersistencePending.current;
    return pending !== null
      && pending.accountId === persistenceAccountId(activeAccount.current)
      && pending.changeVersion === localChangeVersion.current;
  }, []);

  const markCloudChangesPending = useCallback(() => {
    if (
      remoteConflict.current
      || pendingAccountHandoff.current
      || terminalErasureAccount.current !== null
    ) return;
    localPersistencePending.current = {
      accountId: persistenceAccountId(activeAccount.current),
      changeVersion: localChangeVersion.current,
    };
    setSyncStatus((current) => (
      current === "error" || current === "conflict" ? current : "persisting"
    ));
  }, []);

  const accountIsQuarantined = useCallback((accountId: string) =>
    quarantinedAccounts.current.has(accountId)
      || localConflictAccounts.current.has(accountId), []);

  const quarantineLocalConflict = useCallback((error: LocalWorkspaceConflictError) => {
    localConflictAccounts.current.add(error.accountId);
    quarantinedAccounts.current.add(error.accountId);
    setCloudWriteAllowed(false);
    remoteLoaded.current = false;
    reconciledAccount.current = null;
    setSyncStatus("error");
    const message = "This workspace changed in another tab. Evolvra stopped device and cloud autosaves so neither copy can silently overwrite the other.";
    setPersistenceError(message);
    setLocalWorkspaceConflict({ accountId: error.accountId, message });
  }, []);

  const persistWorkspace = useCallback((
    envelope: Omit<WorkspaceEnvelope, "localRevision">,
  ): Promise<WorkspaceEnvelope> => {
    const accountId = envelope.accountId;
    const scopeGeneration = persistenceScopeGenerations.current.get(accountId);
    if (scopeGeneration === undefined) {
      return Promise.reject(new Error("The account persistence scope has not been loaded."));
    }
    const previous = localWriteQueues.current.get(accountId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (localConflictAccounts.current.has(accountId)) {
        throw new Error("This workspace is quarantined after a change in another tab. Reload before saving again.");
      }
      const saved = await writeWorkspace({
        ...envelope,
        localRevision: expectedLocalRevisions.current.get(accountId) ?? 0,
      }, scopeGeneration);
      expectedLocalRevisions.current.set(accountId, saved.localRevision);
      return saved;
    }).catch((error: unknown) => {
      if (error instanceof LocalWorkspaceConflictError) quarantineLocalConflict(error);
      if (error instanceof AccountPersistenceScopeError) {
        quarantinedAccounts.current.add(error.accountId);
        if (
          error.code === "erasure-fenced"
          && error.accountId === persistenceAccountId(activeAccount.current)
        ) {
          terminalErasureAccount.current = error.accountId;
          setTerminalErasureAccountId(error.accountId);
          accountSwitching.current = true;
          setWorkspaceSwitching(true);
          setCloudWriteAllowed(false);
          remoteLoaded.current = false;
          reconciledAccount.current = null;
        }
        setPersistenceError(error.message);
      }
      throw error;
    });
    const tail = operation.then(() => undefined, () => undefined);
    localWriteQueues.current.set(accountId, tail);
    void tail.finally(() => {
      if (localWriteQueues.current.get(accountId) === tail) {
        localWriteQueues.current.delete(accountId);
      }
    });
    return operation;
  }, [quarantineLocalConflict]);

  const readTrackedWorkspace = useCallback(async (accountId: string) => {
    await localWriteQueues.current.get(accountId);
    try {
      const result = await readWorkspaceWithScope(accountId);
      expectedLocalRevisions.current.set(accountId, result.workspace?.localRevision ?? 0);
      persistenceScopeGenerations.current.set(accountId, result.scope.generation);
      return result;
    } catch (error) {
      // Invalid workspace bytes must not prevent the provider from learning the
      // generation that fences all subsequent recovery or erase operations.
      try {
        const scope = await readAccountPersistenceScope(accountId);
        persistenceScopeGenerations.current.set(accountId, scope.generation);
      } catch {
        // Preserve the original read failure; it is the actionable error.
      }
      throw error;
    }
  }, []);

  const captureQuarantinedRecovery = useCallback(async (
    accountId: string,
    message: string,
    fallbackRawJson?: string,
  ) => {
    let rawJson: string | undefined;
    try {
      const raw = await readRawWorkspace(accountId);
      if (raw !== null) rawJson = JSON.stringify(raw, null, 2);
    } catch {
      // The durable warning and erase/import choices remain available even if
      // the damaged structured-clone value cannot be represented as JSON.
    }
    setQuarantinedRecovery({
      accountId,
      message,
      ...(rawJson || fallbackRawJson ? { rawJson: rawJson ?? fallbackRawJson } : {}),
    });
  }, []);

  useEffect(() => {
    latestState.current = state;
  }, [state]);

  const adoptRemoteWorkspace = useCallback((authoritativeState: AppState) => {
    const transition = adoptAuthoritativeWorkspaceState(authoritativeState);
    const stateChanged = !workspaceStatesEqual(latestState.current, transition.state);
    history.current = transition.history;
    setCanUndo(false);
    latestState.current = transition.state;
    if (stateChanged) {
      setState(transition.state);
      advanceWorkspaceScope("remote-adoption");
    }
  }, [advanceWorkspaceScope]);

  useEffect(() => {
    setCloudWriteAllowed(canWriteCloud({
      authenticatedAccountId: user?.id ?? null,
      activeAccountId: activeAccount.current,
      reconciledAccountId: reconciledAccount.current,
      remoteLoaded: remoteLoaded.current,
      accountSwitching: accountSwitching.current,
      hasConflict: Boolean(syncConflict),
      handoffPending: Boolean(pendingAccountHandoff.current),
      accountQuarantined: accountIsQuarantined(
        persistenceAccountId(activeAccount.current),
      ),
    }));
  }, [accountEpoch, accountHandoff, accountIsQuarantined, metadataEpoch, state, syncConflict, syncStatus, user]);

  useEffect(() => {
    let cancelled = false;
    const initialScopeKey = workspaceScopeKeyRef.current;
    const anonymousAccountId = persistenceAccountId(null);
    const legacy = observeLegacyWorkspace(
      () => localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY),
    );
    const ensureCurrent = () => {
      if (cancelled || initialScopeKey !== workspaceScopeKeyRef.current) {
        throw new LocalBootstrapSupersededError();
      }
    };
    const clearObservedLegacySource = () => {
      try {
        const current = localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY);
        if (current === legacy.raw) {
          localStorage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY);
        } else if (current !== null) {
          setPersistenceError(
            "An obsolete browser copy changed while the current workspace was opening. "
            + "It was left untouched; close older Evolvra tabs before continuing.",
          );
        }
      } catch (error) {
        setPersistenceError(error instanceof Error
          ? `Your workspace was migrated safely, but the obsolete browser copy could not be removed: ${error.message}`
          : "Your workspace was migrated safely, but the obsolete browser copy could not be removed.");
      }
    };
    const load = async () => {
      const result = await runLocalWorkspaceBootstrap({
        accountId: anonymousAccountId,
        legacy,
        ensureCurrent,
      }, {
        readWorkspace: readTrackedWorkspace,
        readRawWorkspace,
        captureLegacyWorkspaceImport,
        commitLegacyWorkspaceImport,
        persistWorkspace: async ({ envelope, expectedScopeGeneration }) => {
          ensureCurrent();
          if (
            persistenceScopeGenerations.current.get(envelope.accountId)
            !== expectedScopeGeneration
          ) {
            throw new LocalBootstrapSupersededError();
          }
          return persistWorkspace(envelope);
        },
        externalizeEmbeddedEvidence: ({ state: nextState, accountId, expectedScopeGeneration }) =>
          externalizeEmbeddedEvidence(nextState, accountId, expectedScopeGeneration),
        externalizeWorkspaceHistory: ({
          state: nextState,
          history: nextHistory,
          accountId,
          expectedScopeGeneration,
        }) => externalizeWorkspaceHistory(
          nextState,
          [...nextHistory],
          accountId,
          expectedScopeGeneration,
        ),
        rollbackExternalizedEvidence,
        now: () => new Date().toISOString(),
      });
      if (result.kind === "superseded" || cancelled) return;
      ensureCurrent();
      if (result.scope) {
        persistenceScopeGenerations.current.set(
          result.accountId,
          result.scope.generation,
        );
        setPersistenceScopeGeneration(result.scope.generation);
      }

      if (result.kind === "loaded") {
        const envelope = result.envelope;
        setQuarantinedRecovery(null);
        recoveryNotice.current = result.recoveryNotice ?? null;
        if (result.recoveryNotice) setPersistenceError(result.recoveryNotice);
        latestState.current = envelope.state;
        setState(envelope.state);
        history.current = [...envelope.history];
        setCanUndo(history.current.length > 0);
        dirty.current = envelope.dirty;
        revision.current = envelope.revision;
        serverUpdatedAt.current = envelope.serverUpdatedAt;
      } else if (result.kind === "quarantined") {
        quarantinedAccounts.current.add(result.accountId);
        setQuarantinedRecovery({
          accountId: result.accountId,
          message: result.message,
          ...(result.rawJson ? { rawJson: result.rawJson } : {}),
        });
        setPersistenceError(result.error instanceof Error
          ? result.error.message
          : result.message);
      } else if (result.kind === "failed") {
        setPersistenceError(result.error instanceof Error
          ? result.error.message
          : result.message);
      }
      if (result.legacySourceCanBeCleared) clearObservedLegacySource();
      setReady(true);
    };
    void workspaceOperations.run(
      initialScopeKey,
      load,
      () => !cancelled && initialScopeKey === workspaceScopeKeyRef.current,
    ).catch((error: unknown) => {
      if (
        !(error instanceof WorkspaceOperationStartRejectedError)
        && !(error instanceof LocalBootstrapSupersededError)
        && !cancelled
      ) {
        setPersistenceError(error instanceof Error
          ? error.message
          : "Saved data could not be prepared safely.");
        setReady(true);
      }
    });
    return () => { cancelled = true; };
  }, [persistWorkspace, readTrackedWorkspace, workspaceOperations]);

  useEffect(() => {
    if (
      !ready
      || !authResolved
      || accountSwitching.current
      || terminalErasureAccount.current !== null
    ) return;
    const accountId = persistenceAccountId(activeAccount.current);
    // A fresh or explicitly erased workspace should remain absent on disk until
    // the person starts onboarding or restores data. Otherwise the empty render
    // immediately recreates the record they just erased.
    if (!state.profile.onboarded && !dirty.current) return;
    if (!canPersistWorkspaceAutomatically(accountIsQuarantined(accountId))) return;
    if (
      accountSwitching.current
      || !canPersistWorkspaceAutomatically(accountIsQuarantined(accountId))
    ) return;
    const envelope: Omit<WorkspaceEnvelope, "localRevision"> = {
      accountId,
      state,
      history: trimWorkspaceHistory(history.current),
      dirty: dirty.current,
      revision: revision.current,
      serverUpdatedAt: serverUpdatedAt.current,
      savedAt: new Date().toISOString(),
    };
    const persistedChangeVersion = localChangeVersion.current;
    void persistWorkspace(envelope)
      .then(() => {
        try {
          localStorage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY);
        } catch {
          // IndexedDB is now authoritative; an inaccessible legacy key is harmless.
        }
        if (!recoveryNotice.current) setPersistenceError(null);
        if (
          localChangeVersion.current === persistedChangeVersion
          && persistenceAccountId(activeAccount.current) === accountId
        ) {
          const pending = localPersistencePending.current;
          if (
            pending?.accountId !== accountId
            || pending.changeVersion !== persistedChangeVersion
          ) return;
          localPersistencePending.current = null;
          setLocalPersistenceEpoch((value) => value + 1);
          if (authenticatedUserId.current === activeAccount.current) {
            setSyncStatus((current) => {
              if (current === "error" || current === "conflict") return current;
              if (authenticatedUserId.current === null) return "local";
              if (typeof navigator !== "undefined" && navigator.onLine === false) {
                return "offline";
              }
              return dirty.current ? "unsaved" : "synced";
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (error instanceof LocalWorkspaceConflictError) return;
        if (
          localChangeVersion.current === persistedChangeVersion
          && persistenceAccountId(activeAccount.current) === accountId
        ) {
          const pending = localPersistencePending.current;
          if (
            pending?.accountId === accountId
            && pending.changeVersion === persistedChangeVersion
          ) {
            localPersistencePending.current = null;
            if (authenticatedUserId.current === activeAccount.current) {
              setSyncStatus("error");
            }
          }
        }
        setPersistenceError(error instanceof Error ? error.message : "This change is still open in memory but could not be saved on this device.");
      });
  }, [accountIsQuarantined, authResolved, metadataEpoch, persistWorkspace, ready, state]);

  const observedAuthAccountId = user?.id ?? null;
  useEffect(() => {
    if (!authResolved) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const abortingPendingHandoff = observedAuthAccountId === null
        && activeAccount.current === null
        && pendingAccountHandoff.current !== null;

      if (authBootstrapError) {
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        pendingAccountHandoff.current = null;
        setAccountHandoff(null);
        setSyncStatus("error");
        setPersistenceError(authBootstrapError);
        return;
      }

      if (observedAuthAccountId === null) {
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        pendingAccountHandoff.current = null;
        setAccountHandoff(null);
        setSyncStatus("local");
        if (abortingPendingHandoff) {
          accountSwitching.current = false;
          setWorkspaceSwitching(false);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [authBootstrapError, authResolved, observedAuthAccountId]);

  useEffect(() => {
    if (!ready || !authResolved || terminalErasureAccount.current !== null) return;
    const nextAccount = user?.id ?? null;
    if (activeAccount.current === nextAccount) return;
    let cancelled = false;
    const generation = workspaceGeneration.current;
    const outgoingScopeKey = workspaceScopeKeyRef.current;
    accountSwitching.current = true;
    setWorkspaceSwitching(true);
    setCloudWriteAllowed(false);
    remoteLoaded.current = false;
    reconciledAccount.current = null;
    const abandonedRemoteConflict = remoteConflict.current;
    pendingAccountHandoff.current = null;
    setSyncConflict(null);
    setAccountHandoff(null);
    const switchAccount = async () => {
      let stagedDestinationEvidence: Awaited<ReturnType<typeof externalizeWorkspaceHistory>> | null = null;
      let stagedEvidenceCommitted = false;
      try {
        if (abandonedRemoteConflict && remoteConflict.current === abandonedRemoteConflict) {
          await rollbackEvidenceWrites(abandonedRemoteConflict.createdEvidence);
          remoteConflict.current = null;
        }
        const previousAccountId = activeAccount.current;
        if (cancelled || generation !== workspaceGeneration.current) return;
        const switchStartVersion = localChangeVersion.current;
        const previousEnvelope: Omit<WorkspaceEnvelope, "localRevision"> = {
          accountId: persistenceAccountId(previousAccountId),
          state: latestState.current,
          history: trimWorkspaceHistory(history.current),
          dirty: dirty.current,
          revision: revision.current,
          serverUpdatedAt: serverUpdatedAt.current,
          savedAt: new Date().toISOString(),
        };
        const persistOutgoingEnvelope = (envelope: Omit<WorkspaceEnvelope, "localRevision">) =>
          settleOutgoingWorkspaceWrite(envelope.accountId, () => persistWorkspace(envelope));
        let outgoingWorkspaceConflicted = false;
        if (
          (previousEnvelope.state.profile.onboarded || previousEnvelope.dirty)
          && canPersistWorkspaceAutomatically(accountIsQuarantined(previousEnvelope.accountId))
        ) {
          outgoingWorkspaceConflicted = await persistOutgoingEnvelope(previousEnvelope)
            === "conflicted";
        }
        if (cancelled || generation !== workspaceGeneration.current) return;
        const nextPersistenceAccountId = persistenceAccountId(nextAccount);
        const destination = await readTrackedWorkspace(nextPersistenceAccountId);
        const envelope = destination.workspace;
        if (cancelled || generation !== workspaceGeneration.current) return;
        setQuarantinedRecovery(null);
        if (destination.scope.tombstoned) {
          const emptyState = clone(EMPTY_STATE);
          terminalErasureAccount.current = nextPersistenceAccountId;
          setTerminalErasureAccountId(nextPersistenceAccountId);
          activeAccount.current = nextAccount;
          setPersistenceScopeGeneration(destination.scope.generation);
          localChangeVersion.current += 1;
          history.current = [];
          dirty.current = false;
          revision.current = 0;
          serverUpdatedAt.current = undefined;
          latestState.current = emptyState;
          recoveryNotice.current = null;
          setState(emptyState);
          advanceWorkspaceScope("account-switch");
          setCanUndo(false);
          setPersistenceError("This account is fenced for deletion. Evolvra is keeping every workspace writer closed while cleanup resumes.");
          setSyncStatus("error");
          return;
        }
        const decision = decideAccountSwitch({
          previousAccountId,
          nextAccountId: nextAccount,
          nextWorkspaceExists: Boolean(envelope),
          anonymousWorkspaceMeaningful: previousAccountId === null
            && hasMeaningfulWorkspace(latestState.current, EMPTY_STATE),
          anonymousHandoffAcknowledged: previousAccountId === null
            && !outgoingWorkspaceConflicted
            && envelope?.anonymousHandoff !== undefined
            && envelope.anonymousHandoff.generation
              === persistenceScopeGenerations.current.get(persistenceAccountId(null))
            && envelope.anonymousHandoff.localRevision
              === (expectedLocalRevisions.current.get(persistenceAccountId(null)) ?? 0),
        });
        if (decision.action === "request-anonymous-consent" && nextAccount) {
          if (
            localChangeVersion.current !== switchStartVersion
            && canPersistWorkspaceAutomatically(accountIsQuarantined(decision.sourceAccountId))
          ) {
            await persistOutgoingEnvelope({
              accountId: decision.sourceAccountId,
              state: latestState.current,
              history: trimWorkspaceHistory(history.current),
              dirty: dirty.current,
              revision: revision.current,
              serverUpdatedAt: serverUpdatedAt.current,
              savedAt: new Date().toISOString(),
            });
            if (cancelled || generation !== workspaceGeneration.current) return;
          }
          const anonymousState = latestState.current;
          pendingAccountHandoff.current = { accountId: nextAccount };
          setCloudWriteAllowed(false);
          setAccountHandoff({
            anonymousUpdatedAt: anonymousState.updatedAt,
            goalCount: anonymousState.goals.length,
            activityCount: anonymousState.questCompletions.length
              + anonymousState.metricEntries.length
              + anonymousState.reviews.length
              + anonymousState.timeline.length,
          });
          setSyncStatus("conflict");
          return;
        }
        let nextState = clone(EMPTY_STATE);
        let nextHistory: AppState[] = [];
        let nextDirty = false;
        let nextRevision = 0;
        let nextServerUpdatedAt: string | undefined;
        let nextRecoveryMessage: string | null = null;
        if (decision.action === "load-existing" && envelope) {
          if (envelope.recovery) {
            nextRecoveryMessage = envelope.recovery.message;
          }
          const recovered = await externalizeWorkspaceHistory(
            migrateStoredState(envelope.state),
            trimWorkspaceHistory(envelope.history.map((item) => migrateStoredState(item))),
            envelope.accountId,
            destination.scope.generation,
          );
          stagedDestinationEvidence = recovered;
          if (cancelled || generation !== workspaceGeneration.current) return;
          nextState = recovered.state;
          nextHistory = recovered.history;
          nextDirty = envelope.recovery?.source === "history"
            ? false
            : envelope.dirty || recovered.changed;
          nextRevision = envelope.revision;
          nextServerUpdatedAt = envelope.serverUpdatedAt;
        }

        // Keep the displayed account authoritative until the destination has
        // been completely prepared. This prevents a rapid A -> B -> C switch
        // from ever writing A's still-visible state into B's storage slot.
        if (localChangeVersion.current !== switchStartVersion) {
          const refreshedPreviousEnvelope: Omit<WorkspaceEnvelope, "localRevision"> = {
            accountId: persistenceAccountId(previousAccountId),
            state: latestState.current,
            history: trimWorkspaceHistory(history.current),
            dirty: dirty.current,
            revision: revision.current,
            serverUpdatedAt: serverUpdatedAt.current,
            savedAt: new Date().toISOString(),
          };
          if (
            (refreshedPreviousEnvelope.state.profile.onboarded || refreshedPreviousEnvelope.dirty)
            && canPersistWorkspaceAutomatically(accountIsQuarantined(refreshedPreviousEnvelope.accountId))
          ) {
            await persistOutgoingEnvelope(refreshedPreviousEnvelope);
          }
          if (cancelled || generation !== workspaceGeneration.current) return;
        }

        activeAccount.current = nextAccount;
        setPersistenceScopeGeneration(destination.scope.generation);
        localChangeVersion.current += 1;
        history.current = nextHistory;
        dirty.current = nextDirty;
        revision.current = nextRevision;
        serverUpdatedAt.current = nextServerUpdatedAt;
        latestState.current = nextState;
        recoveryNotice.current = nextRecoveryMessage;
        setPersistenceError(nextRecoveryMessage);
        setState(nextState);
        stagedEvidenceCommitted = Boolean(stagedDestinationEvidence);
        advanceWorkspaceScope("account-switch");
        setCanUndo(nextHistory.length > 0);
        setSyncStatus(accountIsQuarantined(nextPersistenceAccountId)
          ? "error"
          : nextAccount ? "connecting" : "local");
      } catch (error) {
        if (cancelled || generation !== workspaceGeneration.current) return;
        const emptyState = clone(EMPTY_STATE);
        const nextPersistenceAccountId = persistenceAccountId(nextAccount);
        const message = error instanceof Error ? error.message : "This account's local workspace could not be read, so a safe empty copy was opened.";
        setQuarantinedRecovery(null);
        if (
          (error instanceof PersistenceError && error.code === "invalid-data")
          || error instanceof UnsupportedStoredWorkspaceVersionError
        ) {
          quarantinedAccounts.current.add(nextPersistenceAccountId);
          await captureQuarantinedRecovery(nextPersistenceAccountId, message);
        }
        activeAccount.current = nextAccount;
        localChangeVersion.current += 1;
        history.current = [];
        dirty.current = false;
        revision.current = 0;
        serverUpdatedAt.current = undefined;
        latestState.current = emptyState;
        recoveryNotice.current = null;
        setState(emptyState);
        advanceWorkspaceScope("account-switch");
        setCanUndo(false);
        setPersistenceError(message);
        setSyncStatus("error");
      } finally {
        if (stagedDestinationEvidence && !stagedEvidenceCommitted) {
          await rollbackExternalizedEvidence(stagedDestinationEvidence);
        }
        if (cancelled || generation !== workspaceGeneration.current) return;
        const transitionPending = pendingAccountHandoff.current !== null
          || terminalErasureAccount.current !== null;
        accountSwitching.current = transitionPending;
        setWorkspaceSwitching(transitionPending);
        setAccountEpoch((value) => value + 1);
      }
    };
    void workspaceOperations.run(
      outgoingScopeKey,
      switchAccount,
      () => !cancelled
        && generation === workspaceGeneration.current
        && outgoingScopeKey === workspaceScopeKeyRef.current
        && activeAccount.current !== nextAccount,
    ).catch((error: unknown) => {
      if (error instanceof WorkspaceOperationStartRejectedError) return;
      if (!cancelled && generation === workspaceGeneration.current) {
        accountSwitching.current = false;
        setWorkspaceSwitching(false);
        setPersistenceError(error instanceof Error
          ? `The account switch could not finish compensation safely: ${error.message}`
          : "The account switch could not finish compensation safely.");
        setSyncStatus("error");
      }
    });
    return () => { cancelled = true; };
  }, [accountIsQuarantined, advanceWorkspaceScope, authResolved, captureQuarantinedRecovery, persistWorkspace, readTrackedWorkspace, ready, user?.id, workspaceOperations]);

  useEffect(() => {
    const supabase = getSupabase();
    if (
      !supabase
      || !user
      || remoteLoaded.current
      || !ready
      || !authResolved
      || accountSwitching.current
      || terminalErasureAccount.current !== null
      || pendingAccountHandoff.current
      || activeAccount.current !== user.id
      || accountIsQuarantined(persistenceAccountId(user.id))
    ) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return;
    }
    if (reconciliationAccount.current === user.id) {
      reconciliationPending.current = true;
      return;
    }
    const syncAccountId = user.id;
    const generation = workspaceGeneration.current;
    const reconciliationScopeKey = workspaceScopeKeyRef.current;
    reconciliationAccount.current = syncAccountId;
    const isCurrentAccount = () => generation === workspaceGeneration.current
      && activeAccount.current === syncAccountId
      && !pendingAccountHandoff.current
      && !accountSwitching.current
      && !localConflictAccounts.current.has(persistenceAccountId(syncAccountId));
    const saveSnapshot = async (snapshot: AppState, expectedRevision: number) => {
      const { data, error } = await saveWorkspaceSnapshotWithDeadline(
        supabase,
        snapshot,
        expectedRevision,
      );
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const savedRevision = parseWorkspaceRevision(row?.revision);
      if (!row || savedRevision === null || typeof row.updated_at !== "string") throw new Error("Private sync returned an invalid revision response.");
      return {
        state: migrateStoredState(row.state),
        revision: savedRevision,
        updatedAt: row.updated_at,
        needsSave: false,
        createdEvidence: [],
      } satisfies RemoteSnapshot;
    };
    const finishSave = (
      saved: RemoteSnapshot,
      saveVersion: number,
      stateToAdopt?: AppState,
    ) => {
      if (!isCurrentAccount()) return;
      const localUnchanged = localChangeVersion.current === saveVersion;
      revision.current = saved.revision;
      serverUpdatedAt.current = saved.updatedAt;
      remoteLoaded.current = true;
      reconciledAccount.current = syncAccountId;
      if (stateToAdopt && localUnchanged) {
        adoptRemoteWorkspace(stateToAdopt);
      }
      if (localUnchanged) dirty.current = false;
      setMetadataEpoch((value) => value + 1);
      setSyncStatus(localUnchanged ? "synced" : "saving");
    };
    const reconcile = async () => {
      let stagedRemoteEvidence: StagedEvidenceWrite[] = [];
      let retainRemoteEvidence = false;
      try {
        if (
          !isCurrentAccount()
          || reconciliationScopeKey !== workspaceScopeKeyRef.current
        ) return;
        setSyncStatus("connecting");
        const { data, error } = await supabase
          .from("workspace_snapshots")
          .select("state,revision,updated_at")
          .eq("user_id", syncAccountId)
          .maybeSingle();
        if (!isCurrentAccount()) return;
        if (error) {
          setSyncStatus("error");
          return;
        }

        const initialDecision = decideSyncReconciliation({
          remoteExists: Boolean(data?.state),
          remoteRevision: data?.revision,
          localRevision: revision.current,
          localDirty: dirty.current,
        });
        if (initialDecision.action === "upload-initial") {
          setSyncStatus("saving");
          const saveVersion = localChangeVersion.current;
          const saved = await saveSnapshot(latestState.current, initialDecision.expectedRevision);
          finishSave(saved, saveVersion);
          return;
        }

        if (initialDecision.action === "invalid-revision" || !data?.state) {
          setSyncStatus("error");
          setPersistenceError(`Private sync returned an invalid ${initialDecision.action === "invalid-revision" ? initialDecision.source : "remote"} workspace revision. Your device copy has not been overwritten.`);
          return;
        }

        const parsedRemoteRevision = parseWorkspaceRevision(data.revision);
        if (parsedRemoteRevision === null) return;
        const syncPersistenceGeneration = persistenceScopeGenerations.current.get(
          persistenceAccountId(syncAccountId),
        );
        if (syncPersistenceGeneration === undefined) {
          throw new Error("The account persistence scope changed before cloud reconciliation could begin.");
        }
        let recovered: Awaited<ReturnType<typeof externalizeEmbeddedEvidence>>;
        try {
          recovered = await externalizeEmbeddedEvidence(
            migrateStoredState(data.state),
            persistenceAccountId(syncAccountId),
            syncPersistenceGeneration,
          );
        } catch (error) {
          if (isCurrentAccount()) {
            if (error instanceof UnsupportedStoredWorkspaceVersionError) {
              quarantinedAccounts.current.add(persistenceAccountId(syncAccountId));
              remoteLoaded.current = false;
              reconciledAccount.current = null;
              setCloudWriteAllowed(false);
              setPersistenceError("This cloud workspace was created by a newer Evolvra version. Update the app before syncing so that newer data is not overwritten.");
            } else if (error instanceof WorkspaceImportError) {
              quarantinedAccounts.current.add(persistenceAccountId(syncAccountId));
              remoteLoaded.current = false;
              reconciledAccount.current = null;
              setCloudWriteAllowed(false);
              setPersistenceError("This cloud workspace failed structural validation and was quarantined. Your validated device copy was not overwritten.");
            } else {
              setPersistenceError("A legacy evidence file could not be moved into protected file storage. Export a backup before retrying sync.");
            }
            setSyncStatus("error");
          }
          return;
        }
        stagedRemoteEvidence = recovered.createdEvidence;
        if (!isCurrentAccount()) return;

        const remote: RemoteSnapshot = {
          state: recovered.state,
          revision: parsedRemoteRevision,
          updatedAt: typeof data.updated_at === "string" ? data.updated_at : new Date().toISOString(),
          needsSave: recovered.changed
            || (data.state as { version?: unknown }).version !== CURRENT_STATE_VERSION
            || !workspaceStatesEqual(data.state as unknown as AppState, recovered.state),
          createdEvidence: recovered.createdEvidence,
        };
        const decision = decideSyncReconciliation({
          remoteExists: true,
          remoteRevision: remote.revision,
          localRevision: revision.current,
          localDirty: dirty.current,
          localMatchesRemote: workspaceStatesEqual(latestState.current, remote.state),
        });

        if (decision.action === "invalid-revision") {
          await rollbackEvidenceWrites(remote.createdEvidence);
          stagedRemoteEvidence = [];
          setSyncStatus("error");
          setPersistenceError(`Private sync found an invalid ${decision.source} workspace revision. Your device copy has not been overwritten.`);
          return;
        }
        if (decision.action === "conflict") {
          retainRemoteEvidence = true;
          remoteConflict.current = remote;
          setCloudWriteAllowed(false);
          setSyncConflict({
            remoteUpdatedAt: remote.updatedAt,
            localUpdatedAt: latestState.current.updatedAt,
          });
          setSyncStatus("conflict");
          return;
        }
        if (decision.action === "upload-local") {
          await rollbackEvidenceWrites(remote.createdEvidence);
          stagedRemoteEvidence = [];
          setSyncStatus("saving");
          const saveVersion = localChangeVersion.current;
          const saved = await saveSnapshot(latestState.current, decision.expectedRevision);
          finishSave(saved, saveVersion);
          return;
        }
        if (decision.action === "acknowledge-remote") {
          let acknowledgedRemote = remote;
          if (remote.needsSave) {
            setSyncStatus("saving");
            const saveVersion = localChangeVersion.current;
            const saved = await saveSnapshot(remote.state, remote.revision);
            if (!isCurrentAccount()) return;
            acknowledgedRemote = {
              ...saved,
              createdEvidence: remote.createdEvidence,
            };
            if (
              decideRemoteMigrationCompletion(saveVersion, localChangeVersion.current)
              === "conflict"
            ) {
              retainRemoteEvidence = true;
              remoteLoaded.current = false;
              reconciledAccount.current = null;
              remoteConflict.current = acknowledgedRemote;
              setCloudWriteAllowed(false);
              setSyncConflict({
                remoteUpdatedAt: acknowledgedRemote.updatedAt,
                localUpdatedAt: latestState.current.updatedAt,
              });
              setSyncStatus("conflict");
              return;
            }
          }
          revision.current = acknowledgedRemote.revision;
          serverUpdatedAt.current = acknowledgedRemote.updatedAt;
          remoteLoaded.current = true;
          reconciledAccount.current = syncAccountId;
          dirty.current = false;
          retainRemoteEvidence = true;
          setMetadataEpoch((value) => value + 1);
          setSyncStatus("synced");
          return;
        }
        if (decision.action === "use-remote" && remote.needsSave) {
          setSyncStatus("saving");
          const saveVersion = localChangeVersion.current;
          const saved = await saveSnapshot(remote.state, remote.revision);
          if (!isCurrentAccount()) return;
          if (
            decideRemoteMigrationCompletion(saveVersion, localChangeVersion.current)
            === "conflict"
          ) {
            const concurrentRemote: RemoteSnapshot = {
              ...saved,
              createdEvidence: remote.createdEvidence,
            };
            retainRemoteEvidence = true;
            remoteLoaded.current = false;
            reconciledAccount.current = null;
            remoteConflict.current = concurrentRemote;
            setCloudWriteAllowed(false);
            setSyncConflict({
              remoteUpdatedAt: concurrentRemote.updatedAt,
              localUpdatedAt: latestState.current.updatedAt,
            });
            setSyncStatus("conflict");
            return;
          }
          finishSave(saved, saveVersion, remote.state);
          retainRemoteEvidence = true;
          return;
        }
        if (decision.action === "use-remote") {
          revision.current = remote.revision;
          serverUpdatedAt.current = remote.updatedAt;
          remoteLoaded.current = true;
          reconciledAccount.current = syncAccountId;
          adoptRemoteWorkspace(remote.state);
          retainRemoteEvidence = true;
          setMetadataEpoch((value) => value + 1);
          setSyncStatus("synced");
        }
      } catch (error) {
        if (!isCurrentAccount()) return;
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        setCloudWriteAllowed(false);
        if (error instanceof UnsupportedStoredWorkspaceVersionError) {
          quarantinedAccounts.current.add(persistenceAccountId(syncAccountId));
          setPersistenceError("Private sync returned a workspace created by a newer Evolvra version. No device or cloud data was overwritten.");
          setSyncStatus("error");
          return;
        }
        if (error instanceof WorkspaceImportError) {
          quarantinedAccounts.current.add(persistenceAccountId(syncAccountId));
          setPersistenceError("Private sync returned a structurally invalid workspace. It was quarantined and no device or cloud data was overwritten.");
          setSyncStatus("error");
          return;
        }
        if (isWorkspaceRevisionConflict(error)) {
          setAccountEpoch((value) => value + 1);
          setSyncStatus("connecting");
        } else {
          setPersistenceError(error instanceof Error
            ? `Private sync could not finish: ${error.message}`
            : "Private sync could not finish. Your device copy remains available.");
          setSyncStatus("error");
        }
      } finally {
        if (stagedRemoteEvidence.length && !retainRemoteEvidence) {
          await rollbackEvidenceWrites(stagedRemoteEvidence);
        }
      }
    };
    void workspaceOperations.run(
      reconciliationScopeKey,
      reconcile,
      () => isCurrentAccount()
        && reconciliationScopeKey === workspaceScopeKeyRef.current,
    ).catch((error: unknown) => {
      if (error instanceof WorkspaceOperationStartRejectedError) return;
      if (isCurrentAccount()) {
        setCloudWriteAllowed(false);
        setPersistenceError(error instanceof Error
          ? `Private sync could not finish compensation safely: ${error.message}`
          : "Private sync could not finish compensation safely.");
        setSyncStatus("error");
      }
    }).finally(() => {
      if (reconciliationAccount.current === syncAccountId) {
        reconciliationAccount.current = null;
      }
      if (reconciliationPending.current) {
        reconciliationPending.current = false;
        setAccountEpoch((value) => value + 1);
      }
    });
  }, [accountEpoch, accountIsQuarantined, adoptRemoteWorkspace, authResolved, ready, user, workspaceOperations]);

  useEffect(() => {
    const supabase = getSupabase();
    const authenticatedAccountId = user?.id ?? null;
    if (
      !supabase
      || !user
      || !ready
      || !authResolved
      || !dirty.current
      || localPersistenceIsPending()
      || !canWriteCloud({
        authenticatedAccountId,
        activeAccountId: activeAccount.current,
        reconciledAccountId: reconciledAccount.current,
        remoteLoaded: remoteLoaded.current,
        accountSwitching: accountSwitching.current,
        hasConflict: Boolean(syncConflict),
        handoffPending: Boolean(pendingAccountHandoff.current),
        accountQuarantined: accountIsQuarantined(
          persistenceAccountId(activeAccount.current),
        ),
      })
    ) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return;
    }
    const syncAccountId = user.id;
    const generation = workspaceGeneration.current;
    const cloudSaveScopeKey = workspaceScopeKeyRef.current;
    const cloudSaveCanStart = () => (
      generation === workspaceGeneration.current
      && cloudSaveScopeKey === workspaceScopeKeyRef.current
      && cloudSaveAccount.current !== syncAccountId
      && !localPersistenceIsPending()
      && canWriteCloud({
        authenticatedAccountId: syncAccountId,
        activeAccountId: activeAccount.current,
        reconciledAccountId: reconciledAccount.current,
        remoteLoaded: remoteLoaded.current,
        accountSwitching: accountSwitching.current,
        hasConflict: Boolean(remoteConflict.current),
        handoffPending: Boolean(pendingAccountHandoff.current),
        accountQuarantined: accountIsQuarantined(
          persistenceAccountId(activeAccount.current),
        ),
      })
    );
    const timer = window.setTimeout(() => {
      void workspaceOperations.run(cloudSaveScopeKey, async () => {
        if (!cloudSaveCanStart()) return;

        cloudSaveAccount.current = syncAccountId;
        const saveVersion = localChangeVersion.current;
        const expectedRevision = revision.current;
        setSyncStatus("saving");
        try {
          const { data, error } = await saveWorkspaceSnapshotWithDeadline(
            supabase,
            state,
            expectedRevision,
          );
          const accountStillCurrent = generation === workspaceGeneration.current
            && cloudSaveScopeKey === workspaceScopeKeyRef.current
            && activeAccount.current === syncAccountId
            && reconciledAccount.current === syncAccountId
            && !accountSwitching.current
            && !localConflictAccounts.current.has(persistenceAccountId(syncAccountId));
          if (!accountStillCurrent) return;
          if (error) {
            remoteLoaded.current = false;
            reconciledAccount.current = null;
            setCloudWriteAllowed(false);
            setSyncStatus(isWorkspaceRevisionConflict(error) ? "conflict" : "error");
            setAccountEpoch((value) => value + 1);
            return;
          }
          const row = Array.isArray(data) ? data[0] : data;
          const savedRevision = parseWorkspaceRevision(row?.revision);
          if (!row || savedRevision === null || typeof row.updated_at !== "string") {
            remoteLoaded.current = false;
            reconciledAccount.current = null;
            setCloudWriteAllowed(false);
            setPersistenceError("Private sync saved an unexpected response. Your device copy is still marked as unsaved.");
            setSyncStatus("error");
            return;
          }
          const localUnchanged = localChangeVersion.current === saveVersion;
          revision.current = savedRevision;
          serverUpdatedAt.current = row.updated_at;
          if (localUnchanged) dirty.current = false;
          setMetadataEpoch((value) => value + 1);
          setSyncStatus(localUnchanged ? "synced" : "saving");
        } catch {
          const accountStillCurrent = generation === workspaceGeneration.current
            && cloudSaveScopeKey === workspaceScopeKeyRef.current
            && activeAccount.current === syncAccountId
            && reconciledAccount.current === syncAccountId
            && !accountSwitching.current
            && !localConflictAccounts.current.has(persistenceAccountId(syncAccountId));
          if (accountStillCurrent) {
            remoteLoaded.current = false;
            reconciledAccount.current = null;
            setCloudWriteAllowed(false);
            // A lost RPC response is ambiguous: the server may have committed
            // the snapshot even though the browser never received a response.
            // Re-read the remote revision once so a concurrent write becomes
            // an explicit conflict and a transient transport failure can
            // recover without waiting for another local mutation.
            setSyncStatus("connecting");
            setAccountEpoch((value) => value + 1);
          }
        } finally {
          if (cloudSaveAccount.current === syncAccountId) {
            cloudSaveAccount.current = null;
            if (dirty.current) setMetadataEpoch((value) => value + 1);
          }
        }
      }, cloudSaveCanStart).catch((error: unknown) => {
        if (error instanceof WorkspaceOperationStartRejectedError) return;
        setPersistenceError(error instanceof Error
          ? `Private sync could not enter the workspace save barrier: ${error.message}`
          : "Private sync could not enter the workspace save barrier.");
        setSyncStatus("error");
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [accountIsQuarantined, authResolved, localPersistenceEpoch, localPersistenceIsPending, metadataEpoch, ready, state, syncConflict, user, workspaceOperations]);

  useEffect(() => {
    if (!user) return;
    const requestReconciliation = () => {
      if (
        accountSwitching.current
        || cloudSaveAccount.current === user.id
        || remoteConflict.current
        || pendingAccountHandoff.current
        || localConflictAccounts.current.has(persistenceAccountId(user.id))
      ) return;
      remoteLoaded.current = false;
      reconciledAccount.current = null;
      setCloudWriteAllowed(false);
      setAccountEpoch((value) => value + 1);
    };
    const refreshCleanWorkspace = () => {
      if (!dirty.current) requestReconciliation();
    };
    const reconnect = () => {
      if (localPersistenceIsPending()) {
        setSyncStatus("persisting");
        return;
      }
      setSyncStatus("connecting");
      requestReconciliation();
    };
    const disconnect = () => {
      if (
        activeAccount.current === user.id
        && !pendingAccountHandoff.current
        && !remoteConflict.current
        && terminalErasureAccount.current === null
      ) {
        setSyncStatus((current) => (
          localPersistenceIsPending() || current === "persisting"
            ? "persisting"
            : "offline"
        ));
      }
    };
    window.addEventListener("focus", refreshCleanWorkspace);
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", disconnect);
    if (navigator.onLine === false) disconnect();
    return () => {
      window.removeEventListener("focus", refreshCleanWorkspace);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", disconnect);
    };
  }, [localPersistenceIsPending, user]);

  const mutate = useCallback((recipe: (draft: AppState) => void) => {
    if (terminalErasureAccount.current !== null) {
      throw new Error("This account is being erased and no longer accepts workspace changes.");
    }
    const current = latestState.current;
    const transition = runUndoableWorkspaceMutation(current, history.current, recipe);
    if (recoveryNotice.current) {
      recoveryNotice.current = null;
      setPersistenceError(null);
    }
    dirty.current = true;
    localChangeVersion.current += 1;
    history.current = transition.history;
    latestState.current = transition.state;
    setCanUndo(true);
    setState(transition.state);
    markCloudChangesPending();
  }, [markCloudChangesPending]);

  const mutateWithoutUndo = useCallback((recipe: (draft: AppState) => void) => {
    if (terminalErasureAccount.current !== null) {
      throw new Error("This account is being erased and no longer accepts workspace changes.");
    }
    const transition = runNonUndoableWorkspaceMutation(latestState.current, recipe);
    if (recoveryNotice.current) {
      recoveryNotice.current = null;
      setPersistenceError(null);
    }
    dirty.current = true;
    localChangeVersion.current += 1;
    history.current = transition.history;
    latestState.current = transition.state;
    setCanUndo(false);
    setState(transition.state);
    markCloudChangesPending();
  }, [markCloudChangesPending]);

  const boundDomainActions = () => createProviderDomainActions({ mutate });
  const domainActions: ProviderDomainActions = {
    completeOnboarding: (...args) => boundDomainActions().completeOnboarding(...args),
    addGoal: (...args) => boundDomainActions().addGoal(...args),
    updateGoal: (...args) => {
      if (!latestState.current.goals.some((item) => item.id === args[0])) return;
      boundDomainActions().updateGoal(...args);
    },
    setGoalStatus: (...args) => boundDomainActions().setGoalStatus(...args),
    addQuest: (...args) => {
      if (!latestState.current.goals.some((item) => item.id === args[0])) return;
      boundDomainActions().addQuest(...args);
    },
    completeQuest: (...args) => boundDomainActions().completeQuest(...args),
    toggleMilestone: (...args) => boundDomainActions().toggleMilestone(...args),
    updateMetric: (...args) => boundDomainActions().updateMetric(...args),
    addCheckIn: (...args) => boundDomainActions().addCheckIn(...args),
    addReview: (...args) => boundDomainActions().addReview(...args),
    upsertArea: (...args) => boundDomainActions().upsertArea(...args),
    reorderAreas: (...args) => boundDomainActions().reorderAreas(...args),
    removeArea: (...args) => boundDomainActions().removeArea(...args),
    upsertStat: (...args) => boundDomainActions().upsertStat(...args),
    reorderStats: (...args) => boundDomainActions().reorderStats(...args),
    removeStat: (...args) => boundDomainActions().removeStat(...args),
    updateSettings: (...args) => boundDomainActions().updateSettings(...args),
    updateProfile: (...args) => boundDomainActions().updateProfile(...args),
  };

  const replaceWorkspaceInMemory = useCallback((nextState: AppState, nextHistory: AppState[]) => {
    dirty.current = true;
    localChangeVersion.current += 1;
    history.current = trimWorkspaceHistory(nextHistory.map(clone));
    latestState.current = clone(nextState);
    setCanUndo(history.current.length > 0);
    setState(latestState.current);
    markCloudChangesPending();
  }, [markCloudChangesPending]);

  /** Durably save metadata before a caller removes or moves evidence bytes. */
  const flushWorkspaceDurably = useCallback(async (expectedScopeKey: WorkspaceScopeKey) => {
    const scopeIsCurrent = () => expectedScopeKey === workspaceScopeKeyRef.current
      && workspaceOperations.isActive(expectedScopeKey)
      && !accountSwitching.current;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!scopeIsCurrent()) throw new Error("The active workspace changed before metadata could be saved.");
      const accountId = persistenceAccountId(activeAccount.current);
      if (accountIsQuarantined(accountId)) {
        throw new Error("This workspace is quarantined. Resolve or erase the saved copy before changing file metadata.");
      }
      const snapshot = clone(latestState.current);
      const snapshotHistory = trimWorkspaceHistory(history.current.map(clone));
      const changeVersion = localChangeVersion.current;
      dirty.current = true;
      await persistWorkspace({
        accountId,
        state: snapshot,
        history: snapshotHistory,
        dirty: true,
        revision: revision.current,
        serverUpdatedAt: serverUpdatedAt.current,
        savedAt: new Date().toISOString(),
      });
      if (!scopeIsCurrent()) throw new Error("The active workspace changed while metadata was being saved.");
      if (changeVersion !== localChangeVersion.current) continue;

      const cloudAccountId = activeAccount.current;
      if (!cloudAccountId) return;
      if (!user || user.id !== cloudAccountId || !cloudWriteAllowed) {
        throw new Error("Private cloud reconciliation must finish before file metadata can be committed.");
      }
      const supabase = getSupabase();
      if (!supabase) throw new Error("Cloud storage is unavailable.");
      setSyncStatus("saving");
      const { data, error } = await saveWorkspaceSnapshotWithDeadline(
        supabase,
        snapshot,
        revision.current,
      );
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const savedRevision = parseWorkspaceRevision(row?.revision);
      if (!row || savedRevision === null || typeof row.updated_at !== "string") {
        throw new Error("Private sync returned an invalid revision while saving file metadata.");
      }
      const savedState = migrateStoredState(row.state);
      if (!workspaceStatesEqual(savedState, snapshot)) {
        throw new Error("Private sync did not return the exact file metadata snapshot that was submitted.");
      }
      revision.current = savedRevision;
      serverUpdatedAt.current = row.updated_at;
      if (changeVersion !== localChangeVersion.current) {
        dirty.current = true;
        continue;
      }
      dirty.current = false;
      await persistWorkspace({
        accountId,
        state: snapshot,
        history: snapshotHistory,
        dirty: false,
        revision: savedRevision,
        serverUpdatedAt: row.updated_at,
        savedAt: new Date().toISOString(),
      });
      remoteLoaded.current = true;
      reconciledAccount.current = cloudAccountId;
      setMetadataEpoch((value) => value + 1);
      setSyncStatus("synced");
      return;
    }
    throw new Error("The workspace kept changing while file metadata was being saved. No file bytes were removed.");
  }, [accountIsQuarantined, cloudWriteAllowed, persistWorkspace, user, workspaceOperations]);

  const captureGoalEvidenceScope = (
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ): GoalEvidenceOperationScope => {
    const accountId = persistenceAccountId(activeAccount.current);
    const generation = persistenceScopeGenerations.current.get(accountId);
    if (generation === undefined) {
      throw new Error("The account persistence scope has not been loaded.");
    }
    return {
      workspaceScopeKey: expectedWorkspaceScopeKey,
      workspaceGeneration: workspaceGeneration.current,
      persistenceAccountId: accountId,
      persistenceGeneration: generation,
      authenticatedAccountId: authenticatedUserId.current,
    };
  };

  const goalEvidenceActions = () => createGoalEvidenceActions({
    metadata: {
      readGoalEvidence: (goalId) =>
        latestState.current.goals.find((item) => item.id === goalId)?.evidence,
      captureWorkspace: () => ({
        state: clone(latestState.current),
        history: trimWorkspaceHistory(history.current.map(clone)),
      }),
      setGoalFileEvidence: (goalId, evidence) => {
        const safeEvidence = clone([...evidence]);
        mutateWithoutUndo((draft) =>
          setGoalFileEvidenceDraft(draft, goalId, safeEvidence));
      },
      deleteGoalRecords: (goalId) => {
        mutateWithoutUndo((draft) => deleteGoalRecordsDraft(draft, goalId));
      },
      restoreWorkspace: ({ state: restoredState, history: restoredHistory }) => {
        replaceWorkspaceInMemory(restoredState, [...restoredHistory]);
      },
      flushDurably: (scope) => flushWorkspaceDurably(scope.workspaceScopeKey),
    },
    scope: {
      isCurrent: (scope) => (
        scope.workspaceScopeKey === workspaceScopeKeyRef.current
        && scope.workspaceGeneration === workspaceGeneration.current
        && scope.persistenceAccountId === persistenceAccountId(activeAccount.current)
        && scope.persistenceGeneration
          === persistenceScopeGenerations.current.get(scope.persistenceAccountId)
        && scope.authenticatedAccountId === authenticatedUserId.current
        && workspaceOperations.isActive(scope.workspaceScopeKey)
        && !accountSwitching.current
        && terminalErasureAccount.current === null
      ),
      runExclusive: (scope, operation) => runWorkspaceFileOperation(
        scope.workspaceScopeKey,
        operation,
      ),
    },
    localEvidence: {
      list: (accountId, goalId, generation) =>
        listEvidenceBlobs(accountId, goalId, generation),
      remove: (snapshot, generation) => deleteEvidenceBlob(
        snapshot.accountId,
        snapshot.goalId,
        snapshot.evidenceId,
        generation,
      ),
      restore: async (snapshot, generation) => {
        await storeEvidenceBlob(snapshot, generation);
      },
    },
    remoteEvidence: {
      assertWriteAllowed: () => {
        if (!cloudWriteAllowed) {
          throw new Error("Finish the pending workspace or sync choice before deleting cloud evidence.");
        }
      },
      download: async (path) => {
        const bucket = getSupabase()?.storage.from("evidence");
        if (!bucket) throw new Error("Cloud storage is unavailable.");
        const { data, error } = await bucket.download(path);
        if (error || !data) {
          throw error ?? new Error("A private evidence file could not be captured before deletion.");
        }
        return data;
      },
      remove: async (paths) => {
        if (!paths.length) return;
        const bucket = getSupabase()?.storage.from("evidence");
        if (!bucket) throw new Error("Cloud storage is unavailable.");
        const { error } = await bucket.remove([...paths]);
        if (error) throw error;
      },
      restore: async (snapshot) => {
        const bucket = getSupabase()?.storage.from("evidence");
        if (!bucket) throw new Error("Cloud storage is unavailable.");
        const { error } = await bucket.upload(snapshot.path, snapshot.blob, {
          contentType: snapshot.blob.type,
          upsert: true,
        });
        if (error) throw error;
      },
    },
  });

  const activePersistenceAccountId = persistenceAccountId(user?.id ?? null);
  const visibleLocalWorkspaceConflict = workspaceNoticeForActiveAccount(
    localWorkspaceConflict,
    activePersistenceAccountId,
    workspaceSwitching,
  );
  const visibleQuarantinedRecovery = workspaceNoticeForActiveAccount(
    quarantinedRecovery,
    activePersistenceAccountId,
    workspaceSwitching,
  );

  const value: AppContextValue = {
      state,
      ready: ready && authResolved,
      workspaceSwitching,
      workspaceScopeKey,
      persistenceScopeGeneration,
      terminalErasureAccountId,
      user,
      syncStatus,
      cloudEnabled: supabaseConfigured,
      cloudWriteAllowed,
      persistenceError,
      localWorkspaceConflict: visibleLocalWorkspaceConflict,
      quarantinedRecovery: visibleQuarantinedRecovery,
      syncConflict,
      accountHandoff,
      canUndo,
      runWorkspaceFileOperation,
      reportPersistenceError,
      ...domainActions,
      async setGoalFileEvidence(goalId, evidence, expectedWorkspaceScopeKey) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        await goalEvidenceActions().setGoalFileEvidence({
          goalId,
          evidence,
          scope,
        });
      },
      async deleteGoal(goalId) {
        const scope = captureGoalEvidenceScope(workspaceScopeKeyRef.current);
        await goalEvidenceActions().deleteGoal({ goalId, scope });
      },
      async importState(imported) {
        if (accountSwitching.current) {
          throw new Error("Wait for the active workspace to finish opening before importing a backup.");
        }
        const importAccount = activeAccount.current;
        const importAuthenticatedAccount = authenticatedUserId.current;
        const generation = workspaceGeneration.current;
        const importScopeKey = workspaceScopeKeyRef.current;
        const importAccountId = persistenceAccountId(importAccount);
        const importPersistenceGeneration = persistenceScopeGenerations.current.get(importAccountId);
        if (importPersistenceGeneration === undefined) {
          throw new Error("The account persistence scope has not been loaded.");
        }
        let migrated: Awaited<ReturnType<typeof externalizeEmbeddedEvidence>> | null = null;
        let metadataCommitted = false;
        accountSwitching.current = true;
        setWorkspaceSwitching(true);
        setCloudWriteAllowed(false);
        try {
          await workspaceOperations.run(importScopeKey, async () => {
            try {
              await localWriteQueues.current.get(importAccountId);
              if (
                generation !== workspaceGeneration.current
                || activeAccount.current !== importAccount
                || authenticatedUserId.current !== importAuthenticatedAccount
                || workspaceScopeKeyRef.current !== importScopeKey
              ) {
                throw new Error("The active account changed during import. No workspace data was replaced.");
              }
              migrated = await externalizeEmbeddedEvidence(
                portableWorkspaceState(parseImportedState(imported)),
                importAccountId,
                importPersistenceGeneration,
              );
              if (
                generation !== workspaceGeneration.current
                || activeAccount.current !== importAccount
                || authenticatedUserId.current !== importAuthenticatedAccount
                || workspaceScopeKeyRef.current !== importScopeKey
              ) {
                throw new Error("The active account changed during import. No workspace data was replaced.");
              }
              const nextHistory = trimWorkspaceHistory([
                ...history.current,
                clone(latestState.current),
              ]);
              const nextState = { ...migrated.state, updatedAt: new Date().toISOString() };
              const replacementEnvelope: Omit<WorkspaceEnvelope, "localRevision"> = {
                accountId: importAccountId,
                state: nextState,
                history: nextHistory,
                dirty: true,
                revision: revision.current,
                serverUpdatedAt: serverUpdatedAt.current,
                savedAt: new Date().toISOString(),
              };
              const saved = quarantinedAccounts.current.has(importAccountId)
                ? await replaceWorkspaceAfterRecoveryChoice(
                    replacementEnvelope,
                    importPersistenceGeneration,
                  )
                : await persistWorkspace(replacementEnvelope);
              expectedLocalRevisions.current.set(importAccountId, saved.localRevision);
              metadataCommitted = true;
              if (
                generation !== workspaceGeneration.current
                || activeAccount.current !== importAccount
                || authenticatedUserId.current !== importAuthenticatedAccount
                || workspaceScopeKeyRef.current !== importScopeKey
              ) {
                throw new Error("The backup was restored to the previous account, but the active account changed before it could be opened.");
              }
              history.current = nextHistory;
              quarantinedAccounts.current.delete(importAccountId);
              setQuarantinedRecovery(null);
              setPersistenceError(null);
              dirty.current = true;
              localChangeVersion.current += 1;
              setCanUndo(nextHistory.length > 0);
              latestState.current = nextState;
              setState(nextState);
              advanceWorkspaceScope("import");
            } finally {
              if (migrated && !metadataCommitted) {
                await rollbackExternalizedEvidence(migrated);
              }
            }
          }, () => generation === workspaceGeneration.current
            && activeAccount.current === importAccount
            && authenticatedUserId.current === importAuthenticatedAccount
            && workspaceScopeKeyRef.current === importScopeKey);
        } finally {
          if (
            generation === workspaceGeneration.current
            && activeAccount.current === importAccount
            && authenticatedUserId.current === importAuthenticatedAccount
          ) {
            accountSwitching.current = false;
            setWorkspaceSwitching(false);
            setAccountEpoch((value) => value + 1);
          }
        }
      },
      async adoptActiveAccountErasure(expectedAccountId, tombstonedGeneration) {
        const target = workspaceKey(expectedAccountId);
        if (target === persistenceAccountId(null)) {
          throw new Error("Anonymous workspace reset does not use the connected-account erasure fence.");
        }
        if (
          terminalErasureAccount.current !== null
          && terminalErasureAccount.current !== target
        ) {
          throw new Error("Another account already owns the terminal erasure barrier.");
        }
        if (
          activeAccount.current !== target
          || authenticatedUserId.current !== target
        ) {
          throw new Error("Only the exact active signed-in account can adopt this deletion fence.");
        }

        const outgoingScopeKey = workspaceScopeKeyRef.current;
        const generationWasAlreadyAdopted =
          terminalErasureAccount.current === target
          && persistenceScopeGenerations.current.get(target) === tombstonedGeneration;
        try {
          const scope = await adoptExistingAccountErasureFence({
            expectedAccountId: target,
            tombstonedGeneration,
            closeWriterBarrier: () => {
              terminalErasureAccount.current = target;
              setTerminalErasureAccountId(target);
              accountSwitching.current = true;
              setWorkspaceSwitching(true);
              setCloudWriteAllowed(false);
              remoteLoaded.current = false;
              reconciledAccount.current = null;
              pendingAccountHandoff.current = null;
              setAccountHandoff(null);
            },
            drainWriters: async () => {
              await workspaceOperations.retire(outgoingScopeKey);
              await localWriteQueues.current.get(target);
              if (
                terminalErasureAccount.current !== target
                || activeAccount.current !== target
                || authenticatedUserId.current !== target
                || workspaceScopeKeyRef.current !== outgoingScopeKey
              ) {
                throw new Error("The exact signed-in account changed before its deletion fence could be adopted.");
              }
            },
          });
          if (
            terminalErasureAccount.current !== target
            || activeAccount.current !== target
            || authenticatedUserId.current !== target
            || workspaceScopeKeyRef.current !== outgoingScopeKey
          ) {
            throw new Error("The exact signed-in account changed while its deletion fence was being adopted.");
          }
          persistenceScopeGenerations.current.set(target, scope.generation);
          setPersistenceScopeGeneration(scope.generation);
          if (!generationWasAlreadyAdopted) {
            workspaceGeneration.current = incrementWorkspaceScopeKey(
              workspaceGeneration.current,
            );
          }
          setPersistenceError("This account is fenced for deletion. Evolvra is keeping every workspace writer closed while cleanup resumes.");
          setSyncStatus("error");
          return scope;
        } catch (error) {
          // Adoption uncertainty is terminal. The writer barrier intentionally
          // remains closed until a later exact-account recovery can prove the
          // durable tombstone and generation.
          setPersistenceError(error instanceof Error
            ? error.message
            : "The exact account deletion fence could not be adopted safely.");
          setSyncStatus("error");
          throw error;
        }
      },
      async beginActiveAccountErasure(expectedAccountId, armFence) {
        const target = workspaceKey(expectedAccountId);
        if (target === persistenceAccountId(null)) {
          throw new Error("Anonymous workspace reset does not use the connected-account erasure fence.");
        }
        if (
          terminalErasureAccount.current !== null
          && terminalErasureAccount.current !== target
        ) {
          throw new Error("Another account already owns the terminal erasure barrier.");
        }
        if (
          activeAccount.current !== target
          || authenticatedUserId.current !== target
          || accountSwitching.current
        ) {
          throw new Error("The exact signed-in account is not stable enough to begin erasure.");
        }
        const expectedPersistenceGeneration = persistenceScopeGenerations.current.get(target);
        if (expectedPersistenceGeneration === undefined) {
          throw new Error("The account persistence scope has not been loaded.");
        }

        const outgoingScopeKey = workspaceScopeKeyRef.current;
        // Close every writer before the first await. Retirement rejects all old
        // scope admissions synchronously and then drains their finalizers.
        terminalErasureAccount.current = target;
        setTerminalErasureAccountId(target);
        accountSwitching.current = true;
        setWorkspaceSwitching(true);
        setCloudWriteAllowed(false);
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        pendingAccountHandoff.current = null;
        setAccountHandoff(null);
        setSyncStatus("saving");
        try {
          await workspaceOperations.retire(outgoingScopeKey);
          await localWriteQueues.current.get(target);
          if (
            terminalErasureAccount.current !== target
            || activeAccount.current !== target
            || authenticatedUserId.current !== target
            || workspaceScopeKeyRef.current !== outgoingScopeKey
          ) {
            throw new Error("The exact signed-in account changed before its erasure fence was armed.");
          }
          const scope = await armFence(expectedPersistenceGeneration);
          if (
            scope.accountId !== target
            || !scope.tombstoned
            || scope.generation <= expectedPersistenceGeneration
          ) {
            throw new Error("Account erasure did not return the exact permanent persistence fence.");
          }
          persistenceScopeGenerations.current.set(target, scope.generation);
          setPersistenceScopeGeneration(scope.generation);
          workspaceGeneration.current = incrementWorkspaceScopeKey(
            workspaceGeneration.current,
          );
          setPersistenceError(null);
          return scope;
        } catch (error) {
          // A successful atomic fence may have been followed by a response
          // failure. Refresh its durable state, but never reopen this account.
          try {
            const scope = await readAccountPersistenceScope(target);
            persistenceScopeGenerations.current.set(target, scope.generation);
            setPersistenceScopeGeneration(scope.generation);
          } catch {
            // The original failure remains the useful diagnostic.
          }
          setPersistenceError(error instanceof Error
            ? error.message
            : "The account erasure fence could not be armed safely.");
          setSyncStatus("error");
          throw error;
        }
      },
      async finishActiveAccountErasure(
        expectedAccountId,
        tombstonedGeneration,
        clearSession,
      ) {
        const target = workspaceKey(expectedAccountId);
        if (
          target === persistenceAccountId(null)
          || terminalErasureAccount.current !== target
          || activeAccount.current !== target
          || authenticatedUserId.current !== target
          || persistenceScopeGenerations.current.get(target) !== tombstonedGeneration
        ) {
          throw new Error("The terminal erasure callback no longer belongs to the exact active account.");
        }

        const cleanupErrors: unknown[] = [];
        let sessionWarning: string | null = null;
        try {
          await workspaceOperations.retire(workspaceScopeKeyRef.current);
          await localWriteQueues.current.get(target);
          await eraseAccountPersistenceWithTombstone(target, tombstonedGeneration);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          // Old builds stored an account-linked delivery marker here. Failure
          // is reported; it is never silently labelled as complete cleanup.
          localStorage.removeItem(reminderStorageKey(target));
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          sessionWarning = await clearSession();
        } catch (error) {
          sessionWarning = error instanceof Error
            ? `The account data cleanup ran, but this tab could not clear its expired sign-in session: ${error.message}`
            : "The account data cleanup ran, but this tab could not clear its expired sign-in session.";
        }

        // The auth callback may arrive later. Force the provider away from the
        // terminal account while the writer barrier is still closed.
        authenticatedUserId.current = null;
        forgetObservedAccount(expectedAccountId);
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        cloudSaveAccount.current = null;
        reconciliationAccount.current = null;
        reconciliationPending.current = false;
        remoteConflict.current = null;
        pendingAccountHandoff.current = null;
        setCloudWriteAllowed(false);
        setSyncConflict(null);
        setAccountHandoff(null);

        const anonymousAccountId = persistenceAccountId(null);
        let nextState = clone(EMPTY_STATE);
        let nextHistory: AppState[] = [];
        let nextDirty = false;
        let nextRevision = 0;
        let nextServerUpdatedAt: string | undefined;
        let nextRecoveryMessage: string | null = null;
        let anonymousGeneration = persistenceScopeGenerations.current.get(
          anonymousAccountId,
        ) ?? 0;
        let stagedAnonymousEvidence: Awaited<ReturnType<typeof externalizeWorkspaceHistory>> | null = null;
        let stagedAnonymousEvidenceCommitted = false;
        try {
          const anonymous = await readTrackedWorkspace(anonymousAccountId);
          anonymousGeneration = anonymous.scope.generation;
          if (anonymous.scope.tombstoned) {
            throw new Error("The anonymous workspace persistence scope is unexpectedly fenced.");
          }
          if (anonymous.workspace) {
            const envelope = anonymous.workspace;
            const recovered = await externalizeWorkspaceHistory(
              migrateStoredState(envelope.state),
              trimWorkspaceHistory(envelope.history.map((item) => migrateStoredState(item))),
              anonymousAccountId,
              anonymousGeneration,
            );
            stagedAnonymousEvidence = recovered;
            nextState = recovered.state;
            nextHistory = recovered.history;
            nextDirty = envelope.recovery?.source === "history"
              ? false
              : envelope.dirty || recovered.changed;
            nextRevision = envelope.revision;
            nextServerUpdatedAt = envelope.serverUpdatedAt;
            nextRecoveryMessage = envelope.recovery?.message ?? null;
            stagedAnonymousEvidenceCommitted = true;
          }
        } catch (error) {
          if (stagedAnonymousEvidence && !stagedAnonymousEvidenceCommitted) {
            try {
              await rollbackExternalizedEvidence(stagedAnonymousEvidence);
            } catch (rollbackError) {
              cleanupErrors.push(rollbackError);
            }
          }
          const anonymousError = error instanceof Error
            ? error.message
            : "The anonymous workspace could not be opened after account cleanup.";
          nextRecoveryMessage = `The deleted account remains fenced, but the anonymous workspace could not be opened: ${anonymousError}`;
          try {
            const scope = await readAccountPersistenceScope(anonymousAccountId);
            anonymousGeneration = scope.generation;
            persistenceScopeGenerations.current.set(anonymousAccountId, scope.generation);
          } catch {
            // The empty, non-dirty state below performs no write with a guessed
            // generation. Reload can retry the anonymous scope read.
          }
        }

        quarantinedAccounts.current.delete(target);
        localConflictAccounts.current.delete(target);
        expectedLocalRevisions.current.set(target, 0);
        localWriteQueues.current.delete(target);
        setLocalWorkspaceConflict((current) =>
          current?.accountId === target ? null : current);
        setQuarantinedRecovery(null);
        recoveryNotice.current = nextRecoveryMessage;
        activeAccount.current = null;
        history.current = nextHistory;
        dirty.current = nextDirty;
        localChangeVersion.current += 1;
        revision.current = nextRevision;
        serverUpdatedAt.current = nextServerUpdatedAt;
        latestState.current = nextState;
        persistenceScopeGenerations.current.set(
          anonymousAccountId,
          anonymousGeneration,
        );
        setPersistenceScopeGeneration(anonymousGeneration);
        workspaceGeneration.current = incrementWorkspaceScopeKey(
          workspaceGeneration.current,
        );
        terminalErasureAccount.current = null;
        setTerminalErasureAccountId(null);
        accountSwitching.current = false;
        setWorkspaceSwitching(false);
        setCanUndo(nextHistory.length > 0);
        setState(nextState);
        advanceWorkspaceScope("account-switch");
        setPersistenceError(nextRecoveryMessage);
        setSyncStatus("local");
        setAccountEpoch((value) => value + 1);

        if (cleanupErrors.length) {
          throw new AggregateError(
            cleanupErrors,
            "The exact account remains permanently fenced, but some device cleanup needs to be retried.",
          );
        }
        return { sessionWarning };
      },
      async resetWorkspace() {
        const outgoingScopeKey = workspaceScopeKeyRef.current;
        const resetActiveAccount = activeAccount.current;
        const resetAuthenticatedAccount = authenticatedUserId.current;
        const resetAccountId = persistenceAccountId(resetActiveAccount);
        const resetPersistenceGeneration = persistenceScopeGenerations.current.get(resetAccountId);
        if (resetPersistenceGeneration === undefined) {
          throw new Error("The account persistence scope has not been loaded.");
        }
        const resetRemoteConflict = remoteConflict.current;
        const resetSyncConflict = syncConflict;
        const resetGeneration = incrementWorkspaceScopeKey(workspaceGeneration.current);
        workspaceGeneration.current = resetGeneration;
        accountSwitching.current = true;
        setWorkspaceSwitching(true);
        setCloudWriteAllowed(false);
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        remoteConflict.current = null;
        pendingAccountHandoff.current = null;
        setSyncConflict(null);
        setAccountHandoff(null);
        const ensureResetCurrent = () => {
          if (
            workspaceGeneration.current !== resetGeneration
            || activeAccount.current !== resetActiveAccount
            || authenticatedUserId.current !== resetAuthenticatedAccount
            || workspaceScopeKeyRef.current !== outgoingScopeKey
          ) {
            throw new Error("The active account changed before workspace erasure could begin.");
          }
        };
        try {
          // Retirement closes admission synchronously. Already admitted work
          // remains tracked through its compensation, and account deletion is
          // deliberately the final operation against this scope.
          await workspaceOperations.retire(outgoingScopeKey);
          await localWriteQueues.current.get(resetAccountId);
          ensureResetCurrent();
          if (resetAccountId === persistenceAccountId(null)) {
            await disableLocalBootstrapLegacyImport({
              accountId: resetAccountId,
              ensureCurrent: ensureResetCurrent,
            }, { disableLegacyWorkspaceImport });
            localStorage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY);
            localStorage.removeItem(LEGACY_LAST_REMINDER_KEY);
          }
          localStorage.removeItem(reminderStorageKey(resetAccountId));
          const erased = await deleteAccountPersistence(
            resetAccountId,
            resetPersistenceGeneration,
          );
          persistenceScopeGenerations.current.set(resetAccountId, erased.scope.generation);
          setPersistenceScopeGeneration(erased.scope.generation);
        } catch (error) {
          const identityChanged = activeAccount.current !== resetActiveAccount
            || authenticatedUserId.current !== resetAuthenticatedAccount;
          if (!identityChanged && workspaceScopeKeyRef.current === outgoingScopeKey) {
            // The IndexedDB erase is atomic. If it aborts, keep the old scope
            // retired and reopen the unchanged workspace under a fresh key.
            remoteConflict.current = resetRemoteConflict;
            setSyncConflict(resetSyncConflict);
            advanceWorkspaceScope("reset");
          }
          accountSwitching.current = identityChanged;
          setWorkspaceSwitching(identityChanged);
          if (authenticatedUserId.current) setAccountEpoch((value) => value + 1);
          throw error;
        }
        quarantinedAccounts.current.delete(resetAccountId);
        localConflictAccounts.current.delete(resetAccountId);
        expectedLocalRevisions.current.set(resetAccountId, 0);
        localWriteQueues.current.delete(resetAccountId);
        setLocalWorkspaceConflict((current) =>
          current?.accountId === resetAccountId ? null : current);
        setQuarantinedRecovery(null);
        recoveryNotice.current = null;
        const emptyState = { ...clone(EMPTY_STATE), updatedAt: new Date().toISOString() };
        activeAccount.current = authenticatedUserId.current;
        history.current = [];
        dirty.current = false;
        localChangeVersion.current += 1;
        revision.current = 0;
        serverUpdatedAt.current = undefined;
        latestState.current = emptyState;
        accountSwitching.current = false;
        setWorkspaceSwitching(false);
        setCanUndo(false);
        setState(emptyState);
        advanceWorkspaceScope("reset");
        setSyncStatus(authenticatedUserId.current ? "connecting" : "local");
        if (authenticatedUserId.current) setAccountEpoch((value) => value + 1);
      },
      async discardQuarantinedWorkspace() {
        const recovery = quarantinedRecovery;
        if (!recovery) return;
        const discardScopeKey = workspaceScopeKeyRef.current;
        const discardActiveAccount = activeAccount.current;
        const discardAuthenticatedAccount = authenticatedUserId.current;
        const discardGeneration = incrementWorkspaceScopeKey(workspaceGeneration.current);
        const activeAccountId = persistenceAccountId(discardActiveAccount);
        if (activeAccountId !== recovery.accountId) {
          throw new Error("The active account changed before the quarantined device copy could be erased.");
        }
        const discardPersistenceGeneration = persistenceScopeGenerations.current.get(
          recovery.accountId,
        );
        if (discardPersistenceGeneration === undefined) {
          throw new Error("The account persistence scope has not been loaded.");
        }
        workspaceGeneration.current = discardGeneration;
        accountSwitching.current = true;
        setWorkspaceSwitching(true);
        setCloudWriteAllowed(false);
        const ensureDiscardCurrent = () => {
          if (
            workspaceGeneration.current !== discardGeneration
            || activeAccount.current !== discardActiveAccount
            || authenticatedUserId.current !== discardAuthenticatedAccount
            || workspaceScopeKeyRef.current !== discardScopeKey
          ) {
            throw new Error("The active account changed before the quarantined device copy could be erased.");
          }
        };
        try {
          await workspaceOperations.retire(discardScopeKey);
          await localWriteQueues.current.get(recovery.accountId);
          ensureDiscardCurrent();
          if (recovery.accountId === persistenceAccountId(null)) {
            // Explicit repair permanently closes the legacy import before any
            // old shared bytes are removed. A crash can therefore never make
            // those bytes importable again.
            await disableLocalBootstrapLegacyImport({
              accountId: recovery.accountId,
              ensureCurrent: ensureDiscardCurrent,
            }, { disableLegacyWorkspaceImport });
            localStorage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY);
            localStorage.removeItem(LEGACY_LAST_REMINDER_KEY);
          }
          const erased = await deleteAccountPersistence(
            recovery.accountId,
            discardPersistenceGeneration,
          );
          persistenceScopeGenerations.current.set(
            recovery.accountId,
            erased.scope.generation,
          );
          setPersistenceScopeGeneration(erased.scope.generation);
        } catch (error) {
          const identityChanged = activeAccount.current !== discardActiveAccount
            || authenticatedUserId.current !== discardAuthenticatedAccount;
          if (!identityChanged && workspaceScopeKeyRef.current === discardScopeKey) {
            advanceWorkspaceScope("reset");
          }
          accountSwitching.current = identityChanged;
          setWorkspaceSwitching(identityChanged);
          throw error;
        }
        quarantinedAccounts.current.delete(recovery.accountId);
        expectedLocalRevisions.current.set(recovery.accountId, 0);
        recoveryNotice.current = null;
        setQuarantinedRecovery(null);
        setPersistenceError(null);
        const emptyState = { ...clone(EMPTY_STATE), updatedAt: new Date().toISOString() };
        history.current = [];
        dirty.current = false;
        localChangeVersion.current += 1;
        revision.current = 0;
        serverUpdatedAt.current = undefined;
        latestState.current = emptyState;
        accountSwitching.current = false;
        setWorkspaceSwitching(false);
        setCanUndo(false);
        setState(emptyState);
        advanceWorkspaceScope("reset");
        if (activeAccount.current) {
          remoteLoaded.current = false;
          reconciledAccount.current = null;
          setSyncStatus("connecting");
          setAccountEpoch((value) => value + 1);
        }
      },
      undo() {
        const previous = history.current.pop();
        if (previous) {
          dirty.current = true;
          localChangeVersion.current += 1;
          const nextState = { ...previous, updatedAt: new Date().toISOString() };
          latestState.current = nextState;
          setState(nextState);
          advanceWorkspaceScope("undo");
          setCanUndo(history.current.length > 0);
          markCloudChangesPending();
        }
      },
      async resolveAccountHandoff(choice) {
        const pending = pendingAccountHandoff.current;
        if (
          !pending
          || !user
          || user.id !== pending.accountId
          || authenticatedUserId.current !== pending.accountId
          || activeAccount.current !== null
        ) {
          throw new Error("This workspace choice is no longer active.");
        }
        const generation = workspaceGeneration.current;
        const handoffScopeKey = workspaceScopeKeyRef.current;
        const decision = decideAnonymousHandoff(choice);
        accountSwitching.current = true;
        setWorkspaceSwitching(true);
        let stagedTargetEvidence:
          | Awaited<ReturnType<typeof externalizeWorkspaceHistory>>
          | Awaited<ReturnType<typeof externalizeEmbeddedEvidence>>
          | null = null;
        let stagedTargetEvidenceCommitted = false;
        const handoffEvidenceJournal: EvidenceBlobJournalEntry[] = [];
        let handoffEvidenceCommitted = false;
        let handoffTargetGeneration: PersistenceScopeGeneration | null = null;
        return workspaceOperations.run(handoffScopeKey, async () => {
          try {
            const supabase = getSupabase();
            if (!supabase) {
              throw new Error("Private cloud access is required to establish the exact account workspace before making this choice.");
            }
            const targetAccountId = persistenceAccountId(pending.accountId);
            const sourceAccountId = persistenceAccountId(null);
            const sourceGeneration = persistenceScopeGenerations.current.get(sourceAccountId);
            if (sourceGeneration === undefined) {
              throw new Error("The anonymous persistence scope has not been loaded.");
            }
            const handoffStillCurrent = () => generation === workspaceGeneration.current
              && handoffScopeKey === workspaceScopeKeyRef.current
              && pendingAccountHandoff.current?.accountId === pending.accountId
              && authenticatedUserId.current === pending.accountId
              && activeAccount.current === null;
            const requireCurrentHandoff = (message: string) => {
              if (!handoffStillCurrent()) throw new Error(message);
            };
            const requireExactAuthenticatedAccount = async () => {
              requireCurrentHandoff("The signed-in account changed before the workspace choice finished.");
              const { data, error } = await supabase.auth.getUser();
              if (error) throw error;
              if (data.user?.id !== pending.accountId) {
                throw new Error("The authenticated account changed before the workspace choice finished.");
              }
              requireCurrentHandoff("The signed-in account changed before the workspace choice finished.");
            };

            let frozenAnonymousState = clone(latestState.current);
            let frozenAnonymousHistory = trimWorkspaceHistory(history.current.map(clone));
            let frozenAnonymousDirty = dirty.current;
            let frozenAnonymousRevision = revision.current;
            let frozenAnonymousServerUpdatedAt = serverUpdatedAt.current;
            let frozenAnonymousVersion = localChangeVersion.current;
            let frozenAnonymousLocalRevision = expectedLocalRevisions.current.get(sourceAccountId) ?? 0;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const savedAnonymous = await persistWorkspace({
                accountId: sourceAccountId,
                state: frozenAnonymousState,
                history: frozenAnonymousHistory,
                dirty: frozenAnonymousDirty,
                revision: frozenAnonymousRevision,
                serverUpdatedAt: frozenAnonymousServerUpdatedAt,
                savedAt: new Date().toISOString(),
              });
              frozenAnonymousLocalRevision = savedAnonymous.localRevision;
              requireCurrentHandoff("The signed-in account changed before the anonymous workspace was secured.");
              if (localChangeVersion.current === frozenAnonymousVersion) break;
              if (attempt === 2) {
                throw new Error("The anonymous workspace kept changing while it was being secured. Try the workspace choice again.");
              }
              frozenAnonymousState = clone(latestState.current);
              frozenAnonymousHistory = trimWorkspaceHistory(history.current.map(clone));
              frozenAnonymousDirty = dirty.current;
              frozenAnonymousRevision = revision.current;
              frozenAnonymousServerUpdatedAt = serverUpdatedAt.current;
              frozenAnonymousVersion = localChangeVersion.current;
            }

            let targetEnvelope: WorkspaceEnvelope | null = null;
            let targetScope: AccountPersistenceScope | null = null;
            let targetWasQuarantined = false;
            try {
              const target = await readTrackedWorkspace(targetAccountId);
              targetEnvelope = target.workspace;
              targetScope = target.scope;
            } catch (error) {
              if (
                (error instanceof PersistenceError && error.code === "invalid-data")
                || error instanceof UnsupportedStoredWorkspaceVersionError
              ) {
                targetWasQuarantined = true;
                quarantinedAccounts.current.add(targetAccountId);
              } else {
                throw error;
              }
            }
            requireCurrentHandoff("The signed-in account changed before its device workspace could be inspected.");
            if (!targetScope) {
              targetScope = await readAccountPersistenceScope(targetAccountId);
              persistenceScopeGenerations.current.set(targetAccountId, targetScope.generation);
            }
            if (targetScope.tombstoned) {
              const emptyState = clone(EMPTY_STATE);
              terminalErasureAccount.current = targetAccountId;
              setTerminalErasureAccountId(targetAccountId);
              pendingAccountHandoff.current = null;
              setAccountHandoff(null);
              activeAccount.current = pending.accountId;
              setPersistenceScopeGeneration(targetScope.generation);
              localChangeVersion.current += 1;
              history.current = [];
              dirty.current = false;
              revision.current = 0;
              serverUpdatedAt.current = undefined;
              latestState.current = emptyState;
              setState(emptyState);
              advanceWorkspaceScope("anonymous-handoff");
              setCanUndo(false);
              setPersistenceError("This account is fenced for deletion. Evolvra is keeping every workspace writer closed while cleanup resumes.");
              setSyncStatus("error");
              return;
            }
            const targetGeneration = targetScope.generation;
            handoffTargetGeneration = targetGeneration;

            await requireExactAuthenticatedAccount();
            const { data: fetchedRow, error: fetchError } = await supabase
              .from("workspace_snapshots")
              .select("state,revision,updated_at")
              .eq("user_id", pending.accountId)
              .maybeSingle();
            if (fetchError) throw fetchError;
            await requireExactAuthenticatedAccount();
            const remoteRow = fetchedRow
              ? fetchedRow as {
                  state: unknown;
                  revision: unknown;
                  updated_at: unknown;
                }
              : null;
            const remoteExists = remoteRow !== null;
            const sourceDecision = decideAccountHandoffSource({
              localExists: Boolean(targetEnvelope),
              localDirty: targetEnvelope?.dirty ?? false,
              localRevision: targetEnvelope?.revision,
              remoteExists,
              remoteRevision: remoteRow?.revision,
            });
            if (sourceDecision.action === "invalid-revision") {
              throw new Error(`The account's ${sourceDecision.source} workspace has an invalid revision. Neither copy was changed.`);
            }
            if (sourceDecision.action === "conflict") {
              throw new Error(`This device has unsaved account changes based on revision ${sourceDecision.localRevision}, while cloud is at revision ${sourceDecision.remoteRevision}. Sign out to preserve the anonymous workspace, then resolve the account sync conflict before combining them.`);
            }
            if (targetWasQuarantined && !remoteExists && decision.action === "open-account") {
              throw new Error("The account's device copy is quarantined and no cloud snapshot exists. Sign out, then recover or explicitly replace that device copy before opening it.");
            }

            let migratedRemoteState: AppState | null = null;
            let remoteUpdatedAt: string | undefined;
            if (remoteRow) {
              if (typeof remoteRow.updated_at !== "string") {
                throw new Error("Private sync returned an invalid account update time. Neither workspace was changed.");
              }
              migratedRemoteState = migrateStoredState(remoteRow.state);
              remoteUpdatedAt = remoteRow.updated_at;
            }

            let accountBaseState = clone(EMPTY_STATE);
            let accountBaseHistory: AppState[] = [];
            let accountBaseDirty = false;
            const accountBaseRevision = sourceDecision.remoteRevision;
            const accountBaseServerUpdatedAt = remoteUpdatedAt;
            let nextRecoveryMessage: string | null = null;
            if (sourceDecision.action === "use-local") {
              if (!targetEnvelope) {
                throw new Error("The selected account device workspace is no longer available.");
              }
              const recovered = await externalizeWorkspaceHistory(
                migrateStoredState(targetEnvelope.state),
                trimWorkspaceHistory(targetEnvelope.history.map((item) => migrateStoredState(item))),
                targetAccountId,
                targetGeneration,
              );
              stagedTargetEvidence = recovered;
              requireCurrentHandoff("The signed-in account changed before its device workspace could be prepared.");
              accountBaseState = recovered.state;
              accountBaseHistory = recovered.history;
              accountBaseDirty = targetEnvelope.recovery?.source === "history"
                ? false
                : targetEnvelope.dirty || recovered.changed;
              nextRecoveryMessage = decision.action === "open-account"
                ? targetEnvelope.recovery?.message ?? null
                : null;
            } else if (sourceDecision.action === "use-cloud") {
              if (!migratedRemoteState || !remoteRow) {
                throw new Error("The selected account cloud workspace is no longer available.");
              }
              const recovered = await externalizeEmbeddedEvidence(
                migratedRemoteState,
                targetAccountId,
                targetGeneration,
              );
              stagedTargetEvidence = recovered;
              requireCurrentHandoff("The signed-in account changed before its cloud workspace could be prepared.");
              accountBaseState = recovered.state;
              accountBaseHistory = [];
              accountBaseDirty = recovered.changed
                || (remoteRow.state as { version?: unknown })?.version !== CURRENT_STATE_VERSION
                || !workspaceStatesEqual(remoteRow.state as AppState, recovered.state);
            }

            const savedAt = new Date().toISOString();
            let nextState = accountBaseState;
            let nextHistory = accountBaseHistory;
            let nextDirty = accountBaseDirty;
            let fileCopies: WorkspaceFileEvidenceCopy[] = [];
            if (decision.action === "merge-anonymous") {
              const merged = mergeAnonymousWorkspace(
                accountBaseState,
                frozenAnonymousState,
                savedAt,
              );
              nextState = merged.state;
              nextHistory = trimWorkspaceHistory([
                ...accountBaseHistory.map(clone),
                clone(accountBaseState),
              ]);
              nextDirty = true;
              fileCopies = workspaceMergeFileEvidenceCopies(
                frozenAnonymousState,
                merged,
              );
            } else if (decision.action === "copy-anonymous") {
              nextState = {
                ...portableWorkspaceState(frozenAnonymousState),
                updatedAt: savedAt,
              };
              nextHistory = [];
              nextDirty = true;
              fileCopies = frozenAnonymousState.goals.flatMap((goal) => (
                goal.evidence
                  .filter((item): item is GoalFileEvidence => item.type === "file")
                  .map((item) => ({
                    sourceGoalId: goal.id,
                    sourceEvidenceId: item.id,
                    mergedGoalId: goal.id,
                    mergedEvidenceId: item.id,
                    source: clone(item),
                  }))
              ));
            }

            if (fileCopies.length) {
              const evidenceBucket = supabase.storage.from("evidence");
              const prepared = await prepareAnonymousHandoffEvidenceCopies({
                copies: fileCopies,
                sourceAccountId,
                targetAccountId,
                savedAt,
                isCurrent: handoffStillCurrent,
                readSource: (accountId, goalId, evidenceId) => readEvidenceBlob(
                  accountId,
                  goalId,
                  evidenceId,
                  sourceGeneration,
                ),
                downloadRemote: async (path) => {
                  await requireExactAuthenticatedAccount();
                  const { data, error } = await evidenceBucket.download(path);
                  if (error || !data) {
                    throw error ?? new Error("A private evidence file could not be downloaded.");
                  }
                  await requireExactAuthenticatedAccount();
                  return data;
                },
              });
              requireCurrentHandoff("The signed-in account changed before evidence files could be copied.");
              await appendEvidenceBlobCopies(
                prepared,
                targetAccountId,
                handoffEvidenceJournal,
                {
                  readTarget: async (accountId, goalId, evidenceId) => {
                    const existing = await readEvidenceBlob(
                      accountId,
                      goalId,
                      evidenceId,
                      targetGeneration,
                    );
                    if (existing && decision.action === "merge-anonymous") {
                      throw new Error("A target evidence key already exists outside the account workspace. Nothing was overwritten.");
                    }
                    return existing;
                  },
                  writeTarget: async (item) => {
                    requireCurrentHandoff("The signed-in account changed while evidence files were being copied.");
                    await storeEvidenceBlob(item, targetGeneration);
                  },
                },
              );
            }

            await requireExactAuthenticatedAccount();
            const replacementEnvelope: Omit<WorkspaceEnvelope, "localRevision"> = {
              accountId: targetAccountId,
              state: nextState,
              history: trimWorkspaceHistory(nextHistory),
              dirty: nextDirty,
              revision: accountBaseRevision,
              serverUpdatedAt: accountBaseServerUpdatedAt,
              savedAt,
              anonymousHandoff: {
                generation: sourceGeneration,
                localRevision: frozenAnonymousLocalRevision,
              },
            };
            const saved = targetWasQuarantined
              ? await replaceWorkspaceAfterRecoveryChoice(
                  replacementEnvelope,
                  targetGeneration,
                )
              : await persistWorkspace(replacementEnvelope);
            expectedLocalRevisions.current.set(targetAccountId, saved.localRevision);
            // Metadata now references every copied byte. From this point onward
            // rolling files back would create broken evidence references.
            stagedTargetEvidenceCommitted = Boolean(stagedTargetEvidence);
            handoffEvidenceCommitted = fileCopies.length > 0;
            quarantinedAccounts.current.delete(targetAccountId);

            requireCurrentHandoff("The account changed after its workspace was saved. The saved target remains internally consistent and the anonymous original was preserved.");
            pendingAccountHandoff.current = null;
            setAccountHandoff(null);
            activeAccount.current = pending.accountId;
            setPersistenceScopeGeneration(targetGeneration);
            localChangeVersion.current += 1;
            history.current = nextHistory;
            dirty.current = nextDirty;
            revision.current = accountBaseRevision;
            serverUpdatedAt.current = accountBaseServerUpdatedAt;
            latestState.current = nextState;
            recoveryNotice.current = nextRecoveryMessage;
            setPersistenceError(nextRecoveryMessage);
            setQuarantinedRecovery(null);
            remoteLoaded.current = false;
            reconciledAccount.current = null;
            setCloudWriteAllowed(false);
            setState(nextState);
            advanceWorkspaceScope("anonymous-handoff");
            setCanUndo(nextHistory.length > 0);
            setSyncStatus("connecting");
            setAccountEpoch((value) => value + 1);
          } catch (error) {
            let reportedError: unknown = error;
            if (
              handoffEvidenceJournal.length
              && !handoffEvidenceCommitted
              && handoffTargetGeneration !== null
            ) {
              const rollbackGeneration = handoffTargetGeneration;
              try {
                await rollbackEvidenceBlobJournal(handoffEvidenceJournal, {
                  restore: async (item) => {
                    await storeEvidenceBlob(item, rollbackGeneration);
                  },
                  remove: async (accountId, goalId, evidenceId) => {
                    await deleteEvidenceBlob(
                      accountId,
                      goalId,
                      evidenceId,
                      rollbackGeneration,
                    );
                  },
                });
              } catch (rollbackError) {
                reportedError = new EvidenceCompensationError(error, [rollbackError]);
              }
            }
            if (pendingAccountHandoff.current?.accountId === pending.accountId) {
              setPersistenceError(reportedError instanceof Error
                ? `Workspace choice could not finish: ${reportedError.message}`
                : "Workspace choice could not finish. Nothing was removed from the device copy.");
              setSyncStatus("conflict");
            }
            throw reportedError;
          } finally {
            if (stagedTargetEvidence && !stagedTargetEvidenceCommitted) {
              await rollbackExternalizedEvidence(stagedTargetEvidence);
            }
            if (
              generation === workspaceGeneration.current
              && authenticatedUserId.current === pending.accountId
            ) {
              const transitionPending = pendingAccountHandoff.current?.accountId === pending.accountId
                || terminalErasureAccount.current !== null;
              accountSwitching.current = transitionPending;
              setWorkspaceSwitching(transitionPending);
            }
          }
        }, () => generation === workspaceGeneration.current
          && handoffScopeKey === workspaceScopeKeyRef.current
          && pendingAccountHandoff.current?.accountId === pending.accountId
          && authenticatedUserId.current === pending.accountId
          && activeAccount.current === null);
      },
      async retrySync() {
        if (pendingAccountHandoff.current) return;
        if (user && typeof navigator !== "undefined" && navigator.onLine === false) {
          setSyncStatus("offline");
          return;
        }
        const abandonedRemoteConflict = remoteConflict.current;
        const retryScopeKey = workspaceScopeKeyRef.current;
        if (abandonedRemoteConflict) {
          try {
            await workspaceOperations.run(
              retryScopeKey,
              () => rollbackEvidenceWrites(abandonedRemoteConflict.createdEvidence),
              () => retryScopeKey === workspaceScopeKeyRef.current
                && !accountSwitching.current
                && remoteConflict.current === abandonedRemoteConflict,
            );
          } catch (error) {
            if (error instanceof WorkspaceOperationStartRejectedError) return;
            setPersistenceError(error instanceof Error
              ? `Sync could not retry until staged evidence is safe: ${error.message}`
              : "Sync could not retry until staged evidence is safe.");
            setSyncStatus("error");
            return;
          }
        }
        if (retryScopeKey !== workspaceScopeKeyRef.current || accountSwitching.current) return;
        remoteConflict.current = null;
        setSyncConflict(null);
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        setCloudWriteAllowed(false);
        setSyncStatus(user ? "connecting" : "local");
        setAccountEpoch((value) => value + 1);
      },
      async resolveSyncConflict(choice) {
        const remote = remoteConflict.current;
        if (
          !remote
          || !user
          || pendingAccountHandoff.current
          || activeAccount.current !== user.id
        ) return;
        const resolutionAccountId = user.id;
        const resolutionGeneration = workspaceGeneration.current;
        const resolutionScopeKey = workspaceScopeKeyRef.current;
        const conflictStillCurrent = () =>
          resolutionGeneration === workspaceGeneration.current
          && resolutionScopeKey === workspaceScopeKeyRef.current
          && !accountSwitching.current
          && authenticatedUserId.current === resolutionAccountId
          && activeAccount.current === resolutionAccountId
          && remoteConflict.current === remote;
        try {
          await workspaceOperations.run(resolutionScopeKey, async () => {
            const intent = decideConflictResolution(choice, remote.needsSave);
            if (intent.action !== "use-cloud" && intent.action !== "use-cloud-and-save") {
              try {
                await rollbackEvidenceWrites(remote.createdEvidence);
              } catch (error) {
                if (conflictStillCurrent()) {
                  setPersistenceError(error instanceof Error
                    ? `The device copy was not selected because staged cloud evidence could not be restored safely: ${error.message}`
                    : "The device copy was not selected because staged cloud evidence could not be restored safely.");
                  setSyncStatus("error");
                }
                return;
              }
              if (!conflictStillCurrent()) return;
            }
            remoteConflict.current = null;
            setSyncConflict(null);
            revision.current = remote.revision;
            serverUpdatedAt.current = remote.updatedAt;
            remoteLoaded.current = true;
            reconciledAccount.current = resolutionAccountId;
            quarantinedAccounts.current.delete(persistenceAccountId(resolutionAccountId));
            dirty.current = intent.dirty;
            localChangeVersion.current += 1;
            if (intent.action === "use-cloud" || intent.action === "use-cloud-and-save") {
              adoptRemoteWorkspace(remote.state);
            } else {
              const nextState = { ...latestState.current, updatedAt: new Date().toISOString() };
              latestState.current = nextState;
              setState(nextState);
            }
            setSyncStatus(intent.shouldSave ? "saving" : "synced");
            setMetadataEpoch((value) => value + 1);
          }, conflictStillCurrent);
        } catch (error) {
          if (!(error instanceof WorkspaceOperationStartRejectedError)) throw error;
        }
      },
      signIn,
      async signOut() {
        const activeAccountAtStart = activeAccount.current;
        if (activeAccountAtStart !== null && !accountSwitching.current) {
          accountSwitching.current = true;
          setWorkspaceSwitching(true);
        }
        try {
          await signOutSession();
        } catch (error) {
          if (
            authenticatedUserId.current === activeAccountAtStart
            && activeAccount.current === activeAccountAtStart
          ) {
            accountSwitching.current = false;
            setWorkspaceSwitching(false);
          }
          throw error;
        }
        authenticatedUserId.current = null;
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        setCloudWriteAllowed(false);
        pendingAccountHandoff.current = null;
        setAccountHandoff(null);
        setSyncStatus("local");
        if (activeAccount.current === null) {
          accountSwitching.current = false;
          setWorkspaceSwitching(false);
        }
      },
    };

  const workspaceValue = useMemo<WorkspaceDataContextValue>(() => ({
    state: value.state,
    workspaceScopeKey: value.workspaceScopeKey,
    persistenceScopeGeneration: value.persistenceScopeGeneration,
  }), [
    value.persistenceScopeGeneration,
    value.state,
    value.workspaceScopeKey,
  ]);
  const statusValue = useMemo<ProviderStatusContextValue>(() => ({
    ready: value.ready,
    workspaceSwitching: value.workspaceSwitching,
    terminalErasureAccountId: value.terminalErasureAccountId,
    user: value.user,
    syncStatus: value.syncStatus,
    cloudEnabled: value.cloudEnabled,
    cloudWriteAllowed: value.cloudWriteAllowed,
    persistenceError: value.persistenceError,
    localWorkspaceConflict: value.localWorkspaceConflict,
    quarantinedRecovery: value.quarantinedRecovery,
    syncConflict: value.syncConflict,
    accountHandoff: value.accountHandoff,
    canUndo: value.canUndo,
  }), [
    value.accountHandoff,
    value.canUndo,
    value.cloudEnabled,
    value.cloudWriteAllowed,
    value.localWorkspaceConflict,
    value.persistenceError,
    value.quarantinedRecovery,
    value.ready,
    value.syncConflict,
    value.syncStatus,
    value.terminalErasureAccountId,
    value.user,
    value.workspaceSwitching,
  ]);
  const actionsValue: AppActionsContextValue = value;

  return (
    <WorkspaceDataProvider value={workspaceValue}>
      <ProviderStatusProvider value={statusValue}>
        <AppActionsProvider value={actionsValue}>
          {children}
        </AppActionsProvider>
      </ProviderStatusProvider>
    </WorkspaceDataProvider>
  );
}
