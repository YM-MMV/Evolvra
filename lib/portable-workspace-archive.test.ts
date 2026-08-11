import { describe, expect, it } from "vitest";
import {
  DEFAULT_AREAS,
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
} from "@/lib/defaults";
import {
  PORTABLE_WORKSPACE_ARCHIVE_MIME_TYPE,
  PortableWorkspaceArchiveError,
  createPortableWorkspaceArchive,
  inspectAndPreparePortableWorkspaceArchiveImport,
  inspectPortableWorkspaceArchive,
  preparePortableWorkspaceArchiveImport,
  requireValidPortableWorkspaceArchive,
  type PortableWorkspaceArchiveArtifact,
  type PortableWorkspaceArchiveManifestV1,
} from "@/lib/portable-workspace-archive";
import { parseImportedState } from "@/lib/state-schema";
import type { AppState, GoalFileEvidence } from "@/lib/types";
import type { EvidenceBlobRecord } from "@/lib/persistence";

const CREATED_AT = "2026-07-28T08:00:00.000Z";
const ARCHIVED_AT = "2026-07-29T09:00:00.000Z";
const IMPORTED_AT = "2026-07-30T10:00:00.000Z";
const MAGIC = new TextEncoder().encode("EVOLVRA-WORKSPACE-ARCHIVE\n");
const HEADER_BYTES = MAGIC.byteLength + 4 + 32;

const clone = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const lexicalCompare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(lexicalCompare)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Test archive value is not JSON-compatible.");
}

function workspace(
  label: "Source" | "Current",
  accountId: string,
  withFiles = true,
): AppState {
  const slug = label.toLowerCase();
  const goalId = `${slug}-goal`;
  const proof: GoalFileEvidence = {
    id: `${slug}-proof`,
    type: "file",
    name: "proof.txt",
    mimeType: "text/plain",
    size: 5,
    remotePath: `${accountId}/${goalId}/${slug}-proof/proof.txt`,
  };
  const image: GoalFileEvidence = {
    id: `${slug}-image`,
    type: "file",
    name: "image.png",
    mimeType: "image/png",
    size: 3,
    remotePath: `${accountId}/${goalId}/${slug}-image/image.png`,
  };
  const state: AppState = {
    version: 3,
    updatedAt: CREATED_AT,
    profile: {
      displayName: `${label} person`,
      chapter: `${label} chapter`,
      onboarded: true,
      createdAt: CREATED_AT,
    },
    settings: {
      ...clone(DEFAULT_SETTINGS),
      theme: label === "Source" ? "dark" : "light",
    },
    areas: [clone(DEFAULT_AREAS[0])],
    stats: [clone(DEFAULT_STATS[0])],
    goals: [{
      id: goalId,
      title: `${label} goal`,
      description: `${label} description`,
      areaId: DEFAULT_AREAS[0].id,
      model: "open",
      priority: "high",
      status: "active",
      createdAt: CREATED_AT,
      metrics: [],
      milestones: [],
      quests: [],
      statIds: [DEFAULT_STATS[0].id],
      checkIns: [],
      evidence: withFiles
        ? [
            image,
            { id: `${slug}-note`, type: "note", text: `${label} note` },
            proof,
          ]
        : [],
      notes: "",
    }],
    questCompletions: [],
    metricEntries: [],
    reviews: [],
    timeline: [],
  };
  return parseImportedState(state, CREATED_AT);
}

function evidenceRecord(
  accountId: string,
  goalId: string,
  evidenceId: string,
  contents: BlobPart,
  mimeType: string,
): EvidenceBlobRecord {
  return {
    accountId,
    goalId,
    evidenceId,
    blob: new Blob([contents], { type: mimeType }),
    savedAt: CREATED_AT,
  };
}

function sourceEvidence(accountId = "source-account"): EvidenceBlobRecord[] {
  return [
    evidenceRecord(
      accountId,
      "source-goal",
      "source-proof",
      "proof",
      "text/plain",
    ),
    evidenceRecord(
      accountId,
      "source-goal",
      "source-image",
      new Uint8Array([1, 2, 3]),
      "image/png",
    ),
  ];
}

async function archiveBytes(
  artifact: PortableWorkspaceArchiveArtifact,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await artifact.blob.arrayBuffer());
}

function manifestLength(bytes: Uint8Array<ArrayBuffer>) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(MAGIC.byteLength, false);
}

