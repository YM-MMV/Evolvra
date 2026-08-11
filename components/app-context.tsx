"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { ProviderDomainActions } from "@/lib/provider-command-bindings";
import type { AccountErasureCloudBackupBoundary } from "@/lib/account-erasure-checkpoint";
import type {
  AccountPersistenceScope,
  EvidenceBlobDeleteResult,
  EvidenceBlobDeletionReceipt,
  EvidenceBlobRecord,
  EvidenceCleanupIntent,
  PersistenceScopeGeneration,
} from "@/lib/persistence";
import type { StagedEvidenceWrite } from "@/lib/provider-evidence";
import type { CloudUser } from "@/lib/supabase";
import type {
  AnonymousHandoffChoice,
  ConflictChoice,
} from "@/lib/sync-reconciliation";
import type {
  AppState,
  GoalEvidence,
} from "@/lib/types";
import type { WorkspaceScopeKey } from "@/lib/workspace-scope";

export type SyncStatus =
  | "local"
  | "persisting"
  | "offline"
  | "unsaved"
  | "connecting"
  | "synced"
  | "saving"
  | "conflict"
  | "error";

export interface SyncConflict {
  remoteUpdatedAt: string;
  localUpdatedAt: string;
}

export interface AnonymousWorkspaceHandoff {
  anonymousUpdatedAt: string;
  activityCount: number;
  goalCount: number;
}

export interface LocalWorkspaceConflict {
  accountId: string;
  message: string;
}

export interface QuarantinedRecovery {
  accountId: string;
  message: string;
  rawJson?: string;
}

export interface PortableWorkspaceArchiveExport {
  blob: Blob;
  fileName: string;
  evidenceFiles: number;
  evidenceBytes: number;
  /** Opaque proof that this exact device revision was included in the archive. */
  resetReceiptToken: string;
}

export interface PortableWorkspaceArchiveExportOptions {
  /** Require a cloud-stable, byte-complete archive suitable for account erasure. */
  prepareForAccountErasure?: boolean;
}

export interface PortableWorkspaceArchiveImportPreview {
  token: string;
  archiveCreatedAt: string;
  archiveWorkspaceUpdatedAt: string;
  importedEvidenceFiles: number;
  importedEvidenceBytes: number;
}

export type PortableWorkspaceArchiveImportChoice = "merge" | "replace";

export interface PortableWorkspaceArchiveImportOutcome {
  choice: PortableWorkspaceArchiveImportChoice;
  importedEvidenceFiles: number;
  importedEvidenceBytes: number;
  removedSupersededEvidence: number;
  cleanupWarning: string | null;
}

/**
 * The active workspace snapshot and the identities needed to scope async work.
 */
export interface WorkspaceDataContextValue {
  state: AppState;
  workspaceScopeKey: WorkspaceScopeKey;
  persistenceScopeGeneration: PersistenceScopeGeneration;
}

/**
 * Read-only lifecycle, persistence, authentication, and recovery state.
 */
export interface ProviderStatusContextValue {
  ready: boolean;
  workspaceSwitching: boolean;
  terminalErasureAccountId: string | null;
  user: CloudUser | null;
  syncStatus: SyncStatus;
  cloudEnabled: boolean;
  cloudWriteAllowed: boolean;
  persistenceError: string | null;
  localWorkspaceConflict: LocalWorkspaceConflict | null;
  quarantinedRecovery: QuarantinedRecovery | null;
  syncConflict: SyncConflict | null;
  accountHandoff: AnonymousWorkspaceHandoff | null;
  canUndo: boolean;
}

/**
 * Domain commands plus the coordinated persistence and account operations that
 * cannot be represented as pure workspace mutations.
 */
