import { describe, expect, it, vi } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import {
  PersistenceError,
  recoverWorkspaceEnvelope,
  type AccountPersistenceScope,
  type LegacyWorkspaceImportJournal,
  type WorkspaceEnvelope,
} from "@/lib/persistence";
import {
  disableLocalBootstrapLegacyImport,
  runLocalWorkspaceBootstrap,
  type LocalBootstrapPorts,
} from "@/lib/provider-local-bootstrap";
import type { ExternalizedWorkspaceHistory } from "@/lib/provider-evidence";
import type { AppState } from "@/lib/types";

const ACCOUNT_ID = "anonymous";
const NOW = "2026-07-28T12:00:00.000Z";

const scope: AccountPersistenceScope = {
  accountId: ACCOUNT_ID,
  generation: 7,
  tombstoned: false,
  updatedAt: NOW,
};

function state(displayName = "Explorer"): AppState {
  const result = structuredClone(EMPTY_STATE);
  result.updatedAt = NOW;
  result.profile = {
    ...result.profile,
    displayName,
    onboarded: true,
    createdAt: NOW,
  };
  return result;
}

function envelope(current = state()): WorkspaceEnvelope {
  return {
    accountId: ACCOUNT_ID,
    state: current,
    history: [],
    dirty: false,
    localRevision: 3,
    revision: 2,
    savedAt: NOW,
  };
}

const committedJournal: LegacyWorkspaceImportJournal = {
  accountId: ACCOUNT_ID,
  status: "committed",
  committedAt: NOW,
};

function ports(
  overrides: Partial<LocalBootstrapPorts> = {},
): LocalBootstrapPorts {
  return {
    readWorkspace: async () => ({ workspace: null, scope }),
    readRawWorkspace: async () => null,
    captureLegacyWorkspaceImport: async () => committedJournal,
    commitLegacyWorkspaceImport: async () => committedJournal,
    persistWorkspace: async ({ envelope: write }) => ({
      ...write,
      localRevision: 1,
    }),
    externalizeEmbeddedEvidence: async ({ state: current }) => ({
      state: current,
      changed: false,
      createdEvidence: [],
    }),
    externalizeWorkspaceHistory: async ({ state: current, history }) => ({
      state: current,
      history: [...history],
      changed: false,
      createdEvidence: [],
    }),
    rollbackExternalizedEvidence: async () => undefined,
    now: () => NOW,
    ...overrides,
  };
}

const request = (raw: string | null = null) => ({
  accountId: ACCOUNT_ID,
  legacy: { raw },
  ensureCurrent: () => undefined,
});

