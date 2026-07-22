import { describe, expect, it } from "vitest";
import { createStarterGoals } from "@/lib/defaults";
import {
  LocalWorkspaceConflictError,
  PersistenceError,
  evidenceKey,
  hasIndexedDbSupport,
  isEvidenceBlobRecord,
  isWorkspaceEnvelope,
  parseLegacyWorkspaceImportJournal,
  prepareLegacyWorkspaceImportCapture,
  prepareLegacyWorkspaceImportCommit,
  prepareLegacyWorkspaceImportDisable,
  prepareWorkspaceWrite,
  privacySafeWorkspaceExport,
  readWorkspace,
  recoverWorkspaceEnvelope,
  workspaceEnvelopeContentsEqual,
  workspaceKey,
  type WorkspaceEnvelope,
} from "@/lib/persistence";
import type { AppState } from "@/lib/types";
import { MAX_UNDO_HISTORY_ITEMS } from "@/lib/provider-state";

const state: AppState = {
  version: 3,
  updatedAt: "2026-07-18T12:00:00.000Z",
  profile: {
    displayName: "Explorer",
    chapter: "Build carefully",
    onboarded: true,
    createdAt: "2026-07-18T12:00:00.000Z",
  },
  settings: {
    theme: "dark",
    interfaceIntensity: "balanced",
    notifications: false,
    reminderTime: "18:00",
    dashboardOrder: ["life-map", "momentum", "goals", "qualities", "review"],
    hiddenDashboardSections: [],
    terminology: {
      goals: "Goals",
      quests: "Quests",
      areas: "Areas",
      milestones: "Milestones",
      stats: "Stats",
    },
  },
  areas: [],
  stats: [],
  goals: [],
  questCompletions: [],
  metricEntries: [],
  reviews: [],
  timeline: [],
};

const envelope: WorkspaceEnvelope = {
  accountId: "account-1",
  state,
  history: [{ ...state }],
  dirty: true,
  localRevision: 4,
  revision: 3,
  serverUpdatedAt: "2026-07-18T11:59:00.000Z",
  savedAt: "2026-07-18T12:01:00.000Z",
};

describe("persistence keys", () => {
  it("keeps evidence key parts separate without delimiter collisions", () => {
    expect(evidenceKey("account:one", "goal/two", "evidence|three")).toEqual([
      "account:one",
      "goal/two",
      "evidence|three",
    ]);
  });

  it("rejects blank or padded account identifiers explicitly", () => {
    for (const value of ["", "   ", " account-1 "]) {
      expect(() => workspaceKey(value)).toThrow(PersistenceError);
    }
  });
});

