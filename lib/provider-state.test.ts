import { describe, expect, it } from "vitest";
import { EMPTY_STATE } from "@/lib/defaults";
import {
  adoptAuthoritativeWorkspaceState,
  runNonUndoableWorkspaceMutation,
  runUndoableWorkspaceMutation,
  trimWorkspaceHistory,
  workspaceStatesEqual,
} from "@/lib/provider-state";

describe("provider workspace transitions", () => {
  it("creates one immutable undo snapshot for one logical command", () => {
    const current = structuredClone(EMPTY_STATE);
    const priorHistory = Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(EMPTY_STATE),
      updatedAt: `2026-07-18T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    const result = runUndoableWorkspaceMutation(current, priorHistory, (draft) => {
      draft.profile.displayName = "Changed once";
      draft.profile.chapter = "One command";
    }, "2026-07-18T12:00:00.000Z");

    expect(result.history).toHaveLength(10);
    expect(result.history.at(-1)).toEqual(current);
    expect(result.history.at(-1)).toBe(current);
    expect(result.state.profile).toMatchObject({
      displayName: "Changed once",
      chapter: "One command",
    });
    expect(result.state.updatedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(current.profile.displayName).toBe(EMPTY_STATE.profile.displayName);
  });

  it("rejects an invalid transition before changing current state or history", () => {
    const current = structuredClone(EMPTY_STATE);
    const history = [structuredClone(EMPTY_STATE)];

    expect(() => runUndoableWorkspaceMutation(current, history, (draft) => {
      draft.settings.terminology.goals = "";
    })).toThrow();
    expect(current.settings.terminology.goals).toBe("Goals");
    expect(history).toHaveLength(1);
    expect(history[0].settings.terminology.goals).toBe("Goals");
  });

  it("clears undo history for file-backed destructive transitions", () => {
    const result = runNonUndoableWorkspaceMutation(
      structuredClone(EMPTY_STATE),
      (draft) => { draft.profile.displayName = "Current only"; },
      "2026-07-18T12:00:00.000Z",
    );

    expect(result.history).toEqual([]);
    expect(result.state.profile.displayName).toBe("Current only");
  });

  it("starts a new undo boundary when a cloud snapshot becomes authoritative", () => {
    const cloudState = structuredClone(EMPTY_STATE);
    cloudState.profile.displayName = "Cloud authority";
    const preCloudHistory = [structuredClone(EMPTY_STATE)];
    preCloudHistory[0].profile.displayName = "Device snapshot that must not return";

    const result = adoptAuthoritativeWorkspaceState(cloudState);

    expect(result.history).toEqual([]);
    expect(result.state).toEqual(cloudState);
    expect(result.state).not.toBe(cloudState);
    expect(preCloudHistory[0].profile.displayName).toBe("Device snapshot that must not return");
  });

  it("compares object keys semantically while preserving array order", () => {
    const reordered = Object.fromEntries(Object.entries(EMPTY_STATE).reverse());
    expect(workspaceStatesEqual(
      EMPTY_STATE,
      reordered as unknown as typeof EMPTY_STATE,
    )).toBe(true);
    expect(workspaceStatesEqual(
      EMPTY_STATE,
      { ...EMPTY_STATE, areas: [...EMPTY_STATE.areas].reverse() },
    )).toBe(false);
  });

  it("retains newest undo snapshots within an explicit byte budget", () => {
    const snapshots = ["old", "middle", "new"].map((displayName, index) => ({
      ...structuredClone(EMPTY_STATE),
      updatedAt: `2026-07-18T00:00:0${index}.000Z`,
      profile: { ...structuredClone(EMPTY_STATE.profile), displayName },
    }));
    const newestBytes = new TextEncoder().encode(JSON.stringify(snapshots[2])).byteLength;

    expect(trimWorkspaceHistory(snapshots, 10, newestBytes)).toEqual([snapshots[2]]);
    expect(trimWorkspaceHistory(snapshots, 10, newestBytes - 1)).toEqual([]);
  });

  it("honours zero and exact item boundaries without slice(-0) retaining everything", () => {
    const snapshots = Array.from({ length: 3 }, (_, index) => ({
      ...structuredClone(EMPTY_STATE),
      updatedAt: `2026-07-18T00:00:0${index}.000Z`,
    }));

    expect(trimWorkspaceHistory(snapshots, 0)).toEqual([]);
    expect(trimWorkspaceHistory(snapshots, 1)).toEqual([snapshots[2]]);
    expect(trimWorkspaceHistory(snapshots, 2)).toEqual(snapshots.slice(-2));
    expect(trimWorkspaceHistory(snapshots, -1)).toEqual([]);
    expect(trimWorkspaceHistory(snapshots, Number.POSITIVE_INFINITY)).toEqual([]);
  });
});
