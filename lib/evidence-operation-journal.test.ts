import { describe, expect, it, vi } from "vitest";
import {
  appendEvidenceBlobCopies,
  deleteEvidenceWithCompensation,
  EvidenceCompensationError,
  rollbackEvidenceBlobJournal,
  type EvidenceBlobJournalEntry,
} from "@/lib/evidence-operation-journal";
import type { EvidenceBlobRecord } from "@/lib/persistence";

const record = (accountId: string, evidenceId: string, contents: string): EvidenceBlobRecord => ({
  accountId,
  goalId: "goal-1",
  evidenceId,
  blob: new Blob([contents], { type: "text/plain" }),
  savedAt: "2026-07-19T12:00:00.000Z",
});

describe("compensated evidence deletion", () => {
  it("does not delete bytes when the durable metadata commit fails", async () => {
    const local = record("account-1", "evidence-1", "local exact bytes");
    const remote = { path: "account-1/goal-1/evidence-2/proof.txt", blob: new Blob(["remote exact bytes"], { type: "text/plain" }) };
    const events: string[] = [];

    await expect(deleteEvidenceWithCompensation({
      local: [local],
      remote: [remote],
      isScopeCurrent: () => true,
      removeRemote: async () => { events.push("remove-remote"); },
      removeLocal: async () => { events.push("remove-local"); },
      commitMetadata: async () => { events.push("commit"); throw new Error("metadata failed"); },
      rollbackMetadata: async () => { events.push("rollback-metadata"); },
      restoreRemote: async (snapshot) => { expect(snapshot).toBe(remote); events.push("restore-remote"); },
      restoreLocal: async (snapshot) => { expect(snapshot).toBe(local); events.push("restore-local"); },
    })).rejects.toThrow("metadata failed");

    expect(events).toEqual(["commit", "rollback-metadata"]);
  });

  it("restores data on scope loss and attempts every restoration after a rollback failure", async () => {
    let scopeChecks = 0;
    const restoreLocal = vi.fn(async () => { throw new Error("local restore failed"); });
    const restoreRemote = vi.fn(async () => undefined);

    await expect(deleteEvidenceWithCompensation({
      local: [record("account-1", "evidence-1", "local")],
      remote: [{ path: "remote", blob: new Blob(["remote"]) }],
      isScopeCurrent: () => ++scopeChecks <= 2,
      removeRemote: async () => undefined,
      removeLocal: async () => undefined,
      commitMetadata: async () => undefined,
      rollbackMetadata: async () => undefined,
      restoreRemote,
      restoreLocal,
    })).rejects.toBeInstanceOf(EvidenceCompensationError);

    expect(restoreRemote).toHaveBeenCalledOnce();
    expect(restoreLocal).toHaveBeenCalledOnce();
  });

  it("commits metadata first and rolls it back after a byte deletion failure", async () => {
    const events: string[] = [];
    await expect(deleteEvidenceWithCompensation({
      local: [record("account-1", "evidence-1", "local")],
      remote: [],
      isScopeCurrent: () => true,
      commitMetadata: async () => { events.push("commit-metadata"); },
      rollbackMetadata: async () => { events.push("rollback-metadata"); },
      removeRemote: async () => undefined,
      removeLocal: async () => { events.push("remove-local"); throw new Error("delete failed"); },
      restoreRemote: async () => undefined,
      restoreLocal: async () => { events.push("restore-local"); },
    })).rejects.toThrow("delete failed");

    expect(events).toEqual(["commit-metadata", "remove-local", "restore-local", "rollback-metadata"]);
  });
});

describe("evidence copy journal", () => {
  it("restores overwritten targets and deletes new targets in reverse order", async () => {
    const old = record("target", "evidence-1", "old");
    const source = [
      record("anonymous", "evidence-1", "new one"),
      record("anonymous", "evidence-2", "new two"),
    ];
    const journal: EvidenceBlobJournalEntry[] = [];
    const writes: EvidenceBlobRecord[] = [];

    await appendEvidenceBlobCopies(source, "target", journal, {
      readTarget: async (_accountId, _goalId, evidenceId) => evidenceId === old.evidenceId ? old : null,
      writeTarget: async (item) => { writes.push(item); },
    });

    expect(writes.map((item) => item.accountId)).toEqual(["target", "target"]);
    const rollbackEvents: string[] = [];
    await rollbackEvidenceBlobJournal(journal, {
      restore: async (item) => { expect(item).toBe(old); rollbackEvents.push(`restore:${item.evidenceId}`); },
      remove: async (_accountId, _goalId, evidenceId) => { rollbackEvents.push(`remove:${evidenceId}`); },
    });
    expect(rollbackEvents).toEqual(["remove:evidence-2", "restore:evidence-1"]);
  });

  it("can fully reverse the successful prefix of a partially failed copy", async () => {
    const old = record("target", "evidence-1", "old exact bytes");
    const source = [
      record("anonymous", "evidence-1", "replacement"),
      record("anonymous", "evidence-2", "copy that fails"),
    ];
    const journal: EvidenceBlobJournalEntry[] = [];
    const target = new Map<string, EvidenceBlobRecord>([[old.evidenceId, old]]);

    await expect(appendEvidenceBlobCopies(source, "target", journal, {
      readTarget: async (_accountId, _goalId, evidenceId) => target.get(evidenceId) ?? null,
      writeTarget: async (item) => {
        if (item.evidenceId === "evidence-2") throw new Error("target write failed");
        target.set(item.evidenceId, item);
      },
    })).rejects.toThrow("target write failed");

    await rollbackEvidenceBlobJournal(journal, {
      restore: async (item) => { target.set(item.evidenceId, item); },
      remove: async (_accountId, _goalId, evidenceId) => { target.delete(evidenceId); },
    });
    expect(target.get(old.evidenceId)).toBe(old);
    expect(target.has("evidence-2")).toBe(false);
  });
});