describe("legacy workspace import journal", () => {
  const firstTimestamp = "2026-07-21T10:00:00.000Z";
  const secondTimestamp = "2026-07-21T10:01:00.000Z";

  it("durably models the first observed raw value as pending", () => {
    const raw = JSON.stringify({ profile: { displayName: "Legacy" } });

    expect(prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      raw,
      firstTimestamp,
    )).toEqual({
      accountId: "account-1",
      status: "pending",
      raw,
      capturedAt: firstTimestamp,
    });

    expect(prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      "",
      firstTimestamp,
    )).toMatchObject({ status: "pending", raw: "" });
  });

  it("makes racing tabs adopt the first pending raw value", () => {
    const first = prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      "first-tab-raw",
      firstTimestamp,
    );

    expect(prepareLegacyWorkspaceImportCapture(
      first,
      "account-1",
      "second-tab-raw",
      secondTimestamp,
    )).toBe(first);
    expect(prepareLegacyWorkspaceImportCapture(
      first,
      "account-1",
      null,
      secondTimestamp,
    )).toBe(first);
  });

  it("commits only a captured import and clears its raw data", () => {
    const pending = prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      "legacy-raw",
      firstTimestamp,
    );
    const committed = prepareLegacyWorkspaceImportCommit(
      pending,
      "account-1",
      secondTimestamp,
    );

    expect(committed).toEqual({
      accountId: "account-1",
      status: "committed",
      committedAt: secondTimestamp,
    });
    expect("raw" in committed).toBe(false);
    expect(prepareLegacyWorkspaceImportCapture(
      committed,
      "account-1",
      "late-copy",
      secondTimestamp,
    )).toBe(committed);
    expect(() => prepareLegacyWorkspaceImportCommit(
      undefined,
      "account-1",
      secondTimestamp,
    )).toThrow(PersistenceError);
  });

  it("closes an empty first observation without allowing a later import", () => {
    const committed = prepareLegacyWorkspaceImportCapture(
      undefined,
      "account-1",
      null,
      firstTimestamp,
    );

    expect(committed).toEqual({
      accountId: "account-1",
      status: "committed",
      committedAt: firstTimestamp,
    });
    expect(prepareLegacyWorkspaceImportCapture(
      committed,
      "account-1",
      "appeared-later",
      secondTimestamp,
    )).toBe(committed);
  });

  it("recovers old one-shot claims conservatively", () => {
    const legacyClaim = {
      accountId: "account-1",
      claimedAt: firstTimestamp,
    };

    expect(prepareLegacyWorkspaceImportCapture(
      legacyClaim,
      "account-1",
      "still-in-local-storage",
      secondTimestamp,
    )).toEqual({
      accountId: "account-1",
      status: "pending",
      raw: "still-in-local-storage",
      capturedAt: secondTimestamp,
    });
    expect(prepareLegacyWorkspaceImportCapture(
      legacyClaim,
      "account-1",
      null,
      secondTimestamp,
    )).toEqual({
      accountId: "account-1",
      status: "committed",
      committedAt: firstTimestamp,
    });
    expect(parseLegacyWorkspaceImportJournal(legacyClaim, "account-1")).toEqual({
      accountId: "account-1",
      status: "committed",
      committedAt: firstTimestamp,
    });
  });

  it("keeps disabled terminal across capture, commit, and repeated disable", () => {
    const disabled = prepareLegacyWorkspaceImportDisable(
      undefined,
      "account-1",
      firstTimestamp,
    );

    expect(disabled).toEqual({
      accountId: "account-1",
      status: "disabled",
      disabledAt: firstTimestamp,
    });
    expect(prepareLegacyWorkspaceImportCapture(
      disabled,
      "account-1",
      "late-copy",
      secondTimestamp,
    )).toBe(disabled);
    expect(prepareLegacyWorkspaceImportCommit(disabled, "account-1", secondTimestamp)).toBe(disabled);
    expect(prepareLegacyWorkspaceImportDisable(disabled, "account-1", secondTimestamp)).toBe(disabled);
  });

  it("does not replace a completed import when disable is requested later", () => {
    const committed = {
      accountId: "account-1",
      status: "committed" as const,
      committedAt: firstTimestamp,
    };

    expect(prepareLegacyWorkspaceImportDisable(
      committed,
      "account-1",
      secondTimestamp,
    )).toBe(committed);
  });

  it("rejects malformed records everywhere except explicit disable repair", () => {
    const malformed = {
      accountId: "account-1",
      status: "pending",
      raw: "the-only-copy",
      capturedAt: "not-a-date",
    };

    expect(() => parseLegacyWorkspaceImportJournal(malformed, "account-1")).toThrow(PersistenceError);
    expect(() => prepareLegacyWorkspaceImportCapture(
      malformed,
      "account-1",
      "replacement",
      secondTimestamp,
    )).toThrow(PersistenceError);
    expect(() => prepareLegacyWorkspaceImportCommit(
      malformed,
      "account-1",
      secondTimestamp,
    )).toThrow(PersistenceError);
    expect(prepareLegacyWorkspaceImportDisable(
      malformed,
      "account-1",
      secondTimestamp,
    )).toEqual({
      accountId: "account-1",
      status: "disabled",
      disabledAt: secondTimestamp,
    });
  });

  it("rejects cross-account and non-canonical journal records", () => {
    expect(() => prepareLegacyWorkspaceImportCapture(
      {
        accountId: "account-2",
        status: "pending",
        raw: "other-account-copy",
        capturedAt: firstTimestamp,
      },
      "account-1",
      "replacement",
      secondTimestamp,
    )).toThrow(PersistenceError);
    expect(() => parseLegacyWorkspaceImportJournal({
      accountId: "account-1",
      status: "committed",
      committedAt: firstTimestamp,
      raw: "should-have-been-cleared",
    }, "account-1")).toThrow(PersistenceError);
  });
});

