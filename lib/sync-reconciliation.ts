export const ANONYMOUS_ACCOUNT_ID = "anonymous";

export type ConflictChoice = "device" | "cloud";
export type AnonymousHandoffChoice = "device" | "account" | "merge";
export type WorkspaceScopeEvent =
  | "account-switch"
  | "anonymous-handoff"
  | "remote-adoption"
  | "import"
  | "reset"
  | "undo"
  | "mutation"
  | "sync-retry";

export type AccountSwitchDecision =
  | { action: "load-existing" }
  | { action: "request-anonymous-consent"; sourceAccountId: typeof ANONYMOUS_ACCOUNT_ID }
  | { action: "open-empty" };

export type AnonymousHandoffDecision =
  | { action: "copy-anonymous"; sourceAccountId: typeof ANONYMOUS_ACCOUNT_ID }
  | { action: "merge-anonymous"; sourceAccountId: typeof ANONYMOUS_ACCOUNT_ID }
  | { action: "open-account" };

export type AccountHandoffSourceDecision =
  | { action: "use-empty"; remoteRevision: 0 }
  | { action: "use-local"; remoteRevision: number }
  | { action: "use-cloud"; remoteRevision: number }
  | { action: "conflict"; localRevision: number; remoteRevision: number }
  | { action: "invalid-revision"; source: "local" | "remote" };

export type SyncReconciliationDecision =
  | { action: "upload-initial"; expectedRevision: 0 }
  | { action: "upload-local"; expectedRevision: number }
  | { action: "use-remote"; remoteRevision: number }
  | { action: "conflict"; remoteRevision: number }
  | { action: "invalid-revision"; source: "local" | "remote" };

export type ConflictResolutionIntent =
  | { action: "use-cloud"; dirty: false; shouldSave: false }
  | { action: "use-cloud-and-save"; dirty: true; shouldSave: true }
  | { action: "overwrite-cloud"; dirty: true; shouldSave: true };

export type RemoteMigrationCompletion = "adopt-remote" | "conflict";

export function persistenceAccountId(accountId: string | null): string {
  return accountId ?? ANONYMOUS_ACCOUNT_ID;
}

/**
 * Route-local drafts must be discarded only when a different authoritative
 * workspace replaces the one they were created from. Ordinary edits and sync
 * retries keep the same workspace identity and therefore retain their mounts.
 */
export function nextWorkspaceScopeKey(
  current: WorkspaceScopeKey,
  event: WorkspaceScopeEvent,
): WorkspaceScopeKey {
  switch (event) {
    case "account-switch":
    case "anonymous-handoff":
    case "remote-adoption":
    case "import":
    case "reset":
    case "undo":
      return incrementWorkspaceScopeKey(current);
    case "mutation":
    case "sync-retry":
      return current;
  }
}

export function parseWorkspaceRevision(value: unknown): number | null {
  if (typeof value === "string" && !/^(0|[1-9]\d*)$/.test(value)) return null;
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Migration 009 returns a non-retryable HTTP 409 through PostgREST. Continue
 * recognising the earlier PostgreSQL serialization code while a compatible
 * client is prepared ahead of the coordinated database cutover.
 */
export function isWorkspaceRevisionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String(error.code);
  return code === "PT409" || code === "40001";
}

export function decideAccountSwitch({
  previousAccountId,
  nextAccountId,
  nextWorkspaceExists,
  anonymousWorkspaceMeaningful,
  anonymousHandoffAcknowledged = false,
}: {
  previousAccountId: string | null;
  nextAccountId: string | null;
  nextWorkspaceExists: boolean;
  anonymousWorkspaceMeaningful: boolean;
  anonymousHandoffAcknowledged?: boolean;
}): AccountSwitchDecision {
  if (
    nextAccountId
    && previousAccountId === null
    && anonymousWorkspaceMeaningful
    && !anonymousHandoffAcknowledged
  ) {
    return { action: "request-anonymous-consent", sourceAccountId: ANONYMOUS_ACCOUNT_ID };
  }
  if (nextWorkspaceExists) return { action: "load-existing" };
  return { action: "open-empty" };
}

export function decideAnonymousHandoff(choice: AnonymousHandoffChoice): AnonymousHandoffDecision {
  if (choice === "device") {
    return { action: "copy-anonymous", sourceAccountId: ANONYMOUS_ACCOUNT_ID };
  }
  if (choice === "merge") {
    return { action: "merge-anonymous", sourceAccountId: ANONYMOUS_ACCOUNT_ID };
  }
  return { action: "open-account" };
}

/**
 * Selects the exact account snapshot that a handoff may use. A dirty local
 * copy is authoritative only when it is based on the fetched cloud revision;
 * divergent originals must remain untouched until the person resolves them.
 */
