"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppActionsProvider,
  ProviderStatusProvider,
  WorkspaceDataProvider,
  type AppContextValue,
  type AnonymousWorkspaceHandoff,
  type LocalWorkspaceConflict,
  type ProviderStatusContextValue,
  type QuarantinedRecovery,
  type SyncConflict,
  type WorkspaceDataContextValue,
} from "@/components/app-context";
import { useProviderAuth } from "@/components/use-provider-auth";
import { useStableAppActions } from "@/components/use-stable-app-actions";
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
  createGoalEvidenceActions,
  GoalEvidenceCloudSaveAmbiguousError,
  GoalEvidenceLocalCommitRetainedError,
  saveGoalEvidenceCloudMetadataWithVerification,
  type GoalEvidenceOperationScope,
} from "@/lib/provider-goal-evidence";
import { normalizedEvidenceBlob } from "@/lib/goal-evidence";
import {
  disableLocalBootstrapLegacyImport,
  LocalBootstrapSupersededError,
  observeLegacyWorkspace,
  runLocalWorkspaceBootstrap,
} from "@/lib/provider-local-bootstrap";
import {
  planProviderAccountHandoff,
  runProviderCloudReconciliation,
  type ProviderPreparedRemote,
} from "@/lib/provider-cloud-reconciliation";
import {
  createCompletePortableArchive,
  type PortableArchiveOperationBoundary,
} from "@/lib/provider-portable-archive";
import { runProviderCloudSave } from "@/lib/provider-cloud-save";
import { runClaimedRemoteEvidenceCleanup } from "@/lib/provider-remote-evidence-cleanup";
import { runAuthoritativeWorkspaceReplacement } from "@/lib/provider-workspace-replacement";
import {
  workspaceNoticeForActiveAccount,
  type SyncStatus,
} from "@/lib/provider-selectors";
import {
  externalizeEmbeddedEvidence,
  externalizeWorkspaceHistory,
  portableWorkspaceState,
  remoteEvidencePath,
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
  inspectAndPreparePortableWorkspaceArchiveImport,
  type PortableWorkspaceArchiveImportPlan,
} from "@/lib/portable-workspace-archive";
import {
  applyAccountHandoffPersistence,
  applyPortableArchivePersistence,
  cancelEvidenceCleanupIntent,
  captureLegacyWorkspaceImport,
  cleanupAbandonedEvidenceStaging,
  commitLegacyWorkspaceImport,
  deleteAccountPersistence,
  deleteAccountPersistenceAtRevision,
  deleteEvidenceBlobs,
  disableLegacyWorkspaceImport,
  eraseAccountPersistenceWithTombstone,
  listEvidenceBlobs,
  listEvidenceCleanupIntents,
  markEvidenceCleanupRemoteComplete,
  readEvidenceBlob,
  readAccountPersistenceBackupBoundary,
  readAccountPersistenceScope,
  recoverLocalEvidenceCleanupIntents,
  readRawWorkspace,
  readWorkspaceWithScope,
  quarantinedWorkspaceLocalRevision,
  replaceWorkspaceAfterRecoveryChoice,
  rollbackStagedEvidenceBlob,
  restoreEvidenceBlobs,
  stageEvidenceBlob,
  stageEvidenceCleanupIntent,
  storeEvidenceBlob,
  writeWorkspace,
  AccountPersistenceScopeError,
  LocalWorkspaceConflictError,
  PersistenceError,
  type AccountPersistenceEraseResult,
  type AccountPersistenceBackupBoundary,
  type AccountPersistenceScope,
  type EvidenceBlobRecord,
  type PersistenceScopeGeneration,
  type StagedEvidenceBlobWrite,
  type WorkspaceEnvelope,
  type WorkspaceWriteOptions,
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
  claimPrivateEvidenceCleanup,
  getSupabase,
  listPrivateEvidencePaths,
  readAccountErasureBackupBoundary,
  saveWorkspaceSnapshotWithDeadline,
  supabaseConfigured,
} from "@/lib/supabase";
import type { AccountErasureCloudBackupBoundary } from "@/lib/account-erasure-checkpoint";
import {
  canWriteCloud,
  canPersistWorkspaceAutomatically,
  decideAccountSwitch,
  decideConflictResolution,
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

interface PortableArchiveBoundary extends PortableArchiveOperationBoundary {
  activeAccountId: string | null;
  workspaceGeneration: WorkspaceScopeKey;
  workspaceScopeKey: WorkspaceScopeKey;
  localChangeVersion: number;
}

interface PreparedPortableArchiveImport {
  token: string;
  boundary: PortableArchiveBoundary;
  importedAt: string;
  plan: PortableWorkspaceArchiveImportPlan;
}

interface PreparedPortableArchiveReset {
  token: string;
  boundary: PortableArchiveBoundary;
  localBoundary: AccountPersistenceBackupBoundary;
  cloudBackupBoundary: AccountErasureCloudBackupBoundary | null;
}

function mutableRemoteSnapshot(
  remote: ProviderPreparedRemote<AppState, StagedEvidenceWrite>,
): RemoteSnapshot {
  return {
    ...remote,
    createdEvidence: [...remote.createdEvidence],
  };
}

function cloudBackupBoundariesEqual(
  left: AccountErasureCloudBackupBoundary,
  right: AccountErasureCloudBackupBoundary,
): boolean {
  return left.workspaceRevision === right.workspaceRevision
    && left.evidenceRevision === right.evidenceRevision;
}

function localBackupBoundariesEqual(
  left: AccountPersistenceBackupBoundary,
  right: AccountPersistenceBackupBoundary,
): boolean {
  return left.accountId === right.accountId
    && left.generation === right.generation
    && left.workspaceLocalRevision === right.workspaceLocalRevision
    && left.evidenceRevision === right.evidenceRevision;
}

function stringSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const orderedLeft = [...left].sort();
  const orderedRight = [...right].sort();
  return orderedLeft.every((value, index) => value === orderedRight[index]);
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
const ABANDONED_EVIDENCE_STAGING_AGE_MS = 24 * 60 * 60 * 1000;

const abandonedEvidenceStagingCutoff = () => new Date(
  Date.now() - ABANDONED_EVIDENCE_STAGING_AGE_MS,
).toISOString();

function commitAuthoritativeWorkspaceReplacement<TResult>({
  accountId,
  persistenceGeneration,
  sourceStates,
  targetStates,
  persistTarget,
}: {
  accountId: string;
  persistenceGeneration: PersistenceScopeGeneration;
  sourceStates: readonly AppState[];
  targetStates: readonly AppState[];
  persistTarget: () => Promise<TResult>;
}) {
  return runAuthoritativeWorkspaceReplacement({
    accountId,
    sourceStates,
    targetStates,
  }, {
    listLocalEvidence: (targetAccountId) => listEvidenceBlobs(
      targetAccountId,
      undefined,
      persistenceGeneration,
    ),
    stageCleanup: (input) => stageEvidenceCleanupIntent(
      input,
      persistenceGeneration,
    ),
    cancelCleanup: (intent) => cancelEvidenceCleanupIntent(
      intent,
      persistenceGeneration,
    ),
    persistTarget,
  });
}

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
  const preparedPortableArchiveImport = useRef<PreparedPortableArchiveImport | null>(null);
  const preparedPortableArchiveReset = useRef<PreparedPortableArchiveReset | null>(null);

  useEffect(() => {
    const prepared = preparedPortableArchiveImport.current;
    if (
      prepared
      && (
        prepared.boundary.workspaceScopeKey !== workspaceScopeKeyRef.current
        || prepared.boundary.localChangeVersion !== localChangeVersion.current
      )
    ) {
      preparedPortableArchiveImport.current = null;
    }
    const reset = preparedPortableArchiveReset.current;
    if (
      reset
      && (
        reset.boundary.workspaceScopeKey !== workspaceScopeKeyRef.current
        || reset.boundary.localChangeVersion !== localChangeVersion.current
      )
    ) {
      preparedPortableArchiveReset.current = null;
    }
  }, [state, workspaceScopeKey]);

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

  const capturePortableArchiveBoundary = (): PortableArchiveBoundary => {
    const accountId = persistenceAccountId(activeAccount.current);
    const generation = persistenceScopeGenerations.current.get(accountId);
    if (generation === undefined) {
      throw new Error("The account persistence scope has not been loaded.");
    }
    return {
      accountId,
      authenticatedAccountId: authenticatedUserId.current,
      persistenceGeneration: generation,
      activeAccountId: activeAccount.current,
      workspaceGeneration: workspaceGeneration.current,
      workspaceScopeKey: workspaceScopeKeyRef.current,
      localChangeVersion: localChangeVersion.current,
    };
  };

  const portableArchiveBoundaryIsCurrent = (
    boundary: PortableArchiveBoundary,
    allowClosedWriterBarrier = false,
  ) => (
    boundary.activeAccountId === activeAccount.current
    && boundary.authenticatedAccountId === authenticatedUserId.current
    && boundary.accountId === persistenceAccountId(activeAccount.current)
    && boundary.persistenceGeneration
      === persistenceScopeGenerations.current.get(boundary.accountId)
    && boundary.workspaceGeneration === workspaceGeneration.current
    && boundary.workspaceScopeKey === workspaceScopeKeyRef.current
    && boundary.localChangeVersion === localChangeVersion.current
    && terminalErasureAccount.current === null
    && (allowClosedWriterBarrier || !accountSwitching.current)
  );

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
    stagedEvidence: readonly StagedEvidenceBlobWrite[] = [],
    options: WorkspaceWriteOptions = {},
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
      }, scopeGeneration, stagedEvidence, options);
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

  const recoverRemoteEvidenceCleanup = useCallback(async (
    accountId: string,
  ) => {
    const generation = persistenceScopeGenerations.current.get(accountId);
    if (generation === undefined) return;
    await recoverLocalEvidenceCleanupIntents(accountId, generation);
    const intents = await listEvidenceCleanupIntents(accountId, generation);
    if (!intents.length) return;
    const supabase = getSupabase();
    const bucket = supabase?.storage.from("evidence");
    if (!supabase || !bucket) return;
    for (const intent of intents) {
      if (!intent.remotePath) continue;
      await runClaimedRemoteEvidenceCleanup({
        claimCleanup: async () => {
          if (
            authenticatedUserId.current !== accountId
            || activeAccount.current !== accountId
            || accountSwitching.current
          ) {
            throw new Error("The active cloud account changed before evidence cleanup could be claimed.");
          }
          const claim = await claimPrivateEvidenceCleanup(
            supabase,
            accountId,
            [intent.remotePath!],
          );
          if (
            authenticatedUserId.current !== accountId
            || activeAccount.current !== accountId
            || accountSwitching.current
          ) {
            throw new Error("The active cloud account changed while evidence cleanup was being claimed.");
          }
          return claim.kind;
        },
        cancelCleanup: () => cancelEvidenceCleanupIntent(intent, generation),
        removeRemote: async () => {
          const removal = await bucket.remove([intent.remotePath!]);
          if (removal.error) throw removal.error;
        },
        completeCleanup: () => markEvidenceCleanupRemoteComplete(intent, generation),
      });
    }
    await recoverLocalEvidenceCleanupIntents(accountId, generation);
  }, []);

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
        persistWorkspace: async ({
          envelope,
          expectedScopeGeneration,
          stagedEvidence,
        }) => {
          ensureCurrent();
          if (
            persistenceScopeGenerations.current.get(envelope.accountId)
            !== expectedScopeGeneration
          ) {
            throw new LocalBootstrapSupersededError();
          }
          return persistWorkspace(envelope, stagedEvidence);
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
        try {
          // Signed-in cleanup waits until reconciliation proves the exact
          // cloud metadata. This preserves device-only bytes across an
          // ambiguous metadata-save response.
          if (result.accountId === persistenceAccountId(null)) {
            await recoverLocalEvidenceCleanupIntents(
              result.accountId,
              result.scope.generation,
            );
          }
          await cleanupAbandonedEvidenceStaging(
            result.accountId,
            result.scope.generation,
            abandonedEvidenceStagingCutoff(),
          );
          ensureCurrent();
        } catch (error) {
          if (error instanceof LocalBootstrapSupersededError) throw error;
          setPersistenceError(error instanceof Error
            ? `Old incomplete file staging could not be cleaned up yet: ${error.message}`
            : "Old incomplete file staging could not be cleaned up yet.");
        }
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
        try {
          if (nextAccount === null) {
            await recoverLocalEvidenceCleanupIntents(
              nextPersistenceAccountId,
              destination.scope.generation,
            );
          }
          await cleanupAbandonedEvidenceStaging(
            nextPersistenceAccountId,
            destination.scope.generation,
            abandonedEvidenceStagingCutoff(),
          );
        } catch (error) {
          setPersistenceError(error instanceof Error
            ? `Old incomplete file staging could not be cleaned up yet: ${error.message}`
            : "Old incomplete file staging could not be cleaned up yet.");
        }
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
          if (recovered.changed) {
            await persistWorkspace({
              accountId: envelope.accountId,
              state: recovered.state,
              history: recovered.history,
              dirty: nextDirty,
              revision: envelope.revision,
              serverUpdatedAt: envelope.serverUpdatedAt,
              savedAt: new Date().toISOString(),
              ...(envelope.anonymousHandoff
                ? { anonymousHandoff: envelope.anonymousHandoff }
                : {}),
            }, recovered.createdEvidence);
          }
          stagedEvidenceCommitted = true;
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
    const reconcile = async () => {
      const outcome = await runProviderCloudReconciliation(
        {
          accountId: syncAccountId,
          persistenceAccountId: persistenceAccountId(syncAccountId),
          workspaceGeneration: generation,
          workspaceScopeKey: reconciliationScopeKey,
          persistenceGeneration: persistenceScopeGenerations.current.get(
            persistenceAccountId(syncAccountId),
          ),
        },
        {
          inspectCurrentness: (boundary) => {
            if (
              boundary.workspaceGeneration !== workspaceGeneration.current
              || boundary.workspaceScopeKey !== workspaceScopeKeyRef.current
              || boundary.persistenceGeneration
                !== persistenceScopeGenerations.current.get(
                  boundary.persistenceAccountId,
                )
            ) {
              return { current: false, reason: "scope" };
            }
            if (activeAccount.current !== boundary.accountId) {
              return { current: false, reason: "account" };
            }
            if (pendingAccountHandoff.current) {
              return { current: false, reason: "handoff" };
            }
            if (accountSwitching.current) {
              return { current: false, reason: "switch" };
            }
            if (
              localConflictAccounts.current.has(
                boundary.persistenceAccountId,
              )
            ) {
              return { current: false, reason: "local-conflict" };
            }
            return { current: true };
          },
          readLocal: () => ({
            state: latestState.current,
            revision: revision.current,
            dirty: dirty.current,
            changeVersion: localChangeVersion.current,
          }),
          fetchRemote: async (accountId) => {
            const { data, error } = await supabase
              .from("workspace_snapshots")
              .select("state,revision,updated_at")
              .eq("user_id", accountId)
              .maybeSingle();
            return { data, error };
          },
          saveSnapshot: (snapshot, expectedRevision) =>
            saveWorkspaceSnapshotWithDeadline(
              supabase,
              syncAccountId,
              snapshot,
              expectedRevision,
            ),
          migrateState: migrateStoredState,
          prepareEvidence: externalizeEmbeddedEvidence,
          rollbackEvidence: async (evidence) => {
            await rollbackEvidenceWrites([...evidence]);
          },
          statesEqual: workspaceStatesEqual,
          parseRevision: parseWorkspaceRevision,
          isRevisionConflict: isWorkspaceRevisionConflict,
          readStoredStateVersion: (stored) => (
            typeof stored === "object"
            && stored !== null
            && "version" in stored
              ? stored.version
              : undefined
          ),
          currentStateVersion: CURRENT_STATE_VERSION,
          now: () => new Date().toISOString(),
          onPhase: setSyncStatus,
        },
      );
      if (
        outcome.kind === "superseded"
        || !isCurrentAccount()
        || reconciliationScopeKey !== workspaceScopeKeyRef.current
      ) return;

      if (outcome.kind === "remote-read-error") {
        setSyncStatus("error");
        return;
      }
      if (outcome.kind === "invalid-revision") {
        setSyncStatus("error");
        setPersistenceError(
          `Private sync ${outcome.phase === "initial" ? "returned" : "found"} an invalid ${outcome.source} workspace revision. Your device copy has not been overwritten.`,
        );
        return;
      }
      if (outcome.kind === "preparation-error") {
        if (outcome.error instanceof UnsupportedStoredWorkspaceVersionError) {
          quarantinedAccounts.current.add(persistenceAccountId(syncAccountId));
          remoteLoaded.current = false;
          reconciledAccount.current = null;
          setCloudWriteAllowed(false);
          setPersistenceError("This cloud workspace was created by a newer Evolvra version. Update the app before syncing so that newer data is not overwritten.");
        } else if (outcome.error instanceof WorkspaceImportError) {
          quarantinedAccounts.current.add(persistenceAccountId(syncAccountId));
          remoteLoaded.current = false;
          reconciledAccount.current = null;
          setCloudWriteAllowed(false);
          setPersistenceError("This cloud workspace failed structural validation and was quarantined. Your validated device copy was not overwritten.");
        } else {
          setPersistenceError("A legacy evidence file could not be moved into protected file storage. Export a backup before retrying sync.");
        }
        setSyncStatus("error");
        return;
      }
      if (outcome.kind === "saved-local") {
        revision.current = outcome.remote.revision;
        serverUpdatedAt.current = outcome.remote.updatedAt;
        remoteLoaded.current = true;
        reconciledAccount.current = syncAccountId;
        if (outcome.localUnchanged) dirty.current = false;
        setMetadataEpoch((value) => value + 1);
        setSyncStatus(outcome.localUnchanged ? "synced" : "saving");
        if (outcome.localUnchanged) {
          await recoverRemoteEvidenceCleanup(persistenceAccountId(syncAccountId));
        }
        return;
      }
      if (outcome.kind === "conflict") {
        const remote = mutableRemoteSnapshot(outcome.remote);
        remoteLoaded.current = false;
        reconciledAccount.current = null;
        setCloudWriteAllowed(false);
        remoteConflict.current = remote;
        setSyncConflict({
          remoteUpdatedAt: remote.updatedAt,
          localUpdatedAt: latestState.current.updatedAt,
        });
        setSyncStatus("conflict");
        return;
      }
      if (outcome.kind === "acknowledged") {
        try {
          await persistWorkspace({
            accountId: persistenceAccountId(syncAccountId),
            state: outcome.remote.state,
            history: trimWorkspaceHistory(history.current.map(clone)),
            dirty: outcome.remote.needsSave,
            revision: outcome.remote.revision,
            serverUpdatedAt: outcome.remote.updatedAt,
            savedAt: new Date().toISOString(),
          }, outcome.remote.createdEvidence);
        } catch (error) {
          await rollbackEvidenceWrites([...outcome.remote.createdEvidence]);
          throw error;
        }
        if (!isCurrentAccount()) return;
        revision.current = outcome.remote.revision;
        serverUpdatedAt.current = outcome.remote.updatedAt;
        remoteLoaded.current = true;
        reconciledAccount.current = syncAccountId;
        dirty.current = outcome.remote.needsSave;
        setMetadataEpoch((value) => value + 1);
        setSyncStatus(outcome.remote.needsSave ? "saving" : "synced");
        if (!outcome.remote.needsSave) {
          await recoverRemoteEvidenceCleanup(persistenceAccountId(syncAccountId));
        }
        return;
      }
      if (outcome.kind === "adopt-remote") {
        const replacementAccountId = persistenceAccountId(syncAccountId);
        const replacementPersistenceGeneration = persistenceScopeGenerations.current.get(
          replacementAccountId,
        );
        if (replacementPersistenceGeneration === undefined) {
          throw new Error("The account persistence scope changed before the cloud workspace could be adopted.");
        }
        const sourceState = clone(latestState.current);
        const sourceHistory = trimWorkspaceHistory(history.current.map(clone));
        const sourceChangeVersion = localChangeVersion.current;
        try {
          await commitAuthoritativeWorkspaceReplacement({
            accountId: replacementAccountId,
            persistenceGeneration: replacementPersistenceGeneration,
            sourceStates: [sourceState, ...sourceHistory],
            targetStates: [outcome.remote.state],
            persistTarget: async () => {
              if (
                !isCurrentAccount()
                || sourceChangeVersion !== localChangeVersion.current
                || !workspaceStatesEqual(sourceState, latestState.current)
              ) {
                throw new Error("The device workspace changed before the cloud copy could be committed.");
              }
              return persistWorkspace({
                accountId: replacementAccountId,
                state: outcome.remote.state,
                history: [],
                dirty: outcome.remote.needsSave,
                revision: outcome.remote.revision,
                serverUpdatedAt: outcome.remote.updatedAt,
                savedAt: new Date().toISOString(),
              }, outcome.remote.createdEvidence, {
                removeUnreferencedEvidence: true,
              });
            },
          });
        } catch (error) {
          await rollbackEvidenceWrites([...outcome.remote.createdEvidence]);
          throw error;
        }
        if (
          !isCurrentAccount()
          || sourceChangeVersion !== localChangeVersion.current
        ) return;
        revision.current = outcome.remote.revision;
        serverUpdatedAt.current = outcome.remote.updatedAt;
        remoteLoaded.current = true;
        reconciledAccount.current = syncAccountId;
        dirty.current = outcome.remote.needsSave;
        adoptRemoteWorkspace(outcome.remote.state);
        setMetadataEpoch((value) => value + 1);
        setSyncStatus(outcome.remote.needsSave ? "saving" : "synced");
        if (!outcome.remote.needsSave) {
          await recoverRemoteEvidenceCleanup(persistenceAccountId(syncAccountId));
        }
        return;
      }

      remoteLoaded.current = false;
      reconciledAccount.current = null;
      setCloudWriteAllowed(false);
      if (outcome.kind === "error") {
        if (outcome.error instanceof UnsupportedStoredWorkspaceVersionError) {
          quarantinedAccounts.current.add(persistenceAccountId(syncAccountId));
          setPersistenceError("Private sync returned a workspace created by a newer Evolvra version. No device or cloud data was overwritten.");
          setSyncStatus("error");
          return;
        }
        if (outcome.error instanceof WorkspaceImportError) {
          quarantinedAccounts.current.add(persistenceAccountId(syncAccountId));
          setPersistenceError("Private sync returned a structurally invalid workspace. It was quarantined and no device or cloud data was overwritten.");
          setSyncStatus("error");
          return;
        }
        setPersistenceError(outcome.error instanceof Error
          ? `Private sync could not finish: ${outcome.error.message}`
          : "Private sync could not finish. Your device copy remains available.");
        setSyncStatus("error");
        return;
      }
      setAccountEpoch((value) => value + 1);
      setSyncStatus("connecting");
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
  }, [accountEpoch, accountIsQuarantined, adoptRemoteWorkspace, authResolved, persistWorkspace, ready, recoverRemoteEvidenceCleanup, user, workspaceOperations]);

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
          const outcome = await runProviderCloudSave(
            {
              boundary: {
                accountId: syncAccountId,
                workspaceGeneration: generation,
                workspaceScopeKey: cloudSaveScopeKey,
              },
              snapshot: state,
              expectedRevision,
              changeVersion: saveVersion,
            },
            {
              saveSnapshot: (snapshot, targetRevision) =>
                saveWorkspaceSnapshotWithDeadline(
                  supabase,
                  syncAccountId,
                  snapshot,
                  targetRevision,
                ),
              inspectCurrentness: (boundary) => {
                if (
                  boundary.workspaceGeneration !== workspaceGeneration.current
                  || boundary.workspaceScopeKey !== workspaceScopeKeyRef.current
                ) {
                  return { current: false, reason: "scope" };
                }
                if (
                  activeAccount.current !== boundary.accountId
                  || reconciledAccount.current !== boundary.accountId
                ) {
                  return { current: false, reason: "account" };
                }
                if (
                  accountSwitching.current
                  || localConflictAccounts.current.has(
                    persistenceAccountId(boundary.accountId),
                  )
                ) {
                  return { current: false, reason: "write-gate" };
                }
                return { current: true };
              },
              readChangeVersion: () => localChangeVersion.current,
              parseRevision: parseWorkspaceRevision,
              isRevisionConflict: isWorkspaceRevisionConflict,
            },
          );

          switch (outcome.kind) {
            case "superseded":
              return;
            case "saved":
              revision.current = outcome.revision;
              serverUpdatedAt.current = outcome.updatedAt;
              if (outcome.localUnchanged) dirty.current = false;
              setMetadataEpoch((value) => value + 1);
              setSyncStatus(outcome.localUnchanged ? "synced" : "saving");
              if (outcome.localUnchanged) {
                await recoverRemoteEvidenceCleanup(persistenceAccountId(syncAccountId));
              }
              return;
            case "revision-conflict":
            case "error":
              remoteLoaded.current = false;
              reconciledAccount.current = null;
              setCloudWriteAllowed(false);
              setSyncStatus(outcome.kind === "revision-conflict" ? "conflict" : "error");
              setAccountEpoch((value) => value + 1);
              return;
            case "malformed-response":
              remoteLoaded.current = false;
              reconciledAccount.current = null;
              setCloudWriteAllowed(false);
              setPersistenceError("Private sync saved an unexpected response. Your device copy is still marked as unsaved.");
              setSyncStatus("error");
              return;
            case "ambiguous":
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
              return;
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
  }, [accountIsQuarantined, authResolved, localPersistenceEpoch, localPersistenceIsPending, metadataEpoch, ready, recoverRemoteEvidenceCleanup, state, syncConflict, user, workspaceOperations]);

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
  const flushWorkspaceDurably = useCallback(async (
    expectedScopeKey: WorkspaceScopeKey,
    stagedEvidence: readonly StagedEvidenceBlobWrite[] = [],
  ) => {
    const scopeIsCurrent = () => expectedScopeKey === workspaceScopeKeyRef.current
      && workspaceOperations.isActive(expectedScopeKey)
      && !accountSwitching.current;
    const retainLocalOnDefiniteCloudFailure = stagedEvidence.length > 0;
    let pendingStagedEvidence = stagedEvidence;
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
      const dirtyPersisted = await persistWorkspace({
        accountId,
        state: snapshot,
        history: snapshotHistory,
        dirty: true,
        revision: revision.current,
        serverUpdatedAt: serverUpdatedAt.current,
        savedAt: new Date().toISOString(),
      }, pendingStagedEvidence);
      pendingStagedEvidence = [];
      if (!scopeIsCurrent()) throw new Error("The active workspace changed while metadata was being saved.");
      if (changeVersion !== localChangeVersion.current) continue;

      const cloudAccountId = activeAccount.current;
      if (!cloudAccountId) return dirtyPersisted.localRevision;
      let cloudConfirmed = false;
      try {
        if (!user || user.id !== cloudAccountId || !cloudWriteAllowed) {
          throw new Error("Private cloud reconciliation must finish before file metadata can be committed.");
        }
        const supabase = getSupabase();
        if (!supabase) throw new Error("Cloud storage is unavailable.");
        setSyncStatus("saving");
        const expectedCloudRevision = revision.current;
        const saved = await saveGoalEvidenceCloudMetadataWithVerification({
          state: snapshot,
          expectedRevision: expectedCloudRevision,
          save: () => saveWorkspaceSnapshotWithDeadline(
            supabase,
            cloudAccountId,
            snapshot,
            expectedCloudRevision,
          ),
          readAuthoritative: async () => {
            const response = await supabase
              .from("workspace_snapshots")
              .select("state,revision,updated_at")
              .eq("user_id", cloudAccountId)
              .maybeSingle();
            return response;
          },
          migrateState: migrateStoredState,
          statesEqual: workspaceStatesEqual,
          parseRevision: parseWorkspaceRevision,
        });
        cloudConfirmed = true;
        if (
          !scopeIsCurrent()
          || activeAccount.current !== cloudAccountId
          || authenticatedUserId.current !== cloudAccountId
        ) {
          throw new Error("The active account changed while file metadata was being saved.");
        }
        revision.current = saved.revision;
        serverUpdatedAt.current = saved.updatedAt;
        if (changeVersion !== localChangeVersion.current) {
          dirty.current = true;
          continue;
        }
        dirty.current = false;
        const cleanPersisted = await persistWorkspace({
          accountId,
          state: snapshot,
          history: snapshotHistory,
          dirty: false,
          revision: saved.revision,
          serverUpdatedAt: saved.updatedAt,
          savedAt: new Date().toISOString(),
        });
        remoteLoaded.current = true;
        reconciledAccount.current = cloudAccountId;
        setMetadataEpoch((value) => value + 1);
        setSyncStatus("synced");
        return cleanPersisted.localRevision;
      } catch (error) {
        const ambiguous = error instanceof GoalEvidenceCloudSaveAmbiguousError;
        if (ambiguous) {
          remoteLoaded.current = false;
          reconciledAccount.current = null;
          setCloudWriteAllowed(false);
          setSyncStatus("connecting");
          setAccountEpoch((value) => value + 1);
        }
        if (retainLocalOnDefiniteCloudFailure || ambiguous || cloudConfirmed) {
          dirty.current = true;
          throw new GoalEvidenceLocalCommitRetainedError(
            error,
            dirtyPersisted.localRevision,
            ambiguous,
          );
        }
        throw error;
      }
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

  const goalEvidenceScopeIsCurrent = (scope: GoalEvidenceOperationScope) => (
    scope.workspaceScopeKey === workspaceScopeKeyRef.current
    && scope.workspaceGeneration === workspaceGeneration.current
    && scope.persistenceAccountId === persistenceAccountId(activeAccount.current)
    && scope.persistenceGeneration
      === persistenceScopeGenerations.current.get(scope.persistenceAccountId)
    && scope.authenticatedAccountId === authenticatedUserId.current
    && workspaceOperations.isActive(scope.workspaceScopeKey)
    && !accountSwitching.current
    && terminalErasureAccount.current === null
  );

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
      restoreWorkspace: (
        { state: restoredState, history: restoredHistory },
        expectedCurrent,
      ) => {
        if (expectedCurrent && (
          !workspaceStatesEqual(latestState.current, expectedCurrent.state)
          || history.current.length !== expectedCurrent.history.length
          || history.current.some((item, index) =>
            !workspaceStatesEqual(item, expectedCurrent.history[index]))
        )) return false;
        replaceWorkspaceInMemory(restoredState, [...restoredHistory]);
        return true;
      },
      flushDurably: (scope, stagedEvidence) => flushWorkspaceDurably(
        scope.workspaceScopeKey,
        stagedEvidence,
      ),
    },
    scope: {
      isCurrent: goalEvidenceScopeIsCurrent,
      runExclusive: (scope, operation) => runWorkspaceFileOperation(
        scope.workspaceScopeKey,
        operation,
      ),
    },
    localEvidence: {
      list: (accountId, goalId, generation) =>
        listEvidenceBlobs(accountId, goalId, generation),
      remove: (snapshots, generation, committedWorkspaceLocalRevision) => deleteEvidenceBlobs(
        snapshots,
        generation,
        committedWorkspaceLocalRevision,
      ),
      stageCleanup: stageEvidenceCleanupIntent,
      cancelCleanup: cancelEvidenceCleanupIntent,
    },
    remoteEvidence: {
      assertWriteAllowed: () => {
        if (!cloudWriteAllowed) {
          throw new Error("Finish the pending workspace or sync choice before deleting cloud evidence.");
        }
      },
      claim: async (paths) => {
        const accountId = activeAccount.current;
        const supabase = getSupabase();
        if (
          !accountId
          || !supabase
          || authenticatedUserId.current !== accountId
          || accountSwitching.current
        ) {
          throw new Error("The active cloud account changed before evidence cleanup could be claimed.");
        }
        const claim = await claimPrivateEvidenceCleanup(
          supabase,
          accountId,
          paths,
        );
        if (
          activeAccount.current !== accountId
          || authenticatedUserId.current !== accountId
          || accountSwitching.current
        ) {
          throw new Error("The active cloud account changed while evidence cleanup was being claimed.");
        }
        return claim.kind;
      },
      remove: async (paths) => {
        if (!paths.length) return;
        const bucket = getSupabase()?.storage.from("evidence");
        if (!bucket) throw new Error("Cloud storage is unavailable.");
        const { error } = await bucket.remove([...paths]);
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
      async setGoalFileEvidence(
        goalId,
        evidence,
        expectedWorkspaceScopeKey,
        stagedEvidence = [],
      ) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        return goalEvidenceActions().setGoalFileEvidence({
          goalId,
          evidence,
          scope,
          stagedEvidence,
        });
      },
      async readGoalEvidenceBlob(goalId, evidenceId, expectedWorkspaceScopeKey) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        if (!goalEvidenceScopeIsCurrent(scope)) {
          throw new Error("The active workspace changed before evidence could be read.");
        }
        return readEvidenceBlob(
          scope.persistenceAccountId,
          goalId,
          evidenceId,
          scope.persistenceGeneration,
        );
      },
      async stageGoalEvidenceBlob(goalId, evidenceId, blob, expectedWorkspaceScopeKey) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        if (!goalEvidenceScopeIsCurrent(scope)) {
          throw new Error("The active workspace changed before evidence could be staged.");
        }
        const staged = await stageEvidenceBlob({
          accountId: scope.persistenceAccountId,
          goalId,
          evidenceId,
          blob,
        }, scope.persistenceGeneration);
        return { ...staged, scopeGeneration: scope.persistenceGeneration };
      },
      async rollbackGoalEvidenceStage(staged, expectedWorkspaceScopeKey) {
        // Token-only rollback is deliberately safe even after a scope switch;
        // it cannot touch live evidence.
        void expectedWorkspaceScopeKey;
        await rollbackStagedEvidenceBlob(staged, staged.scopeGeneration);
      },
      async cacheGoalEvidenceBlob(
        goalId,
        evidenceId,
        blob,
        expectedWorkspaceScopeKey,
      ) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        if (!goalEvidenceScopeIsCurrent(scope)) {
          throw new Error("The active workspace changed before evidence could be cached.");
        }
        const referenced = latestState.current.goals
          .find((goal) => goal.id === goalId)?.evidence
          .some((item) => item.type === "file" && item.id === evidenceId);
        if (!referenced) {
          throw new Error("The workspace no longer references this evidence file.");
        }
        return storeEvidenceBlob({
          accountId: scope.persistenceAccountId,
          goalId,
          evidenceId,
          blob,
        }, scope.persistenceGeneration, expectedLocalRevisions.current.get(
          scope.persistenceAccountId,
        ) ?? 0);
      },
      async deleteGoalEvidenceBlobs(
        snapshots,
        committedWorkspaceLocalRevision,
        expectedWorkspaceScopeKey,
      ) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        if (!goalEvidenceScopeIsCurrent(scope)) {
          throw new Error("The active workspace changed before evidence could be deleted.");
        }
        return deleteEvidenceBlobs(
          snapshots,
          scope.persistenceGeneration,
          committedWorkspaceLocalRevision
            ?? (expectedLocalRevisions.current.get(scope.persistenceAccountId) ?? 0),
        );
      },
      async restoreGoalEvidenceBlobs(receipt, expectedWorkspaceScopeKey) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        if (!goalEvidenceScopeIsCurrent(scope)) {
          throw new Error("The active workspace changed before evidence could be restored.");
        }
        return restoreEvidenceBlobs(receipt);
      },
      async stageGoalEvidenceCleanup(
        snapshot,
        goalId,
        evidenceId,
        remotePath,
        expectedWorkspaceScopeKey,
      ) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        if (!goalEvidenceScopeIsCurrent(scope)) {
          throw new Error("The active workspace changed before evidence cleanup could be journaled.");
        }
        if (!snapshot && !remotePath) return null;
        if (snapshot && (
          snapshot.accountId !== scope.persistenceAccountId
          || snapshot.goalId !== goalId
          || snapshot.evidenceId !== evidenceId
          || !snapshot.writeId
        )) {
          throw new Error("The device evidence cleanup snapshot is stale or invalid.");
        }
        return stageEvidenceCleanupIntent({
          accountId: scope.persistenceAccountId,
          goalId,
          evidenceId,
          ...(snapshot?.writeId ? { expectedWriteId: snapshot.writeId } : {}),
          ...(remotePath ? { remotePath } : {}),
        }, scope.persistenceGeneration);
      },
      async cancelGoalEvidenceCleanup(intent, expectedWorkspaceScopeKey) {
        const scope = captureGoalEvidenceScope(expectedWorkspaceScopeKey);
        if (intent.accountId !== scope.persistenceAccountId) {
          throw new Error("The evidence cleanup journal belongs to another account.");
        }
        await cancelEvidenceCleanupIntent(intent, scope.persistenceGeneration);
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
                    migrated.createdEvidence,
                  )
                : await persistWorkspace(
                    replacementEnvelope,
                    migrated.createdEvidence,
                  );
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
      async exportPortableWorkspaceArchive(options = {}) {
        if (accountSwitching.current) {
          throw new Error("Wait for the active workspace to finish opening before creating a full backup.");
        }
        const prepareForAccountErasure = options.prepareForAccountErasure === true;
        const boundary = capturePortableArchiveBoundary();
        if (
          prepareForAccountErasure
          && (
            !boundary.authenticatedAccountId
            || boundary.activeAccountId !== boundary.authenticatedAccountId
            || boundary.accountId !== boundary.authenticatedAccountId
          )
        ) {
          throw new Error("Only the exact active signed-in account can create an account-erasure backup.");
        }
        return workspaceOperations.run(
          boundary.workspaceScopeKey,
          async () => {
            await localWriteQueues.current.get(boundary.accountId);
            if (!portableArchiveBoundaryIsCurrent(boundary)) {
              throw new Error("The active workspace changed before full backup creation could begin.");
            }
            let localBackupBoundary = await readAccountPersistenceBackupBoundary(
              boundary.accountId,
            );
            if (
              localBackupBoundary.generation !== boundary.persistenceGeneration
              || localBackupBoundary.workspaceLocalRevision
                !== (expectedLocalRevisions.current.get(boundary.accountId) ?? 0)
            ) {
              throw new Error("The device workspace or evidence changed before full backup creation could begin.");
            }
            const snapshot = clone(latestState.current);
            const createdAt = new Date().toISOString();
            const supabase = getSupabase();
            let cloudBackupBoundary: AccountErasureCloudBackupBoundary | null = null;
            let strictEvidence: EvidenceBlobRecord[] | null = null;
            let remotePathsBefore: string[] = [];
            if (prepareForAccountErasure) {
              if (
                !supabase
                || !cloudWriteAllowed
                || !remoteLoaded.current
                || reconciledAccount.current !== boundary.accountId
                || dirty.current
                || syncStatus !== "synced"
                || remoteConflict.current
                || pendingAccountHandoff.current
                || accountIsQuarantined(boundary.accountId)
              ) {
                throw new Error("Private sync must be fully up to date before creating an account-erasure backup.");
              }
              await recoverRemoteEvidenceCleanup(boundary.accountId);
              if (!portableArchiveBoundaryIsCurrent(boundary)) {
                throw new Error("The active workspace changed while incomplete evidence cleanup was recovered.");
              }
              localBackupBoundary = await readAccountPersistenceBackupBoundary(
                boundary.accountId,
              );
              if (
                localBackupBoundary.generation !== boundary.persistenceGeneration
                || localBackupBoundary.workspaceLocalRevision
                  !== (expectedLocalRevisions.current.get(boundary.accountId) ?? 0)
              ) {
                throw new Error("The device workspace changed while incomplete evidence cleanup was recovered.");
              }
              cloudBackupBoundary = await readAccountErasureBackupBoundary(
                supabase,
                boundary.accountId,
              );
              if (cloudBackupBoundary.workspaceRevision !== revision.current) {
                throw new Error("The cloud workspace changed on another device. Reconcile it before creating an account-erasure backup.");
              }

              remotePathsBefore = await listPrivateEvidencePaths(
                supabase,
                boundary.accountId,
              );
              const localEvidence = await listEvidenceBlobs(
                boundary.accountId,
                undefined,
                boundary.persistenceGeneration,
              );
              const evidenceByKey = new Map(localEvidence.map((record) => [
                `${record.goalId}\u0000${record.evidenceId}`,
                record,
              ]));
              const expectedRemotePaths: string[] = [];
              for (const goal of snapshot.goals) {
                for (const evidence of goal.evidence) {
                  if (evidence.type !== "file" || !evidence.remotePath) continue;
                  const path = remoteEvidencePath(
                    evidence,
                    boundary.accountId,
                    goal.id,
                  );
                  if (!path) {
                    throw new Error("A private evidence path is invalid. No account-erasure backup was created.");
                  }
                  expectedRemotePaths.push(path);
                  const bucket = supabase.storage.from("evidence");
                  const { data, error } = await bucket.download(path);
                  if (error || !data) {
                    throw error ?? new Error("A private evidence file could not be downloaded for the account-erasure backup.");
                  }
                  const verified = normalizedEvidenceBlob(data, evidence);
                  if (!verified) {
                    throw new Error(`The private cloud copy of "${evidence.name}" does not match its recorded type and size. No account-erasure backup was created.`);
                  }
                  evidenceByKey.set(`${goal.id}\u0000${evidence.id}`, {
                    accountId: boundary.accountId,
                    goalId: goal.id,
                    evidenceId: evidence.id,
                    blob: verified,
                    savedAt: createdAt,
                  });
                }
              }
              if (!stringSetsEqual(remotePathsBefore, expectedRemotePaths)) {
                throw new Error("Private cloud evidence contains missing or unreferenced files. Resolve that inventory before erasing the account.");
              }
              strictEvidence = [...evidenceByKey.values()];
            }
            const artifact = await createCompletePortableArchive({
              state: snapshot,
              boundary,
              createdAt,
              isCurrent: () => portableArchiveBoundaryIsCurrent(boundary),
              listLocalEvidence: (accountId, generation) =>
                strictEvidence
                  ? Promise.resolve(strictEvidence)
                  : listEvidenceBlobs(accountId, undefined, generation),
              requireExactAuthenticatedAccount: async (accountId) => {
                const supabase = getSupabase();
                if (!supabase) {
                  throw new Error("Private cloud access is unavailable. No full backup was downloaded.");
                }
                const { data, error } = await supabase.auth.getUser();
                if (error) throw error;
                if (data.user?.id !== accountId) {
                  throw new Error("The authenticated account changed before private evidence could be included.");
                }
              },
              downloadRemoteEvidence: async (path) => {
                const bucket = getSupabase()?.storage.from("evidence");
                if (!bucket) {
                  throw new Error("Private cloud Storage is unavailable. No full backup was downloaded.");
                }
                const { data, error } = await bucket.download(path);
                if (error || !data) {
                  throw error ?? new Error("A private evidence file could not be downloaded.");
                }
                return data;
              },
            });
            if (!portableArchiveBoundaryIsCurrent(boundary)) {
              throw new Error("The active workspace changed before the full backup download was ready.");
            }
            const finalLocalBackupBoundary = await readAccountPersistenceBackupBoundary(
              boundary.accountId,
            );
            if (!localBackupBoundariesEqual(
              localBackupBoundary,
              finalLocalBackupBoundary,
            )) {
              throw new Error("The device workspace or evidence changed while its backup was created. Download a fresh full backup before resetting anything.");
            }
            if (prepareForAccountErasure) {
              if (!cloudBackupBoundary || !supabase) {
                throw new Error("The cloud backup boundary was not captured.");
              }
              if (artifact.report.orphanedEvidence.length) {
                throw new Error("Device evidence contains unreferenced files. Resolve that inventory before erasing the account.");
              }
              const [finalCloudBoundary, remotePathsAfter] = await Promise.all([
                readAccountErasureBackupBoundary(supabase, boundary.accountId),
                listPrivateEvidencePaths(supabase, boundary.accountId),
              ]);
              if (
                !cloudBackupBoundariesEqual(cloudBackupBoundary, finalCloudBoundary)
                || finalCloudBoundary.workspaceRevision !== revision.current
                || !stringSetsEqual(remotePathsBefore, remotePathsAfter)
                || !portableArchiveBoundaryIsCurrent(boundary)
              ) {
                throw new Error("The private cloud workspace or evidence changed while its backup was created. Download a fresh full backup before erasing anything.");
              }
            }
            const resetReceiptToken = globalThis.crypto.randomUUID();
            preparedPortableArchiveReset.current = {
              token: resetReceiptToken,
              boundary,
              localBoundary: finalLocalBackupBoundary,
              cloudBackupBoundary,
            };
            return {
              blob: artifact.blob,
              fileName: `evolvra-full-backup-${createdAt.slice(0, 10)}.evolvra`,
              evidenceFiles: artifact.report.includedEvidence.length,
              evidenceBytes: artifact.report.evidenceBytes,
              resetReceiptToken,
            };
          },
          () => portableArchiveBoundaryIsCurrent(boundary),
        );
      },
      async inspectPortableWorkspaceArchive(archive) {
        if (
          remoteConflict.current
          || syncConflict
          || pendingAccountHandoff.current
          || accountHandoff
        ) {
          throw new Error("Resolve the active source-of-truth choice before restoring a portable backup. Neither copy was changed.");
        }
        if (accountSwitching.current) {
          throw new Error("Wait for the active workspace to finish opening before inspecting a full backup.");
        }
        const boundary = capturePortableArchiveBoundary();
        const importedAt = new Date().toISOString();
        return workspaceOperations.run(
          boundary.workspaceScopeKey,
          async () => {
            const current = clone(latestState.current);
            const plan = await inspectAndPreparePortableWorkspaceArchiveImport(
              current,
              archive,
              importedAt,
            );
            if (!portableArchiveBoundaryIsCurrent(boundary)) {
              throw new Error("The active workspace changed while the full backup was being inspected. Select it again.");
            }
            if (remoteConflict.current || pendingAccountHandoff.current) {
              throw new Error("A source-of-truth choice appeared while the backup was being inspected. Resolve it, then select the file again.");
            }
            const token = globalThis.crypto.randomUUID();
            preparedPortableArchiveImport.current = {
              token,
              boundary,
              importedAt,
              plan,
            };
            return {
              token,
              archiveCreatedAt: plan.archiveCreatedAt,
              archiveWorkspaceUpdatedAt: plan.archiveWorkspaceUpdatedAt,
              importedEvidenceFiles: plan.importedEvidenceFiles,
              importedEvidenceBytes: plan.importedEvidenceBytes,
            };
          },
          () => portableArchiveBoundaryIsCurrent(boundary),
        );
      },
      discardPortableWorkspaceArchiveImport(token) {
        if (preparedPortableArchiveImport.current?.token === token) {
          preparedPortableArchiveImport.current = null;
        }
      },
      async applyPortableWorkspaceArchive(token, choice) {
        const prepared = preparedPortableArchiveImport.current;
        preparedPortableArchiveImport.current = null;
        if (!prepared || prepared.token !== token) {
          throw new Error("This full-backup preview is no longer active. Select the file again.");
        }
        const { boundary, importedAt, plan } = prepared;
        if (
          remoteConflict.current
          || syncConflict
          || pendingAccountHandoff.current
          || accountHandoff
        ) {
          throw new Error("Resolve the active source-of-truth choice before restoring a portable backup. Neither copy was changed.");
        }
        if (accountIsQuarantined(boundary.accountId)) {
          throw new Error("Resolve the device recovery blocker before restoring a portable backup. Neither copy was changed.");
        }
        if (!portableArchiveBoundaryIsCurrent(boundary)) {
          throw new Error("The workspace changed after the backup preview. Select the file again before restoring it.");
        }
        const decision = choice === "merge" ? plan.merge : plan.replace;
        const previousCloudWriteAllowed = cloudWriteAllowed;
        const nextState = clone(decision.state);
        const nextHistory: AppState[] = [];
        accountSwitching.current = true;
        setWorkspaceSwitching(true);
        setCloudWriteAllowed(false);
        try {
          const result = await workspaceOperations.run(
            boundary.workspaceScopeKey,
            async () => {
              await localWriteQueues.current.get(boundary.accountId);
              if (
                !portableArchiveBoundaryIsCurrent(boundary, true)
                || remoteConflict.current
                || pendingAccountHandoff.current
              ) {
                throw new Error("The active workspace changed before the portable backup could be restored.");
              }
              const sourceState = clone(latestState.current);
              const sourceHistory = trimWorkspaceHistory(history.current.map(clone));
              const envelope: WorkspaceEnvelope = {
                accountId: boundary.accountId,
                state: nextState,
                history: nextHistory,
                dirty: true,
                localRevision: expectedLocalRevisions.current.get(
                  boundary.accountId,
                ) ?? 0,
                revision: revision.current,
                serverUpdatedAt: serverUpdatedAt.current,
                savedAt: importedAt,
              };
              const persistArchive = () => applyPortableArchivePersistence({
                kind: choice,
                envelope,
                evidence: decision.evidenceWrites.map((item) => ({
                  accountId: boundary.accountId,
                  goalId: item.targetGoalId,
                  evidenceId: item.targetEvidenceId,
                  blob: item.blob,
                  savedAt: importedAt,
                })),
              }, boundary.persistenceGeneration);
              if (
                choice !== "replace"
                || boundary.authenticatedAccountId !== boundary.accountId
              ) return persistArchive();

              const replacement = await commitAuthoritativeWorkspaceReplacement({
                accountId: boundary.accountId,
                persistenceGeneration: boundary.persistenceGeneration,
                sourceStates: [sourceState, ...sourceHistory],
                targetStates: [nextState],
                persistTarget: async () => {
                  if (
                    !portableArchiveBoundaryIsCurrent(boundary, true)
                    || !workspaceStatesEqual(sourceState, latestState.current)
                  ) {
                    throw new Error("The active workspace changed before replacement cleanup could be committed.");
                  }
                  return persistArchive();
                },
              });
              return replacement.result;
            },
            () => portableArchiveBoundaryIsCurrent(boundary, true),
          );
          if (!portableArchiveBoundaryIsCurrent(boundary, true)) {
            throw new Error("The backup was restored to the previous workspace, but the active workspace changed before it could be opened.");
          }

          expectedLocalRevisions.current.set(
            boundary.accountId,
            result.envelope.localRevision,
          );
          history.current = nextHistory;
          setPersistenceError(null);
          dirty.current = true;
          localChangeVersion.current += 1;
          latestState.current = nextState;
          setCanUndo(false);
          setState(nextState);
          advanceWorkspaceScope("import");
          accountSwitching.current = false;
          setWorkspaceSwitching(false);
          setCloudWriteAllowed(previousCloudWriteAllowed);
          setSyncStatus(boundary.authenticatedAccountId ? "saving" : "local");
          setMetadataEpoch((value) => value + 1);
          return {
            choice,
            importedEvidenceFiles: decision.evidenceWrites.length,
            importedEvidenceBytes: decision.evidenceWrites.reduce(
              (total, item) => total + item.blob.size,
              0,
            ),
            removedSupersededEvidence: result.removedSupersededEvidence,
            cleanupWarning: null,
          };
        } catch (error) {
          if (error instanceof LocalWorkspaceConflictError) {
            quarantineLocalConflict(error);
          }
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
        } finally {
          if (portableArchiveBoundaryIsCurrent(boundary, true)) {
            accountSwitching.current = false;
            setWorkspaceSwitching(false);
            setCloudWriteAllowed(previousCloudWriteAllowed);
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
      async beginActiveAccountErasure(
        expectedAccountId,
        backupReceiptToken,
        armFence,
      ) {
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
        const backupReceipt = preparedPortableArchiveReset.current;
        if (
          !backupReceipt
          || backupReceipt.token !== backupReceiptToken
          || backupReceipt.boundary.accountId !== target
          || backupReceipt.boundary.activeAccountId !== target
          || backupReceipt.boundary.authenticatedAccountId !== target
          || backupReceipt.cloudBackupBoundary === null
          || !portableArchiveBoundaryIsCurrent(backupReceipt.boundary)
          || (expectedLocalRevisions.current.get(target) ?? 0)
            !== backupReceipt.localBoundary.workspaceLocalRevision
          || expectedPersistenceGeneration !== backupReceipt.localBoundary.generation
        ) {
          preparedPortableArchiveReset.current = null;
          throw new Error("That backup confirmation is no longer valid for this exact account revision. Download a fresh full backup before erasing anything.");
        }

        // Consume the receipt before the first asynchronous cloud check. This
        // prevents two callers from both presenting the same token while that
        // check is in flight; every failed or interrupted attempt must start
        // again from a newly downloaded exact-revision backup.
        preparedPortableArchiveReset.current = null;

        const supabase = getSupabase();
        if (!supabase || !backupReceipt.cloudBackupBoundary) {
          throw new Error("Private cloud access is unavailable for the account-erasure backup check.");
        }
        const [liveCloudBoundary, liveLocalBoundary] = await Promise.all([
          readAccountErasureBackupBoundary(supabase, target),
          readAccountPersistenceBackupBoundary(target),
        ]);
        if (
          !cloudBackupBoundariesEqual(
            backupReceipt.cloudBackupBoundary,
            liveCloudBoundary,
          )
          || !localBackupBoundariesEqual(
            backupReceipt.localBoundary,
            liveLocalBoundary,
          )
          || !portableArchiveBoundaryIsCurrent(backupReceipt.boundary)
        ) {
          throw new Error("The private cloud workspace or evidence changed after the backup. Download a fresh full backup before erasing anything.");
        }

        const outgoingScopeKey = workspaceScopeKeyRef.current;
        const backupBoundary = backupReceipt.boundary;
        const backupLocalBoundary = backupReceipt.localBoundary;
        const cloudBackupBoundary = backupReceipt.cloudBackupBoundary;
        if (!cloudBackupBoundary) {
          throw new Error("A connected account needs a cloud-stable full backup before erasure.");
        }
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
            || backupBoundary.workspaceGeneration !== workspaceGeneration.current
            || backupBoundary.workspaceScopeKey !== workspaceScopeKeyRef.current
            || backupBoundary.localChangeVersion !== localChangeVersion.current
            || backupBoundary.persistenceGeneration
              !== persistenceScopeGenerations.current.get(target)
            || (expectedLocalRevisions.current.get(target) ?? 0)
              !== backupLocalBoundary.workspaceLocalRevision
          ) {
            throw new Error("The exact signed-in account or workspace revision changed after its backup. Download a fresh full backup before erasing anything.");
          }
          const scope = await armFence(
            expectedPersistenceGeneration,
            backupLocalBoundary.workspaceLocalRevision,
            backupLocalBoundary.evidenceRevision,
            cloudBackupBoundary,
          );
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
          // failure. Refresh its durable state. Reopen only when that read
          // proves the atomic transaction left the scope unfenced.
          let durableScope: AccountPersistenceScope | null = null;
          try {
            durableScope = await readAccountPersistenceScope(target);
            persistenceScopeGenerations.current.set(target, durableScope.generation);
            setPersistenceScopeGeneration(durableScope.generation);
          } catch {
            // The original failure remains the useful diagnostic.
          }
          if (durableScope && !durableScope.tombstoned) {
            terminalErasureAccount.current = null;
            setTerminalErasureAccountId(null);
            const identityStillCurrent = activeAccount.current === target
              && authenticatedUserId.current === target
              && workspaceScopeKeyRef.current === outgoingScopeKey;
            if (identityStillCurrent) {
              accountSwitching.current = false;
              setWorkspaceSwitching(false);
              advanceWorkspaceScope("reset");
              if (error instanceof LocalWorkspaceConflictError) {
                quarantineLocalConflict(error);
              } else {
                setAccountEpoch((value) => value + 1);
              }
            }
          }
          setPersistenceError(error instanceof Error
            ? error.message
            : "The account erasure fence could not be armed safely.");
          setSyncStatus("error");
          throw error;
        }
      },
      async cancelActiveAccountErasure(
        expectedAccountId,
        tombstonedGeneration,
        cancelFence,
      ) {
        const target = workspaceKey(expectedAccountId);
        if (
          target === persistenceAccountId(null)
          || terminalErasureAccount.current !== target
          || activeAccount.current !== target
          || authenticatedUserId.current !== target
          || persistenceScopeGenerations.current.get(target)
            !== tombstonedGeneration
        ) {
          throw new Error("Only the exact active terminal account can cancel an unstarted cloud deletion.");
        }
        try {
          const restored = await cancelFence();
          if (
            restored.accountId !== target
            || restored.tombstoned
            || restored.generation <= tombstonedGeneration
          ) {
            throw new Error("The local account-erasure cancellation did not return a fresh writable scope.");
          }
          persistenceScopeGenerations.current.set(target, restored.generation);
          setPersistenceScopeGeneration(restored.generation);
          terminalErasureAccount.current = null;
          setTerminalErasureAccountId(null);
          accountSwitching.current = false;
          setWorkspaceSwitching(false);
          remoteLoaded.current = false;
          reconciledAccount.current = null;
          setCloudWriteAllowed(false);
          advanceWorkspaceScope("reset");
          setPersistenceError("The cloud account changed after that backup, so erasure was cancelled before any cloud data was deleted. Reconcile and download a fresh backup.");
          setSyncStatus("connecting");
          setAccountEpoch((value) => value + 1);
          return restored;
        } catch (error) {
          // Without a proved cancellation result the permanent barrier stays
          // closed; a later recovery may inspect server lifecycle safely.
          setPersistenceError(error instanceof Error
            ? error.message
            : "The unstarted cloud deletion could not be cancelled safely.");
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
            if (recovered.changed) {
              await persistWorkspace({
                accountId: anonymousAccountId,
                state: recovered.state,
                history: recovered.history,
                dirty: nextDirty,
                revision: envelope.revision,
                serverUpdatedAt: envelope.serverUpdatedAt,
                savedAt: new Date().toISOString(),
                ...(envelope.anonymousHandoff
                  ? { anonymousHandoff: envelope.anonymousHandoff }
                  : {}),
              }, recovered.createdEvidence);
            }
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
      async resetWorkspace(resetReceiptToken) {
        const resetReceipt = resetReceiptToken
          ? preparedPortableArchiveReset.current
          : null;
        if (
          resetReceiptToken
          && (
            !resetReceipt
            || resetReceipt.token !== resetReceiptToken
          )
        ) {
          throw new Error("That backup confirmation is no longer valid. Download a fresh full backup before resetting anything.");
        }
        if (resetReceipt) {
          if (
            resetReceipt.boundary.authenticatedAccountId !== null
            || resetReceipt.boundary.activeAccountId !== null
          ) {
            preparedPortableArchiveReset.current = null;
            throw new Error("A connected workspace must use the separate account-erasure flow after its backup is confirmed.");
          }
          if (
            !portableArchiveBoundaryIsCurrent(resetReceipt.boundary)
            || (expectedLocalRevisions.current.get(resetReceipt.boundary.accountId) ?? 0)
              !== resetReceipt.localBoundary.workspaceLocalRevision
            || resetReceipt.boundary.persistenceGeneration
              !== resetReceipt.localBoundary.generation
          ) {
            preparedPortableArchiveReset.current = null;
            throw new Error("This workspace changed after the backup was created. Download a fresh full backup before resetting anything.");
          }
          preparedPortableArchiveReset.current = null;
        }
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
            || (resetReceipt !== null
              && (
                localChangeVersion.current !== resetReceipt.boundary.localChangeVersion
                || (expectedLocalRevisions.current.get(resetAccountId) ?? 0)
                  !== resetReceipt.localBoundary.workspaceLocalRevision
              ))
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
          let erased: AccountPersistenceEraseResult;
          if (resetReceipt) {
            erased = await deleteAccountPersistenceAtRevision(
              resetAccountId,
              resetPersistenceGeneration,
              resetReceipt.localBoundary.workspaceLocalRevision,
              resetReceipt.localBoundary.evidenceRevision,
            );
            // The IndexedDB transaction permanently disabled legacy import and
            // removed reminder metadata. Browser-local mirrors are best-effort
            // cleanup only and cannot resurrect data if removal is interrupted.
            try {
              localStorage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY);
              localStorage.removeItem(LEGACY_LAST_REMINDER_KEY);
              localStorage.removeItem(reminderStorageKey(resetAccountId));
            } catch {
              // IndexedDB remains the authority after the atomic reset.
            }
          } else {
            if (resetAccountId === persistenceAccountId(null)) {
              await disableLocalBootstrapLegacyImport({
                accountId: resetAccountId,
                ensureCurrent: ensureResetCurrent,
              }, { disableLegacyWorkspaceImport });
              localStorage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY);
              localStorage.removeItem(LEGACY_LAST_REMINDER_KEY);
            }
            localStorage.removeItem(reminderStorageKey(resetAccountId));
            erased = await deleteAccountPersistence(
              resetAccountId,
              resetPersistenceGeneration,
            );
          }
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
          if (error instanceof LocalWorkspaceConflictError) {
            quarantineLocalConflict(error);
          }
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
        accountSwitching.current = true;
        setWorkspaceSwitching(true);
        let stagedTargetEvidence:
          | Awaited<ReturnType<typeof externalizeWorkspaceHistory>>
          | Awaited<ReturnType<typeof externalizeEmbeddedEvidence>>
          | null = null;
        let stagedTargetEvidenceCommitted = false;
        let preparedHandoffEvidence: EvidenceBlobRecord[] = [];
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
                const rawTarget = await readRawWorkspace(targetAccountId);
                expectedLocalRevisions.current.set(
                  targetAccountId,
                  quarantinedWorkspaceLocalRevision(rawTarget),
                );
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
            const handoffPlan = planProviderAccountHandoff({
              choice,
              localExists: Boolean(targetEnvelope),
              localDirty: targetEnvelope?.dirty ?? false,
              localRevision: targetEnvelope?.revision,
              remoteExists,
              remoteRevision: remoteRow?.revision,
              targetWasQuarantined,
            });
            if (handoffPlan.kind === "invalid-revision") {
              throw new Error(`The account's ${handoffPlan.source} workspace has an invalid revision. Neither copy was changed.`);
            }
            if (handoffPlan.kind === "source-conflict") {
              throw new Error(`This device has unsaved account changes based on revision ${handoffPlan.localRevision}, while cloud is at revision ${handoffPlan.remoteRevision}. Sign out to preserve the anonymous workspace, then resolve the account sync conflict before combining them.`);
            }
            if (handoffPlan.kind === "quarantined-account-missing-cloud") {
              throw new Error("The account's device copy is quarantined and no cloud snapshot exists. Sign out, then recover or explicitly replace that device copy before opening it.");
            }
            const decision = handoffPlan.handoff;
            const sourceDecision = handoffPlan.source;

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
              preparedHandoffEvidence = prepared.map((item) => ({
                ...item,
                accountId: targetAccountId,
              }));
            }

            await requireExactAuthenticatedAccount();
            const replacementEnvelope: WorkspaceEnvelope = {
              accountId: targetAccountId,
              state: nextState,
              history: trimWorkspaceHistory(nextHistory),
              dirty: nextDirty,
              localRevision: expectedLocalRevisions.current.get(targetAccountId) ?? 0,
              revision: accountBaseRevision,
              serverUpdatedAt: accountBaseServerUpdatedAt,
              savedAt,
              anonymousHandoff: {
                generation: sourceGeneration,
                localRevision: frozenAnonymousLocalRevision,
              },
            };
            requireCurrentHandoff("The signed-in account changed before the account handoff could be committed.");
            let saved: WorkspaceEnvelope;
            try {
              const handoffPersistenceInput = {
                envelope: replacementEnvelope,
                evidence: preparedHandoffEvidence,
                stagedEvidence: stagedTargetEvidence?.createdEvidence ?? [],
                collisionPolicy: decision.action === "merge-anonymous"
                  ? "reject-existing" as const
                  : "replace-inspected-workspace" as const,
                replaceQuarantinedWorkspace: targetWasQuarantined,
              };
              const persistHandoff = () => applyAccountHandoffPersistence(
                handoffPersistenceInput,
                targetGeneration,
              );
              const committed = decision.action === "merge-anonymous"
                ? await persistHandoff()
                : (await commitAuthoritativeWorkspaceReplacement({
                    accountId: targetAccountId,
                    persistenceGeneration: targetGeneration,
                    sourceStates: [
                      ...(targetEnvelope
                        ? [
                            clone(targetEnvelope.state),
                            ...targetEnvelope.history.map(clone),
                          ]
                        : []),
                      ...(migratedRemoteState ? [clone(migratedRemoteState)] : []),
                    ],
                    targetStates: [
                      clone(replacementEnvelope.state),
                      ...replacementEnvelope.history.map(clone),
                    ],
                    persistTarget: async () => {
                      await requireExactAuthenticatedAccount();
                      if (
                        localChangeVersion.current !== frozenAnonymousVersion
                        || !workspaceStatesEqual(
                          frozenAnonymousState,
                          latestState.current,
                        )
                      ) {
                        throw new Error("The anonymous workspace changed before the account handoff could be committed.");
                      }
                      return persistHandoff();
                    },
                  })).result;
              saved = committed.envelope;
            } catch (error) {
              if (error instanceof LocalWorkspaceConflictError) {
                quarantineLocalConflict(error);
              }
              throw error;
            }
            expectedLocalRevisions.current.set(targetAccountId, saved.localRevision);
            // Metadata now references every copied byte. From this point onward
            // rolling files back would create broken evidence references.
            stagedTargetEvidenceCommitted = Boolean(stagedTargetEvidence);
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
            if (pendingAccountHandoff.current?.accountId === pending.accountId) {
              setPersistenceError(error instanceof Error
                ? `Workspace choice could not finish: ${error.message}`
                : "Workspace choice could not finish. Nothing was removed from the device copy.");
              setSyncStatus("conflict");
            }
            throw error;
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
            } else {
              const persistenceId = persistenceAccountId(resolutionAccountId);
              const persistenceGeneration = persistenceScopeGenerations.current.get(
                persistenceId,
              );
              if (persistenceGeneration === undefined) {
                throw new Error("The account persistence scope has not been loaded.");
              }
              const sourceState = clone(latestState.current);
              const sourceHistory = trimWorkspaceHistory(history.current.map(clone));
              const sourceChangeVersion = localChangeVersion.current;
              try {
                await commitAuthoritativeWorkspaceReplacement({
                  accountId: persistenceId,
                  persistenceGeneration,
                  sourceStates: [sourceState, ...sourceHistory],
                  targetStates: [remote.state],
                  persistTarget: async () => {
                    if (
                      !conflictStillCurrent()
                      || sourceChangeVersion !== localChangeVersion.current
                      || !workspaceStatesEqual(sourceState, latestState.current)
                    ) {
                      throw new Error("The device workspace changed before the cloud choice could be committed.");
                    }
                    return persistWorkspace({
                      accountId: persistenceId,
                      state: remote.state,
                      history: [],
                      dirty: intent.shouldSave,
                      revision: remote.revision,
                      serverUpdatedAt: remote.updatedAt,
                      savedAt: new Date().toISOString(),
                    }, remote.createdEvidence, {
                      removeUnreferencedEvidence: true,
                    });
                  },
                });
              } catch (error) {
                try {
                  await rollbackEvidenceWrites(remote.createdEvidence);
                } catch (rollbackError) {
                  throw new AggregateError(
                    [error, rollbackError],
                    "The cloud choice failed and its prepared evidence could not be fully rolled back.",
                  );
                }
                throw error;
              }
              if (
                !conflictStillCurrent()
                || sourceChangeVersion !== localChangeVersion.current
              ) return;
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
              if (!intent.shouldSave) {
                try {
                  await recoverRemoteEvidenceCleanup(
                    persistenceAccountId(resolutionAccountId),
                  );
                } catch (error) {
                  setPersistenceError(error instanceof Error
                    ? `The cloud workspace was selected, but discarded evidence cleanup remains pending: ${error.message}`
                    : "The cloud workspace was selected, but discarded evidence cleanup remains pending.");
                  setSyncStatus("error");
                  return;
                }
              }
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
  const actionsValue = useStableAppActions(value);

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