describe("workspace envelope validation", () => {
  it("accepts a complete account-scoped envelope", () => {
    expect(isWorkspaceEnvelope(envelope)).toBe(true);
  });

  it("rejects invalid revisions, dates, history, and state shapes", () => {
    expect(isWorkspaceEnvelope({ ...envelope, localRevision: -1 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, localRevision: 1.5 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, localRevision: undefined })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, revision: -1 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, revision: 1.5 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, savedAt: "not-a-date" })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, history: [{}] })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, state: { ...state, version: 1 } })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, state: { ...state, version: 2 } })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, dirty: "yes" })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, revision: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(isWorkspaceEnvelope({ ...envelope, serverUpdatedAt: "not-a-date" })).toBe(false);
  });

  it("normalizes legacy envelopes without a browser-local revision to zero", () => {
    const legacyEnvelope = { ...envelope } as Record<string, unknown>;
    delete legacyEnvelope.localRevision;

    expect(recoverWorkspaceEnvelope(legacyEnvelope, "account-1").localRevision).toBe(0);
  });

  it("validates transient recovery metadata when it is present", () => {
    expect(isWorkspaceEnvelope({
      ...envelope,
      recovery: {
        source: "history",
        recoveredFromHistoryIndex: 0,
        discardedHistoryEntries: 1,
        message: "A valid undo snapshot was restored.",
      },
    })).toBe(true);
    expect(isWorkspaceEnvelope({
      ...envelope,
      recovery: {
        source: "history",
        recoveredFromHistoryIndex: -1,
        discardedHistoryEntries: 1,
        message: "A valid undo snapshot was restored.",
      },
    })).toBe(false);
  });

  it("accepts the exact undo-count boundary and rejects boundary plus one", () => {
    const history = Array.from({ length: MAX_UNDO_HISTORY_ITEMS }, (_, index) => ({
      ...state,
      updatedAt: `2026-07-18T12:00:${String(index).padStart(2, "0")}.000Z`,
    }));

    expect(isWorkspaceEnvelope({ ...envelope, history })).toBe(true);
    expect(isWorkspaceEnvelope({ ...envelope, history: [...history, state] })).toBe(false);
  });
});