describe("local workspace bootstrap", () => {
  it("returns an empty result without creating a workspace", async () => {
    const persistWorkspace = vi.fn<LocalBootstrapPorts["persistWorkspace"]>();
    const result = await runLocalWorkspaceBootstrap(
      request(),
      ports({ persistWorkspace }),
    );

    expect(result).toMatchObject({
      kind: "empty",
      accountId: ACCOUNT_ID,
      scope,
      legacySourceCanBeCleared: true,
    });
    expect(persistWorkspace).not.toHaveBeenCalled();
  });

  it("loads a valid device envelope without an unnecessary write", async () => {
    const saved = envelope(state("Valid device"));
    const persistWorkspace = vi.fn<LocalBootstrapPorts["persistWorkspace"]>();
    const result = await runLocalWorkspaceBootstrap(
      request(),
      ports({
        readWorkspace: async () => ({ workspace: saved, scope }),
        persistWorkspace,
      }),
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.source).toBe("device");
    expect(result.envelope.state.profile.displayName).toBe("Valid device");
    expect(result.persistedDuringBootstrap).toBe(false);
    expect(persistWorkspace).not.toHaveBeenCalled();
  });

  it("preserves newest-valid-history recovery and its clean boundary", async () => {
    const older = state("Older");
    const newest = state("Newest valid");
    newest.updatedAt = "2026-07-28T11:00:00.000Z";
    const recovered = recoverWorkspaceEnvelope({
      ...envelope(),
      state: { broken: true },
      history: [older, { also: "broken" }, newest],
      dirty: true,
    }, ACCOUNT_ID);

    const result = await runLocalWorkspaceBootstrap(
      request(),
      ports({ readWorkspace: async () => ({ workspace: recovered, scope }) }),
    );

    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") return;
    expect(result.envelope.state.profile.displayName).toBe("Newest valid");
    expect(result.envelope.history).toEqual([older]);
    expect(result.envelope.dirty).toBe(false);
    expect(result.recoveryNotice).toMatch(/newest valid undo snapshot/i);
  });

  it("quarantines a future device version without consulting valid history", async () => {
    const validHistory = state("Must not be adopted");
    const future = {
      ...envelope(),
      state: { ...state(), version: 4 },
      history: [validHistory],
    };
    const rawBefore = structuredClone(future);
    const result = await runLocalWorkspaceBootstrap(
      request(),
      ports({
        readWorkspace: async () => ({
          workspace: recoverWorkspaceEnvelope(future, ACCOUNT_ID),
          scope,
        }),
        readRawWorkspace: async () => future,
      }),
    );

    expect(result.kind).toBe("quarantined");
    if (result.kind !== "quarantined") return;
    expect(result.message).toMatch(/version 4.*newer/i);
    expect(result.rawJson).toContain('"version": 4');
    expect(future).toEqual(rawBefore);
  });

  it("persists and commits a captured legacy workspace in that order", async () => {
    const events: string[] = [];
    const legacy = state("Legacy");
    const pending: LegacyWorkspaceImportJournal = {
      accountId: ACCOUNT_ID,
      status: "pending",
      raw: JSON.stringify(legacy),
      capturedAt: NOW,
    };
    const result = await runLocalWorkspaceBootstrap(
      request(JSON.stringify(legacy)),
      ports({
        captureLegacyWorkspaceImport: async () => {
          events.push("capture");
          return pending;
        },
        persistWorkspace: async ({ envelope: write }) => {
          events.push("persist");
          return { ...write, localRevision: 1 };
        },
        commitLegacyWorkspaceImport: async () => {
          events.push("commit");
          return committedJournal;
        },
      }),
    );

    expect(events).toEqual(["capture", "persist", "commit"]);
    expect(result).toMatchObject({
      kind: "loaded",
      source: "legacy",
      persistedDuringBootstrap: true,
      legacySourceCanBeCleared: true,
    });
  });

  it("keeps evidence after a post-persistence legacy commit failure", async () => {
    const legacy = state("Legacy");
    const raw = JSON.stringify(legacy);
    const rollback = vi.fn(async () => undefined);
    const result = await runLocalWorkspaceBootstrap(
      request(raw),
      ports({
        captureLegacyWorkspaceImport: async () => ({
          accountId: ACCOUNT_ID,
          status: "pending",
          raw,
          capturedAt: NOW,
        }),
        externalizeEmbeddedEvidence: async ({ state: current }) => ({
          state: current,
          changed: true,
          createdEvidence: [],
        }),
        commitLegacyWorkspaceImport: async () => {
          throw new PersistenceError(
            "transaction-failed",
            "commit-legacy-workspace-import",
            "Legacy commit failed.",
          );
        },
        rollbackExternalizedEvidence: rollback,
      }),
    );

    expect(result).toMatchObject({
      kind: "quarantined",
      canonicalWorkspacePersisted: true,
      legacySourceCanBeCleared: false,
    });
    expect(rollback).not.toHaveBeenCalled();
  });

  it("surfaces both persistence and evidence rollback failures", async () => {
    const rollbackFailure = new Error("rollback failed");
    const migrated: ExternalizedWorkspaceHistory = {
      state: state("Migrated"),
      history: [],
      changed: true,
      createdEvidence: [],
    };
    const result = await runLocalWorkspaceBootstrap(
      request(),
      ports({
        readWorkspace: async () => ({ workspace: envelope(), scope }),
        externalizeWorkspaceHistory: async () => migrated,
        persistWorkspace: async () => {
          throw new Error("persist failed");
        },
        rollbackExternalizedEvidence: async () => {
          throw rollbackFailure;
        },
      }),
    );

    expect(result).toMatchObject({
      kind: "failed",
      canonicalWorkspacePersisted: false,
      rollbackError: rollbackFailure,
    });
    expect(result.kind === "failed" && result.error).toBeInstanceOf(AggregateError);
    expect(
      result.kind === "failed"
        && result.error instanceof AggregateError
        && result.error.errors,
    ).toEqual([
      expect.objectContaining({ message: "persist failed" }),
      rollbackFailure,
    ]);
  });

  it("routes explicit legacy disable through the lifecycle guard", async () => {
    const events: string[] = [];
    const result = await disableLocalBootstrapLegacyImport({
      accountId: ACCOUNT_ID,
      ensureCurrent: () => { events.push("current"); },
    }, {
      disableLegacyWorkspaceImport: async () => {
        events.push("disable");
        return {
          accountId: ACCOUNT_ID,
          status: "disabled",
          disabledAt: NOW,
        };
      },
    });

    expect(events).toEqual(["current", "disable", "current"]);
    expect(result).toMatchObject({
      journal: { status: "disabled" },
      legacySourceCanBeCleared: true,
    });
  });
});
