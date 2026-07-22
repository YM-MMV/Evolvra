import { describe, expect, it } from "vitest";
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
  nextWorkspaceScopeKey,
  parseWorkspaceRevision,
} from "@/lib/sync-reconciliation";
import { workspaceScopeKeyFromDecimal } from "@/lib/workspace-scope";

describe("mounted workspace scope", () => {
  it("remounts route drafts when a different workspace becomes authoritative", () => {
    for (const event of [
      "account-switch",
      "anonymous-handoff",
      "remote-adoption",
      "import",
      "reset",
      "undo",
    ] as const) {
      expect(nextWorkspaceScopeKey(
        workspaceScopeKeyFromDecimal("7"),
        event,
      )).toBe("8");
    }
  });

  it("preserves route drafts for ordinary mutations and sync retries", () => {
    const scope = workspaceScopeKeyFromDecimal("7");
    expect(nextWorkspaceScopeKey(scope, "mutation")).toBe(scope);
    expect(nextWorkspaceScopeKey(scope, "sync-retry")).toBe(scope);
  });

  it("advances beyond the JavaScript safe-integer boundary", () => {
    expect(nextWorkspaceScopeKey(
      workspaceScopeKeyFromDecimal("9007199254740991"),
      "reset",
    )).toBe("9007199254740992");
    expect(nextWorkspaceScopeKey(
      workspaceScopeKeyFromDecimal("99999999999999999999"),
      "reset",
    )).toBe("100000000000000000000");
  });
});

describe("account-switch isolation", () => {
  it("requires consent before a meaningful anonymous workspace can be copied", () => {
    expect(decideAccountSwitch({
      previousAccountId: null,
      nextAccountId: "user-a",
      nextWorkspaceExists: false,
      anonymousWorkspaceMeaningful: true,
    })).toEqual({ action: "request-anonymous-consent", sourceAccountId: "anonymous" });
  });

  it("opens an untouched account workspace without an unnecessary prompt", () => {
    expect(decideAccountSwitch({
      previousAccountId: null,
      nextAccountId: "user-a",
      nextWorkspaceExists: false,
      anonymousWorkspaceMeaningful: false,
    })).toEqual({ action: "open-empty" });
  });

  it("never seeds user B from user A when user B has no local workspace", () => {
    expect(decideAccountSwitch({
      previousAccountId: "user-a",
      nextAccountId: "user-b",
      nextWorkspaceExists: false,
      anonymousWorkspaceMeaningful: true,
    })).toEqual({ action: "open-empty" });
  });

  it("still requests consent when the account already has a local workspace", () => {
    expect(decideAccountSwitch({
      previousAccountId: null,
      nextAccountId: "user-a",
      nextWorkspaceExists: true,
      anonymousWorkspaceMeaningful: true,
    })).toEqual({ action: "request-anonymous-consent", sourceAccountId: "anonymous" });
  });

  it("loads an existing account workspace when there is no meaningful anonymous copy", () => {
    expect(decideAccountSwitch({
      previousAccountId: null,
      nextAccountId: "user-a",
      nextWorkspaceExists: true,
      anonymousWorkspaceMeaningful: false,
    })).toEqual({ action: "load-existing" });
  });

  it("maps explicit handoff choices without an automatic copy path", () => {
    expect(decideAnonymousHandoff("device")).toEqual({
      action: "copy-anonymous",
      sourceAccountId: "anonymous",
    });
    expect(decideAnonymousHandoff("merge")).toEqual({
      action: "merge-anonymous",
      sourceAccountId: "anonymous",
    });
    expect(decideAnonymousHandoff("account")).toEqual({ action: "open-account" });
  });
});

describe("account handoff source selection", () => {
  it("uses cloud when local is absent or clean", () => {
    expect(decideAccountHandoffSource({
      localExists: false,
      localDirty: false,
      remoteExists: true,
      remoteRevision: "7",
    })).toEqual({ action: "use-cloud", remoteRevision: 7 });
    expect(decideAccountHandoffSource({
      localExists: true,
      localDirty: false,
      localRevision: 2,
      remoteExists: true,
      remoteRevision: 7,
    })).toEqual({ action: "use-cloud", remoteRevision: 7 });
  });

  it("uses dirty local only when it is based on the exact cloud revision", () => {
    expect(decideAccountHandoffSource({
      localExists: true,
      localDirty: true,
      localRevision: 7,
      remoteExists: true,
      remoteRevision: "7",
    })).toEqual({ action: "use-local", remoteRevision: 7 });
    expect(decideAccountHandoffSource({
      localExists: true,
      localDirty: true,
      localRevision: 6,
      remoteExists: true,
      remoteRevision: 7,
    })).toEqual({ action: "conflict", localRevision: 6, remoteRevision: 7 });
  });

  it("uses local against an absent cloud and empty only when neither exists", () => {
    expect(decideAccountHandoffSource({
      localExists: true,
      localDirty: true,
      localRevision: 12,
      remoteExists: false,
    })).toEqual({ action: "use-local", remoteRevision: 0 });
    expect(decideAccountHandoffSource({
      localExists: false,
      localDirty: false,
      remoteExists: false,
    })).toEqual({ action: "use-empty", remoteRevision: 0 });
  });

  it("rejects invalid revisions instead of coercing a source", () => {
    expect(decideAccountHandoffSource({
      localExists: true,
      localDirty: true,
      localRevision: "bad",
      remoteExists: false,
    })).toEqual({ action: "invalid-revision", source: "local" });
    expect(decideAccountHandoffSource({
      localExists: false,
      localDirty: false,
      remoteExists: true,
      remoteRevision: "bad",
    })).toEqual({ action: "invalid-revision", source: "remote" });
  });
});