describe("workspace recovery", () => {
  const snapshot = (updatedAt: string, displayName: string): AppState => ({
    ...state,
    updatedAt,
    profile: { ...state.profile, displayName },
  });

  it("restores the newest valid undo snapshot when the current state is damaged", () => {
    const older = snapshot("2026-07-18T09:00:00.000Z", "Older snapshot");
    const newest = snapshot("2026-07-18T10:00:00.000Z", "Newest snapshot");
    const recovered = recoverWorkspaceEnvelope({
      ...envelope,
      state: { ...state, profile: null },
      history: [older, { ...state, version: 1 }, newest],
    }, "account-1");

    expect(recovered.state.profile.displayName).toBe("Newest snapshot");
    expect(recovered.history[0]).toEqual(older);
    expect(recovered.history[1]).toMatchObject({ version: 3 });
    expect(recovered.dirty).toBe(false);
    expect(recovered.localRevision).toBe(envelope.localRevision);
    expect(recovered.revision).toBe(envelope.revision);
    expect(recovered.recovery).toMatchObject({
      source: "history",
      recoveredFromHistoryIndex: 2,
      discardedHistoryEntries: 1,
    });
    expect(recovered.recovery?.message).toMatch(/latest device workspace was damaged/i);
    expect(recovered.recovery?.message).toContain(newest.updatedAt);
  });

  it("keeps an intact current state while removing damaged undo entries", () => {
    const valid = snapshot("2026-07-18T09:00:00.000Z", "Valid undo");
    const recovered = recoverWorkspaceEnvelope({
      ...envelope,
      history: [{ nope: true }, valid],
    }, "account-1");

    expect(recovered.state).toEqual(state);
    expect(recovered.history).toEqual([valid]);
    expect(recovered.dirty).toBe(true);
    expect(recovered.recovery).toMatchObject({
      source: "current",
      discardedHistoryEntries: 1,
    });
  });

  it("restores strict-valid history instead of silently dropping malformed nested data", () => {
    const recoverable = {
      ...state,
      metricEntries: [{
        id: "entry-damaged",
        goalId: "goal-removed",
        metricId: "metric-removed",
        value: -10,
        previousValue: Number.NaN,
        recordedAt: state.updatedAt,
        source: "manual",
      }],
    };
    const recovered = recoverWorkspaceEnvelope({ ...envelope, state: recoverable }, "account-1");

    expect(recovered.state).toEqual(state);
    expect(recovered.dirty).toBe(false);
    expect(recovered.recovery).toMatchObject({ source: "history" });
  });

  it("migrates a valid v2 device snapshot to canonical v3 and marks it dirty", () => {
    const legacy = { ...state, version: 2 };
    const recovered = recoverWorkspaceEnvelope({
      ...envelope,
      state: legacy,
      history: [],
      dirty: false,
    }, "account-1");

    expect(recovered.state.version).toBe(3);
    expect(recovered.dirty).toBe(true);
    expect(recovered.recovery?.message).toMatch(/current snapshot was upgraded/i);
  });

  it("fails explicitly without overwriting when neither current nor history is usable", () => {
    expect(() => recoverWorkspaceEnvelope({
      ...envelope,
      state: { broken: true },
      history: [{ also: "broken" }],
    }, "account-1")).toThrow(/no valid undo snapshot.*nothing was overwritten/i);
  });

  it("quarantines a future current snapshot even when older history is valid", () => {
    const raw = {
      ...envelope,
      state: { ...state, version: 4 },
      history: [state],
    };
    const before = structuredClone(raw);

    expect(() => recoverWorkspaceEnvelope(raw, "account-1")).toThrow(
      /version 4.*newer.*nothing was overwritten/i,
    );
    expect(raw).toEqual(before);
  });

  it("retains only the newest bounded undo window from a legacy oversized history", () => {
    const history = Array.from({ length: MAX_UNDO_HISTORY_ITEMS + 2 }, (_, index) =>
      snapshot(`2026-07-18T10:00:${String(index).padStart(2, "0")}.000Z`, `Snapshot ${index}`));
    const recovered = recoverWorkspaceEnvelope({ ...envelope, history }, "account-1");

    expect(recovered.history).toHaveLength(MAX_UNDO_HISTORY_ITEMS);
    expect(recovered.history[0].profile.displayName).toBe("Snapshot 2");
    expect(recovered.history.at(-1)?.profile.displayName).toBe("Snapshot 11");
    expect(recovered.recovery?.discardedHistoryEntries).toBe(2);
  });

  it("never recovers data from a different account", () => {
    expect(() => recoverWorkspaceEnvelope(envelope, "account-2")).toThrow(/belongs to another account/i);
  });
});

describe("workspace local compare-and-swap semantics", () => {
  it("treats write timestamps, transient recovery, and local revisions as the same content", () => {
    expect(workspaceEnvelopeContentsEqual(envelope, {
      ...envelope,
      localRevision: envelope.localRevision + 5,
      savedAt: "2026-07-18T13:00:00.000Z",
      recovery: {
        source: "current",
        discardedHistoryEntries: 1,
        message: "A damaged undo snapshot was removed.",
      },
    })).toBe(true);
  });

  it("detects persisted workspace changes", () => {
    expect(workspaceEnvelopeContentsEqual(envelope, {
      ...envelope,
      state: {
        ...envelope.state,
        profile: { ...envelope.state.profile, displayName: "Another tab" },
      },
    })).toBe(false);
  });

  it("increments a matching revision and returns the stored copy for a same-content no-op", () => {
    const first = prepareWorkspaceWrite(null, { ...envelope, localRevision: 0 });
    expect(first).toMatchObject({ action: "write", envelope: { localRevision: 1 } });

    const noOp = prepareWorkspaceWrite(envelope, {
      ...envelope,
      localRevision: 1,
      savedAt: "2026-07-18T14:00:00.000Z",
    });
    expect(noOp).toEqual({ action: "no-op", envelope });
  });

  it("rejects stale changed content with the typed local conflict", () => {
    expect(() => prepareWorkspaceWrite(envelope, {
      ...envelope,
      localRevision: envelope.localRevision - 1,
      state: {
        ...envelope.state,
        profile: { ...envelope.state.profile, displayName: "Stale tab" },
      },
    })).toThrow(LocalWorkspaceConflictError);
  });

  it("exposes a typed, privacy-safe local conflict without embedding workspace data", () => {
    const error = new LocalWorkspaceConflictError("account-1", 3, 4);

    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).toMatchObject({
      name: "LocalWorkspaceConflictError",
      code: "local-conflict",
      operation: "write-workspace",
      accountId: "account-1",
      expectedLocalRevision: 3,
      actualLocalRevision: 4,
    });
    expect(error.message).not.toContain("account-1");
    expect(error.message).not.toContain(state.profile.displayName);
  });
});