async function rebuildWithManifest(
  artifact: PortableWorkspaceArchiveArtifact,
  mutate: (manifest: PortableWorkspaceArchiveManifestV1) => void,
  payload?: (
    bytes: Uint8Array<ArrayBuffer>,
    manifest: PortableWorkspaceArchiveManifestV1,
  ) => Uint8Array<ArrayBuffer>,
): Promise<Blob> {
  const source = await archiveBytes(artifact);
  const oldManifestLength = manifestLength(source);
  const oldPayload = source.slice(HEADER_BYTES + oldManifestLength);
  const manifest = clone(artifact.manifest);
  mutate(manifest);
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", manifestBytes),
  );
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(
    MAGIC.byteLength,
    manifestBytes.byteLength,
    false,
  );
  header.set(digest, MAGIC.byteLength + 4);
  const nextPayload = payload ? payload(oldPayload, manifest) : oldPayload;
  return new Blob(
    [header, manifestBytes, nextPayload],
    { type: PORTABLE_WORKSPACE_ARCHIVE_MIME_TYPE },
  );
}

async function completeArchive() {
  return createPortableWorkspaceArchive({
    state: workspace("Source", "source-account"),
    sourceAccountId: "source-account",
    evidence: sourceEvidence(),
    createdAt: ARCHIVED_AT,
  });
}