describe("meaningful workspace detection", () => {
  const empty = {
    updatedAt: "2026-07-18T12:00:00.000Z",
    profile: { createdAt: "2026-07-18T12:00:00.000Z", onboarded: false },
    goals: [] as string[],
  };

  it("ignores timestamps but detects personal workspace changes", () => {
    expect(hasMeaningfulWorkspace({
      ...empty,
      updatedAt: "2026-07-19T12:00:00.000Z",
      profile: { ...empty.profile, createdAt: "2026-07-19T12:00:00.000Z" },
    }, empty)).toBe(false);
    expect(hasMeaningfulWorkspace({ ...empty, goals: ["goal-1"] }, empty)).toBe(true);
    expect(hasMeaningfulWorkspace({
      ...empty,
      profile: { ...empty.profile, onboarded: true },
    }, empty)).toBe(true);
  });
});

describe("revision parsing", () => {
  it("accepts non-negative safe integers and Postgres bigint strings", () => {
    expect(parseWorkspaceRevision(0)).toBe(0);
    expect(parseWorkspaceRevision("42")).toBe(42);
    expect(parseWorkspaceRevision(BigInt(7))).toBe(7);
  });

  it("rejects malformed, negative, fractional, and unsafe revisions", () => {
    for (const value of [undefined, null, "", " 2", "02", "2.5", -1, 1.5, "9007199254740992"]) {
      expect(parseWorkspaceRevision(value)).toBeNull();
    }
  });
});

describe("sync reconciliation", () => {
  it("turns an edit made while a migrated remote snapshot saves into an explicit conflict", () => {
    expect(decideRemoteMigrationCompletion(12, 13)).toBe("conflict");
    expect(decideRemoteMigrationCompletion(12, 12)).toBe("adopt-remote");
  });

  it("uploads dirty local state when both sides have the same revision", () => {
    expect(decideSyncReconciliation({
      remoteExists: true,
      remoteRevision: "8",
      localRevision: 8,
      localDirty: true,
    })).toEqual({ action: "upload-local", expectedRevision: 8 });
  });

  it("reports a conflict when dirty local state is based on an older revision", () => {
    expect(decideSyncReconciliation({
      remoteExists: true,
      remoteRevision: 9,
      localRevision: 8,
      localDirty: true,
    })).toEqual({ action: "conflict", remoteRevision: 9 });
  });

  it("uses the remote snapshot when local state is clean", () => {
    expect(decideSyncReconciliation({
      remoteExists: true,
      remoteRevision: 9,
      localRevision: 8,
      localDirty: false,
    })).toEqual({ action: "use-remote", remoteRevision: 9 });
  });

  it("creates the first cloud snapshot when the remote is missing", () => {
    expect(decideSyncReconciliation({
      remoteExists: false,
      localRevision: 12,
      localDirty: false,
    })).toEqual({ action: "upload-initial", expectedRevision: 0 });
  });

  it("halts safely when either required revision is invalid", () => {
    expect(decideSyncReconciliation({
      remoteExists: true,
      remoteRevision: "not-a-revision",
      localRevision: 2,
      localDirty: false,
    })).toEqual({ action: "invalid-revision", source: "remote" });
    expect(decideSyncReconciliation({
      remoteExists: true,
      remoteRevision: 3,
      localRevision: "9007199254740992",
      localDirty: true,
    })).toEqual({ action: "invalid-revision", source: "local" });
  });
});

describe("conflict resolution", () => {
  it("expresses cloud and device choices without ambiguity", () => {
    expect(decideConflictResolution("cloud")).toEqual({
      action: "use-cloud",
      dirty: false,
      shouldSave: false,
    });
    expect(decideConflictResolution("device")).toEqual({
      action: "overwrite-cloud",
      dirty: true,
      shouldSave: true,
    });
    expect(decideConflictResolution("cloud", true)).toEqual({
      action: "use-cloud-and-save",
      dirty: true,
      shouldSave: true,
    });
  });
});

describe("cloud write gate", () => {
  it("only opens after the authenticated account is active and reconciled", () => {
    const ready = {
      authenticatedAccountId: "user-b",
      activeAccountId: "user-b",
      reconciledAccountId: "user-b",
      remoteLoaded: true,
      accountSwitching: false,
      hasConflict: false,
      handoffPending: false,
      accountQuarantined: false,
    };
    expect(canWriteCloud(ready)).toBe(true);
    expect(canWriteCloud({ ...ready, activeAccountId: "user-a" })).toBe(false);
    expect(canWriteCloud({ ...ready, reconciledAccountId: "user-a" })).toBe(false);
    expect(canWriteCloud({ ...ready, accountSwitching: true })).toBe(false);
    expect(canWriteCloud({ ...ready, hasConflict: true })).toBe(false);
    expect(canWriteCloud({ ...ready, handoffPending: true })).toBe(false);
    expect(canWriteCloud({ ...ready, accountQuarantined: true })).toBe(false);
  });

  it("keeps automatic device persistence closed for quarantined records", () => {
    expect(canPersistWorkspaceAutomatically(false)).toBe(true);
    expect(canPersistWorkspaceAutomatically(true)).toBe(false);
  });
});