describe("privacy-safe in-memory recovery export", () => {
  it("keeps workspace records while removing account-bound cloud file paths", () => {
    const goal = createStarterGoals()[0];
    const evidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const remotePath = `private-account/${goal.id}/${evidenceId}/proof.pdf`;
    const source: AppState = {
      ...state,
      goals: [{
        ...goal,
        evidence: [{
          id: evidenceId,
          type: "file",
          name: "proof.pdf",
          mimeType: "application/pdf",
          size: 12,
          remotePath,
        }],
      }],
    };

    const exported = privacySafeWorkspaceExport(source);
    const exportedEvidence = exported.goals[0].evidence[0];

    expect(exported.profile).toEqual(source.profile);
    expect(exportedEvidence).toEqual({
      id: evidenceId,
      type: "file",
      name: "proof.pdf",
      mimeType: "application/pdf",
      size: 12,
    });
    expect(JSON.stringify(exported)).not.toContain("private-account");
    expect(JSON.stringify(exported)).not.toContain("migrationDataUrl");
    expect(source.goals[0].evidence[0]).toMatchObject({ remotePath });
  });
});

describe("evidence record validation", () => {
  it("accepts a scoped Blob record and rejects malformed ownership or payload data", () => {
    const record = {
      accountId: "account-1",
      goalId: "goal-1",
      evidenceId: "evidence-1",
      blob: new Blob(["proof"], { type: "text/plain" }),
      savedAt: "2026-07-18T12:00:00.000Z",
    };

    expect(isEvidenceBlobRecord(record)).toBe(true);
    expect(isEvidenceBlobRecord({ ...record, accountId: " account-1" })).toBe(false);
    expect(isEvidenceBlobRecord({ ...record, blob: "proof" })).toBe(false);
    expect(isEvidenceBlobRecord({ ...record, blob: new Blob(["proof"], { type: "text/html" }) })).toBe(false);
    expect(isEvidenceBlobRecord({ ...record, blob: new Blob([new Uint8Array(10_485_761)], { type: "text/plain" }) })).toBe(false);
    expect(isEvidenceBlobRecord({ ...record, blob: new Blob(["proof"], { type: "text/plain;charset=utf-8" }) })).toBe(true);
    expect(isEvidenceBlobRecord({ ...record, savedAt: "sometime" })).toBe(false);
  });
});

describe("IndexedDB capability detection", () => {
  it("returns false when IndexedDB is absent or access throws", () => {
    expect(hasIndexedDbSupport({})).toBe(false);
    expect(hasIndexedDbSupport({
      get indexedDB() {
        throw new Error("blocked");
      },
    })).toBe(false);
  });

  it("recognises an IndexedDB-shaped factory without opening it", () => {
    expect(hasIndexedDbSupport({ indexedDB: { open: () => undefined } })).toBe(true);
  });

  it("reports an explicit unavailable error before attempting a read in non-browser environments", async () => {
    if (hasIndexedDbSupport()) return;

    await expect(readWorkspace("account-1")).rejects.toMatchObject({
      name: "PersistenceError",
      code: "unavailable",
      operation: "open-database",
    });
  });
});
