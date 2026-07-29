export const SYNC_STATUSES = [
  "local",
  "persisting",
  "offline",
  "unsaved",
  "connecting",
  "synced",
  "saving",
  "conflict",
  "error",
] as const;

export type SyncStatus = (typeof SYNC_STATUSES)[number];

interface SyncStatusSelectorInput {
  authenticated: boolean;
  handoffPending: boolean;
  syncStatus: SyncStatus;
}

const SHELL_SYNC_STATUS_LABELS = {
  local: "Private on this device",
  persisting: "Saving to this device…",
  offline: "Offline — saved on this device",
  unsaved: "Changes waiting to sync",
  connecting: "Connecting to private sync…",
  synced: "Private sync up to date",
  saving: "Saving changes…",
  conflict: "Sync choice required",
  error: "Sync needs attention",
} satisfies Record<SyncStatus, string>;

const SETTINGS_SYNC_STATUS_DESCRIPTIONS = {
  local: "Private sync is not active yet. Changes remain saved on this device.",
  persisting: "Saving the latest changes on this device before private sync continues…",
  offline: "You are offline. Changes remain saved on this device and will sync after reconnection.",
  unsaved: "Changes are saved on this device and waiting for private sync.",
  connecting: "Checking for newer private changes…",
  synced: "This device and the private cloud snapshot are up to date.",
  saving: "Saving the latest local changes…",
  conflict: "Both this device and the cloud have unsaved changes. Choose which copy to keep.",
  error: "Sync could not finish. Your device copy is still safe and can be retried.",
} satisfies Record<SyncStatus, string>;

const DEVICE_ONLY_SETTINGS_DESCRIPTION =
  "No account is required for local use. Export backups whenever you like.";
const DEVICE_SAVING_SETTINGS_DESCRIPTION =
  "Saving the latest changes privately on this device…";
const DEVICE_ERROR_SETTINGS_DESCRIPTION =
  "The local workspace or optional private connection needs attention. Review the error before closing or reloading Evolvra.";

const HANDOFF_SHELL_LABEL = "Workspace choice required";

const HANDOFF_SETTINGS_DESCRIPTION =
  "Sync is paused until you keep, merge, or replace these separate workspaces. Nothing is copied automatically.";

/**
 * Selects the short sync label shown throughout the application shell.
 *
 * Authentication takes precedence over stale provider state, followed by an
 * unresolved account handoff, then the exact sync state.
 */
export function shellSyncStatusLabel({
  authenticated,
  handoffPending,
  syncStatus,
}: SyncStatusSelectorInput): string {
  if (!authenticated) {
    if (syncStatus === "persisting") return SHELL_SYNC_STATUS_LABELS.persisting;
    if (syncStatus === "error") return "Local workspace needs attention";
    return SHELL_SYNC_STATUS_LABELS.local;
  }
  if (handoffPending) return HANDOFF_SHELL_LABEL;
  return SHELL_SYNC_STATUS_LABELS[syncStatus];
}

/**
 * Selects the longer explanation shown by Sync & privacy settings.
 *
 * A handoff deliberately masks transport status: no syncing can resume until
 * the user chooses which workspace to open.
 */
export function settingsSyncStatusDescription({
  authenticated,
  handoffPending,
  syncStatus,
}: SyncStatusSelectorInput): string {
  if (!authenticated) {
    if (syncStatus === "persisting") return DEVICE_SAVING_SETTINGS_DESCRIPTION;
    if (syncStatus === "error") return DEVICE_ERROR_SETTINGS_DESCRIPTION;
    return DEVICE_ONLY_SETTINGS_DESCRIPTION;
  }
  if (handoffPending) return HANDOFF_SETTINGS_DESCRIPTION;
  return SETTINGS_SYNC_STATUS_DESCRIPTIONS[syncStatus];
}

/**
 * Prevents an account-scoped provider notice from leaking across a workspace
 * transition. The original notice object is returned only for an exact,
 * settled account match.
 */
export function workspaceNoticeForActiveAccount<
  T extends { readonly accountId: string },
>(
  notice: T | null,
  activeAccountId: string,
  workspaceSwitching: boolean,
): T | null {
  return !workspaceSwitching && notice?.accountId === activeAccountId
    ? notice
    : null;
}