export function decideAccountHandoffSource({
  localExists,
  localDirty,
  localRevision,
  remoteExists,
  remoteRevision,
}: {
  localExists: boolean;
  localDirty: boolean;
  localRevision?: unknown;
  remoteExists: boolean;
  remoteRevision?: unknown;
}): AccountHandoffSourceDecision {
  const parsedRemoteRevision = remoteExists ? parseWorkspaceRevision(remoteRevision) : 0;
  if (parsedRemoteRevision === null) {
    return { action: "invalid-revision", source: "remote" };
  }
  if (!localExists) {
    return remoteExists
      ? { action: "use-cloud", remoteRevision: parsedRemoteRevision }
      : { action: "use-empty", remoteRevision: 0 };
  }

  const parsedLocalRevision = parseWorkspaceRevision(localRevision);
  if (parsedLocalRevision === null) {
    return { action: "invalid-revision", source: "local" };
  }
  if (!remoteExists) return { action: "use-local", remoteRevision: 0 };
  if (!localDirty) return { action: "use-cloud", remoteRevision: parsedRemoteRevision };
  if (parsedLocalRevision === parsedRemoteRevision) {
    return { action: "use-local", remoteRevision: parsedRemoteRevision };
  }
  return {
    action: "conflict",
    localRevision: parsedLocalRevision,
    remoteRevision: parsedRemoteRevision,
  };
}

export function hasMeaningfulWorkspace<T extends {
  updatedAt: string;
  profile: { createdAt: string };
}>(workspace: T, emptyWorkspace: T): boolean {
  const comparable = (value: T) => ({
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "updatedAt")),
    profile: Object.fromEntries(
      Object.entries(value.profile).filter(([key]) => key !== "createdAt"),
    ),
  });
  return JSON.stringify(comparable(workspace)) !== JSON.stringify(comparable(emptyWorkspace));
}

export function decideSyncReconciliation({
  remoteExists,
  remoteRevision,
  localRevision,
  localDirty,
}: {
  remoteExists: boolean;
  remoteRevision?: unknown;
  localRevision: unknown;
  localDirty: boolean;
}): SyncReconciliationDecision {
  if (!remoteExists) return { action: "upload-initial", expectedRevision: 0 };

  const parsedRemoteRevision = parseWorkspaceRevision(remoteRevision);
  if (parsedRemoteRevision === null) {
    return { action: "invalid-revision", source: "remote" };
  }
  if (!localDirty) {
    return { action: "use-remote", remoteRevision: parsedRemoteRevision };
  }

  const parsedLocalRevision = parseWorkspaceRevision(localRevision);
  if (parsedLocalRevision === null) {
    return { action: "invalid-revision", source: "local" };
  }
  if (parsedLocalRevision === parsedRemoteRevision) {
    return { action: "upload-local", expectedRevision: parsedRemoteRevision };
  }
  return { action: "conflict", remoteRevision: parsedRemoteRevision };
}

export function decideConflictResolution(
  choice: ConflictChoice,
  remoteNeedsSave = false,
): ConflictResolutionIntent {
  if (choice === "device") {
    return { action: "overwrite-cloud", dirty: true, shouldSave: true };
  }
  return remoteNeedsSave
    ? { action: "use-cloud-and-save", dirty: true, shouldSave: true }
    : { action: "use-cloud", dirty: false, shouldSave: false };
}

/**
 * A migrated remote snapshot is saved before it can become authoritative. If
 * the local workspace changes during that network round trip, adopting neither
 * side and asking for an explicit choice is the only lossless outcome.
 */
export function decideRemoteMigrationCompletion(
  saveVersion: number,
  currentVersion: number,
): RemoteMigrationCompletion {
  return saveVersion === currentVersion ? "adopt-remote" : "conflict";
}

export function canPersistWorkspaceAutomatically(accountQuarantined: boolean): boolean {
  return !accountQuarantined;
}

export function canWriteCloud({
  authenticatedAccountId,
  activeAccountId,
  reconciledAccountId,
  remoteLoaded,
  accountSwitching,
  hasConflict,
  handoffPending,
  accountQuarantined,
}: {
  authenticatedAccountId: string | null;
  activeAccountId: string | null;
  reconciledAccountId: string | null;
  remoteLoaded: boolean;
  accountSwitching: boolean;
  hasConflict: boolean;
  handoffPending: boolean;
  accountQuarantined: boolean;
}): boolean {
  return Boolean(
    authenticatedAccountId
    && activeAccountId === authenticatedAccountId
    && reconciledAccountId === authenticatedAccountId
    && remoteLoaded
    && !accountSwitching
    && !hasConflict
    && !handoffPending
    && !accountQuarantined,
  );
}
import {
  incrementWorkspaceScopeKey,
  type WorkspaceScopeKey,
} from "@/lib/workspace-scope";