export interface AppActionsContextValue extends ProviderDomainActions {
  setGoalFileEvidence: (
    goalId: string,
    evidence: GoalEvidence[],
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
    stagedEvidence?: readonly StagedEvidenceWrite[],
  ) => Promise<number>;
  readGoalEvidenceBlob: (
    goalId: string,
    evidenceId: string,
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ) => Promise<EvidenceBlobRecord | null>;
  stageGoalEvidenceBlob: (
    goalId: string,
    evidenceId: string,
    blob: Blob,
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ) => Promise<StagedEvidenceWrite>;
  rollbackGoalEvidenceStage: (
    staged: StagedEvidenceWrite,
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ) => Promise<void>;
  cacheGoalEvidenceBlob: (
    goalId: string,
    evidenceId: string,
    blob: Blob,
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ) => Promise<EvidenceBlobRecord>;
  deleteGoalEvidenceBlobs: (
    snapshots: readonly EvidenceBlobRecord[],
    committedWorkspaceLocalRevision: number | null,
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ) => Promise<EvidenceBlobDeleteResult>;
  restoreGoalEvidenceBlobs: (
    receipt: EvidenceBlobDeletionReceipt,
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ) => Promise<"restored" | "already-equal" | "superseded">;
  stageGoalEvidenceCleanup: (
    snapshot: EvidenceBlobRecord | null,
    goalId: string,
    evidenceId: string,
    remotePath: string | undefined,
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ) => Promise<EvidenceCleanupIntent | null>;
  cancelGoalEvidenceCleanup: (
    intent: EvidenceCleanupIntent,
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
  ) => Promise<void>;
  runWorkspaceFileOperation: <T>(
    expectedWorkspaceScopeKey: WorkspaceScopeKey,
    operation: () => T | PromiseLike<T>,
  ) => Promise<T>;
  reportPersistenceError: (message: string) => void;
  deleteGoal: (goalId: string) => Promise<void>;
  importState: (state: unknown) => Promise<void>;
  exportPortableWorkspaceArchive: (
    options?: PortableWorkspaceArchiveExportOptions,
  ) => Promise<PortableWorkspaceArchiveExport>;
  inspectPortableWorkspaceArchive: (
    archive: Blob,
  ) => Promise<PortableWorkspaceArchiveImportPreview>;
  discardPortableWorkspaceArchiveImport: (token: string) => void;
  applyPortableWorkspaceArchive: (
    token: string,
    choice: PortableWorkspaceArchiveImportChoice,
  ) => Promise<PortableWorkspaceArchiveImportOutcome>;
  resetWorkspace: (resetReceiptToken?: string) => Promise<void>;
  discardQuarantinedWorkspace: () => Promise<void>;
  undo: () => void;
  retrySync: () => Promise<void>;
  resolveAccountHandoff: (choice: AnonymousHandoffChoice) => Promise<void>;
  resolveSyncConflict: (choice: ConflictChoice) => Promise<void>;
  signIn: (email: string) => Promise<string>;
  signOut: () => Promise<void>;
  beginActiveAccountErasure: (
    expectedAccountId: string,
    backupReceiptToken: string,
    armFence: (
      expectedGeneration: PersistenceScopeGeneration,
      expectedLocalRevision: number,
      expectedEvidenceRevision: number,
      backup: AccountErasureCloudBackupBoundary,
    ) => Promise<AccountPersistenceScope>,
  ) => Promise<AccountPersistenceScope>;
  cancelActiveAccountErasure: (
    expectedAccountId: string,
    tombstonedGeneration: PersistenceScopeGeneration,
    cancelFence: () => Promise<AccountPersistenceScope>,
  ) => Promise<AccountPersistenceScope>;
  adoptActiveAccountErasure: (
    expectedAccountId: string,
    tombstonedGeneration: PersistenceScopeGeneration,
  ) => Promise<AccountPersistenceScope>;
  finishActiveAccountErasure: (
    expectedAccountId: string,
    tombstonedGeneration: PersistenceScopeGeneration,
    clearSession: () => Promise<string | null>,
  ) => Promise<{ sessionWarning: string | null }>;
}

/**
 * Compatibility contract for consumers that still need the complete provider.
 */
export interface AppContextValue
  extends WorkspaceDataContextValue,
    ProviderStatusContextValue,
    AppActionsContextValue {}

export const WorkspaceDataContext = createContext<WorkspaceDataContextValue | null>(null);
export const ProviderStatusContext = createContext<ProviderStatusContextValue | null>(null);
export const AppActionsContext = createContext<AppActionsContextValue | null>(null);

interface ContextProviderProps<T> {
  value: T;
  children: ReactNode;
}

export function WorkspaceDataProvider({
  value,
  children,
}: ContextProviderProps<WorkspaceDataContextValue>) {
  return (
    <WorkspaceDataContext.Provider value={value}>
      {children}
    </WorkspaceDataContext.Provider>
  );
}

export function ProviderStatusProvider({
  value,
  children,
}: ContextProviderProps<ProviderStatusContextValue>) {
  return (
    <ProviderStatusContext.Provider value={value}>
      {children}
    </ProviderStatusContext.Provider>
  );
}

export function AppActionsProvider({
  value,
  children,
}: ContextProviderProps<AppActionsContextValue>) {
  return (
    <AppActionsContext.Provider value={value}>
      {children}
    </AppActionsContext.Provider>
  );
}

export function useWorkspaceData() {
  const value = useContext(WorkspaceDataContext);
  if (!value) {
    throw new Error("useWorkspaceData must be used inside WorkspaceDataProvider");
  }
  return value;
}

export function useProviderStatus() {
  const value = useContext(ProviderStatusContext);
  if (!value) {
    throw new Error("useProviderStatus must be used inside ProviderStatusProvider");
  }
  return value;
}

export function useAppActions() {
  const value = useContext(AppActionsContext);
  if (!value) {
    throw new Error("useAppActions must be used inside AppActionsProvider");
  }
  return value;
}

/**
 * Compatibility hook for the current all-in-one consumer API.
 *
 * New consumers can subscribe to a narrower context to avoid rerendering for
 * unrelated provider changes.
 */
export function useApp(): AppContextValue {
  const workspace = useContext(WorkspaceDataContext);
  const status = useContext(ProviderStatusContext);
  const actions = useContext(AppActionsContext);
  const value = useMemo(() => {
    if (!workspace || !status || !actions) return null;
    return {
      ...workspace,
      ...status,
      ...actions,
    };
  }, [actions, status, workspace]);

  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
