import { describe, expect, it } from "vitest";
import {
  settingsSyncStatusDescription,
  shellSyncStatusLabel,
  SYNC_STATUSES,
  workspaceNoticeForActiveAccount,
  type SyncStatus,
} from "@/lib/provider-selectors";

const expectedShellLabels = {
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

const expectedSettingsDescriptions = {
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

describe("provider status selectors", () => {
  it.each(SYNC_STATUSES)("selects the authenticated shell label for %s", (syncStatus) => {
    expect(shellSyncStatusLabel({
      authenticated: true,
      handoffPending: false,
      syncStatus,
    })).toBe(expectedShellLabels[syncStatus]);
  });

  it.each(SYNC_STATUSES)("selects the authenticated settings description for %s", (syncStatus) => {
    expect(settingsSyncStatusDescription({
      authenticated: true,
      handoffPending: false,
      syncStatus,
    })).toBe(expectedSettingsDescriptions[syncStatus]);
  });

  it.each(SYNC_STATUSES.filter((status) =>
    status !== "persisting" && status !== "error"
  ))("lets signed-out device-only copy take precedence over stale %s state", (syncStatus) => {
    expect(shellSyncStatusLabel({
      authenticated: false,
      handoffPending: true,
      syncStatus,
    })).toBe("Private on this device");
    expect(settingsSyncStatusDescription({
      authenticated: false,
      handoffPending: true,
      syncStatus,
    })).toBe("No account is required for local use. Export backups whenever you like.");
  });

  it("reports local-only device saves and failures explicitly", () => {
    expect(shellSyncStatusLabel({
      authenticated: false,
      handoffPending: false,
      syncStatus: "persisting",
    })).toBe("Saving to this device…");
    expect(settingsSyncStatusDescription({
      authenticated: false,
      handoffPending: false,
      syncStatus: "persisting",
    })).toBe("Saving the latest changes privately on this device…");
    expect(shellSyncStatusLabel({
      authenticated: false,
      handoffPending: false,
      syncStatus: "error",
    })).toBe("Local workspace needs attention");
    expect(settingsSyncStatusDescription({
      authenticated: false,
      handoffPending: false,
      syncStatus: "error",
    })).toBe(
      "The local workspace or optional private connection needs attention. Review the error before closing or reloading Evolvra.",
    );
  });

  it.each(SYNC_STATUSES)("lets an authenticated handoff take precedence over %s state", (syncStatus) => {
    expect(shellSyncStatusLabel({
      authenticated: true,
      handoffPending: true,
      syncStatus,
    })).toBe("Workspace choice required");
    expect(settingsSyncStatusDescription({
      authenticated: true,
      handoffPending: true,
      syncStatus,
    })).toBe(
      "Sync is paused until you keep, merge, or replace these separate workspaces. Nothing is copied automatically.",
    );
  });
});

describe("active-account workspace notice selector", () => {
  const notice = {
    accountId: "account-a",
    message: "This workspace needs attention.",
  } as const;

  it("returns the original notice for an exact settled account match", () => {
    expect(workspaceNoticeForActiveAccount(
      notice,
      "account-a",
      false,
    )).toBe(notice);
  });

  it("hides notices owned by another account", () => {
    expect(workspaceNoticeForActiveAccount(
      notice,
      "account-b",
      false,
    )).toBeNull();
  });

  it("lets workspace switching take precedence over an account match", () => {
    expect(workspaceNoticeForActiveAccount(
      notice,
      "account-a",
      true,
    )).toBeNull();
  });

  it("preserves an absent notice", () => {
    expect(workspaceNoticeForActiveAccount(
      null,
      "account-a",
      false,
    )).toBeNull();
  });
});
