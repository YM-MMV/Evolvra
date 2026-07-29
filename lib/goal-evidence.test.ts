import { describe, expect, it } from "vitest";
import {
  decodeLegacyGoalEvidence,
  isStructurallyValidRemoteEvidencePath,
  migrationDataUrlBlob,
  MAX_EVIDENCE_FILE_SIZE,
  MAX_GOAL_EVIDENCE_ITEMS,
  normalizedEvidenceBlob,
  validateGoalEvidenceList,
} from "@/lib/goal-evidence";
import type { GoalEvidence } from "@/lib/types";

const GOAL_ID = "goal-one";
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("legacy goal evidence decoding", () => {
  it.each([UUID, "evidence_old_123"])("preserves a safe legacy id %s", (id) => {
    const path = `account-1/${GOAL_ID}/${id}/proof.txt`;
    const decoded = decodeLegacyGoalEvidence(
      `file|${id}|proof.txt|text%2Fplain|5|${encodeURIComponent(path)}`,
      GOAL_ID,
      0,
    );

    expect(decoded).toEqual({
      status: "valid",
      evidence: {
        id,
        type: "file",
        name: "proof.txt",
        mimeType: "text/plain",
        size: 5,
        remotePath: path,
      },
    });
  });

  it.each(["", "1e3", "0x10", "01", "-1", "1.5"])(
    "rejects non-canonical file size %j",
    (size) => {
      const decoded = decodeLegacyGoalEvidence(
        `file|${UUID}|proof.txt|text%2Fplain|${size}|`,
        GOAL_ID,
        0,
      );
      expect(decoded.status).toBe("invalid");
    },
  );

  it("rejects a path whose goal or evidence segment does not match", () => {
    for (const path of [
      `account-1/other-goal/${UUID}/proof.txt`,
      `account-1/${GOAL_ID}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/proof.txt`,
    ]) {
      const decoded = decodeLegacyGoalEvidence(
        `file|${UUID}|proof.txt|text%2Fplain|5|${encodeURIComponent(path)}`,
        GOAL_ID,
        0,
      );
      expect(decoded.status).toBe("invalid");
    }
  });
});

describe("embedded evidence decoding", () => {
  it.each([
    "data:text/plain;base64,cHJvb2Y=",
    "data:text/plain;charset=utf-8,proof",
    "data:text/plain,pr%6Fof",
  ])("decodes %s locally with canonical MIME", async (dataUrl) => {
    const blob = migrationDataUrlBlob(dataUrl, { mimeType: "text/plain", size: 5 });
    expect(blob?.type).toBe("text/plain");
    expect(blob?.size).toBe(5);
    expect(await blob?.text()).toBe("proof");
  });

  it.each([
    "data:text/html;base64,cHJvb2Y=",
    "data:text/plain;base64,***",
    "data:text/plain;unsupported=x,proof",
  ])("rejects malformed or unsupported payload %s", (dataUrl) => {
    expect(migrationDataUrlBlob(dataUrl, { mimeType: "text/plain", size: 5 })).toBeNull();
  });

  it("normalizes a charset Blob only when exact metadata matches", () => {
    const source = new Blob(["proof"], { type: "text/plain;charset=utf-8" });
    expect(normalizedEvidenceBlob(source, { mimeType: "text/plain", size: 5 })?.type).toBe("text/plain");
    expect(normalizedEvidenceBlob(source, { mimeType: "text/plain", size: 4 })).toBeNull();
    expect(normalizedEvidenceBlob(source, { mimeType: "application/pdf", size: 5 })).toBeNull();
  });
});

describe("runtime evidence boundary", () => {
  const note = (id: string): GoalEvidence => ({ id, type: "note", text: "Proof" });

  it("enforces the item cap and unique ids", () => {
    const atLimit = Array.from({ length: MAX_GOAL_EVIDENCE_ITEMS }, (_, index) => note(`legacy-${index}`));
    expect(() => validateGoalEvidenceList(atLimit, GOAL_ID)).not.toThrow();
    expect(() => validateGoalEvidenceList([...atLimit, note("overflow")], GOAL_ID)).toThrow(/at most/i);
    expect(() => validateGoalEvidenceList([note("same"), note("same")], GOAL_ID)).toThrow(/unique/i);
  });

  it("rejects extra fields and cross-goal cloud paths", () => {
    expect(() => validateGoalEvidenceList([{
      ...note("legacy-note"),
      migrationDataUrl: "data:text/plain,proof",
    } as unknown as GoalEvidence], GOAL_ID)).toThrow(/unsupported metadata/i);

    expect(() => validateGoalEvidenceList([{
      id: UUID,
      type: "file",
      name: "proof.txt",
      mimeType: "text/plain",
      size: 5,
      remotePath: `account-1/other-goal/${UUID}/proof.txt`,
    }], GOAL_ID)).toThrow(/metadata is invalid/i);
  });

  it("rejects traversal and oversized metadata", () => {
    expect(isStructurallyValidRemoteEvidencePath(
      `account-1/${GOAL_ID}/${UUID}/%2e%2e`,
      UUID,
      GOAL_ID,
    )).toBe(false);
    expect(() => validateGoalEvidenceList([{
      id: UUID,
      type: "file",
      name: "proof.txt",
      mimeType: "text/plain",
      size: MAX_EVIDENCE_FILE_SIZE + 1,
    }], GOAL_ID)).toThrow(/metadata is invalid/i);
  });
});