describe("portable workspace archive creation", () => {
  it("is deterministic, strips account paths, sorts evidence, and excludes orphaned blobs", async () => {
    const orphan = evidenceRecord(
      "source-account",
      "orphan-goal",
      "orphan-file",
      "orphan",
      "text/plain",
    );
    const evidence = [...sourceEvidence(), orphan];
    const first = await createPortableWorkspaceArchive({
      state: workspace("Source", "source-account"),
      sourceAccountId: "source-account",
      evidence,
      createdAt: ARCHIVED_AT,
    });
    const second = await createPortableWorkspaceArchive({
      state: workspace("Source", "source-account"),
      sourceAccountId: "source-account",
      evidence: [...evidence].reverse(),
      createdAt: ARCHIVED_AT,
    });

    expect(await archiveBytes(first)).toEqual(await archiveBytes(second));
    expect(first.manifest.evidence.map((item) => item.evidenceId)).toEqual([
      "source-image",
      "source-proof",
    ]);
    expect(first.report).toMatchObject({
      complete: true,
      evidenceBytes: 8,
      missingEvidence: [],
      orphanedEvidence: [{
        goalId: "orphan-goal",
        evidenceId: "orphan-file",
        key: "evidence/orphan-goal/orphan-file",
      }],
    });
    expect(await first.blob.text()).not.toContain("source-account");
    expect(first.blob.type).toBe(PORTABLE_WORKSPACE_ARCHIVE_MIME_TYPE);
  });

  it("round-trips canonical workspace data and exact evidence bytes", async () => {
    const artifact = await completeArchive();
    const inspection = await inspectPortableWorkspaceArchive(artifact.blob);

    expect(inspection.status).toBe("valid");
    if (inspection.status !== "valid") throw new Error("Expected a valid archive.");
    expect(inspection.content.state.profile.displayName).toBe("Source person");
    expect(
      inspection.content.state.goals[0].evidence
        .filter((item) => item.type === "file")
        .every((item) => item.remotePath === undefined),
    ).toBe(true);
    expect(inspection.content.evidence.map((item) => item.evidenceId)).toEqual([
      "source-image",
      "source-proof",
    ]);
    expect(
      await inspection.content.evidence.find(
        (item) => item.evidenceId === "source-proof",
      )?.blob.text(),
    ).toBe("proof");
    expect(
      new Uint8Array(
        await inspection.content.evidence.find(
          (item) => item.evidenceId === "source-image",
        )!.blob.arrayBuffer(),
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("makes missing local bytes explicit and refuses to trust an incomplete archive", async () => {
    const artifact = await createPortableWorkspaceArchive({
      state: workspace("Source", "source-account"),
      sourceAccountId: "source-account",
      evidence: sourceEvidence().slice(0, 1),
      createdAt: ARCHIVED_AT,
    });

    expect(artifact.report.complete).toBe(false);
    expect(artifact.report.missingEvidence).toEqual([{
      goalId: "source-goal",
      evidenceId: "source-image",
      key: "evidence/source-goal/source-image",
    }]);
    const inspection = await inspectPortableWorkspaceArchive(artifact.blob);
    expect(inspection.status).toBe("incomplete");
    expect(inspection.issues).toEqual([expect.objectContaining({
      code: "missing-evidence",
      key: "evidence/source-goal/source-image",
    })]);
    await expect(
      requireValidPortableWorkspaceArchive(artifact.blob),
    ).rejects.toMatchObject({
      name: "PortableWorkspaceArchiveError",
      code: "missing-evidence",
    });
  });

  it("rejects duplicate, cross-account, and metadata-inconsistent source records", async () => {
    const state = workspace("Source", "source-account");
    const evidence = sourceEvidence();

    await expect(createPortableWorkspaceArchive({
      state,
      sourceAccountId: "source-account",
      evidence: [evidence[0], evidence[0]],
      createdAt: ARCHIVED_AT,
    })).rejects.toMatchObject({ code: "duplicate-evidence" });

    await expect(createPortableWorkspaceArchive({
      state,
      sourceAccountId: "source-account",
      evidence: sourceEvidence("another-account"),
      createdAt: ARCHIVED_AT,
    })).rejects.toMatchObject({ code: "evidence-scope" });

    await expect(createPortableWorkspaceArchive({
      state,
      sourceAccountId: "source-account",
      evidence: [
        evidenceRecord(
          "source-account",
          "source-goal",
          "source-proof",
          "wrong-size",
          "text/plain",
        ),
        evidence[1],
      ],
      createdAt: ARCHIVED_AT,
    })).rejects.toMatchObject({ code: "evidence-metadata" });
  });

  it("requires canonical creation timestamps", async () => {
    await expect(createPortableWorkspaceArchive({
      state: workspace("Source", "source-account"),
      sourceAccountId: "source-account",
      evidence: sourceEvidence(),
      createdAt: "July 29",
    })).rejects.toBeInstanceOf(PortableWorkspaceArchiveError);
  });
});

describe("portable workspace archive integrity", () => {
  it("detects manifest checksum drift before trusting offsets or metadata", async () => {
    const artifact = await completeArchive();
    const bytes = await archiveBytes(artifact);
    bytes[HEADER_BYTES + 4] ^= 1;

    const inspection = await inspectPortableWorkspaceArchive(new Blob([bytes]));
    expect(inspection).toMatchObject({
      status: "invalid",
      issues: [{ code: "manifest-integrity" }],
    });
  });

  it("detects workspace and evidence byte tampering independently", async () => {
    const artifact = await completeArchive();
    const source = await archiveBytes(artifact);
    const workspaceOffset = HEADER_BYTES + manifestLength(source);
    const workspaceTamper = source.slice();
    workspaceTamper[workspaceOffset] ^= 1;
    expect(
      await inspectPortableWorkspaceArchive(new Blob([workspaceTamper])),
    ).toMatchObject({
      status: "invalid",
      issues: [{ code: "workspace-integrity" }],
    });

    const evidenceOffset = workspaceOffset + artifact.manifest.workspace.size;
    const evidenceTamper = source.slice();
    evidenceTamper[evidenceOffset] ^= 1;
    expect(
      await inspectPortableWorkspaceArchive(new Blob([evidenceTamper])),
    ).toMatchObject({
      status: "invalid",
      issues: [{ code: "evidence-integrity" }],
    });
  });

  it("detects truncation and undeclared trailing bytes", async () => {
    const artifact = await completeArchive();
    const bytes = await archiveBytes(artifact);

    expect(
      await inspectPortableWorkspaceArchive(new Blob([bytes.slice(0, -1)])),
    ).toMatchObject({
      status: "invalid",
      issues: [{ code: "payload-length" }],
    });
    expect(
      await inspectPortableWorkspaceArchive(
        new Blob([bytes, new Uint8Array([255])]),
      ),
    ).toMatchObject({
      status: "invalid",
      issues: [{ code: "extra-payload" }],
    });
  });

  it("detects duplicate manifest entries even when the manifest digest is recomputed", async () => {
    const artifact = await completeArchive();
    const duplicate = await rebuildWithManifest(artifact, (manifest) => {
      manifest.evidence.splice(1, 0, clone(manifest.evidence[0]));
    });

    expect(await inspectPortableWorkspaceArchive(duplicate)).toMatchObject({
      status: "invalid",
      issues: [{ code: "duplicate-evidence" }],
    });
  });

  it("detects metadata drift and workspace references missing from the manifest", async () => {
    const artifact = await completeArchive();
    const renamed = await rebuildWithManifest(artifact, (manifest) => {
      manifest.evidence[0].name = "renamed.png";
    });
    expect(await inspectPortableWorkspaceArchive(renamed)).toMatchObject({
      status: "invalid",
      issues: [{ code: "evidence-metadata" }],
    });

    const missing = await rebuildWithManifest(
      artifact,
      (manifest) => {
        manifest.evidence = [];
      },
      (payload, manifest) => payload.slice(0, manifest.workspace.size),
    );
    expect(await inspectPortableWorkspaceArchive(missing)).toMatchObject({
      status: "invalid",
      issues: [{ code: "missing-evidence" }],
    });
  });

  it("rejects future archive formats without interpreting their payloads", async () => {
    const artifact = await completeArchive();
    const future = await rebuildWithManifest(artifact, (manifest) => {
      (manifest as { version: number }).version = 2;
    });

    expect(await inspectPortableWorkspaceArchive(future)).toMatchObject({
      status: "invalid",
      issues: [{ code: "unsupported-version" }],
    });
  });
});

describe("portable workspace archive reconciliation", () => {
  it("returns explicit replace and merge decisions without mutating either source", async () => {
    const artifact = await completeArchive();
    const archive = await requireValidPortableWorkspaceArchive(artifact.blob);
    const current = workspace("Current", "current-account", false);
    const currentBefore = clone(current);
    const archiveBefore = clone(archive.state);

    const first = preparePortableWorkspaceArchiveImport(
      current,
      archive,
      IMPORTED_AT,
    );
    const second = preparePortableWorkspaceArchiveImport(
      current,
      archive,
      IMPORTED_AT,
    );

    expect(first.requiresChoice).toBe(true);
    expect(first).toMatchObject({
      archiveCreatedAt: ARCHIVED_AT,
      archiveWorkspaceUpdatedAt: CREATED_AT,
      importedEvidenceFiles: 2,
      importedEvidenceBytes: 8,
      replace: {
        kind: "replace",
        currentWorkspacePolicy: "discard",
        currentEvidencePolicy: "replace-all",
        requiresDestructiveConfirmation: true,
      },
      merge: {
        kind: "merge",
        currentWorkspacePolicy: "preserve",
        currentEvidencePolicy: "preserve",
        requiresDestructiveConfirmation: false,
      },
    });
    expect(first.replace.state.updatedAt).toBe(IMPORTED_AT);
    expect(first.replace.state.profile.displayName).toBe("Source person");
    expect(first.replace.evidenceWrites.map((item) => item.targetEvidenceId)).toEqual([
      "source-image",
      "source-proof",
    ]);

    expect(first.merge.state.updatedAt).toBe(IMPORTED_AT);
    expect(first.merge.state.profile.displayName).toBe("Current person");
    expect(first.merge.state.goals.map((goal) => goal.title)).toEqual([
      "Current goal",
      "Source goal",
    ]);
    expect(first.merge.evidenceWrites).toHaveLength(2);
    expect(
      first.merge.evidenceWrites.every(
        (item) =>
          item.targetGoalId !== item.goalId
          && item.targetEvidenceId !== item.evidenceId,
      ),
    ).toBe(true);
    expect(first.merge.remap).toEqual(second.merge.remap);
    expect(
      first.merge.evidenceWrites.map(
        ({ goalId, evidenceId, targetGoalId, targetEvidenceId, sha256 }) => ({
          goalId,
          evidenceId,
          targetGoalId,
          targetEvidenceId,
          sha256,
        }),
      ),
    ).toEqual(
      second.merge.evidenceWrites.map(
        ({ goalId, evidenceId, targetGoalId, targetEvidenceId, sha256 }) => ({
          goalId,
          evidenceId,
          targetGoalId,
          targetEvidenceId,
          sha256,
        }),
      ),
    );
    expect(current).toEqual(currentBefore);
    expect(archive.state).toEqual(archiveBefore);
  });

  it("validates and plans from the binary file in one side-effect-free step", async () => {
    const artifact = await completeArchive();
    const current = workspace("Current", "current-account", false);

    const plan = await inspectAndPreparePortableWorkspaceArchiveImport(
      current,
      artifact.blob,
      IMPORTED_AT,
    );

    expect(plan.replace.evidenceWrites).toHaveLength(2);
    expect(plan.merge.evidenceWrites).toHaveLength(2);
  });
});
