import {
  isAllowedEvidenceMimeType,
  isValidEvidenceFileName,
  isValidEvidenceFileSize,
  normalizeEvidenceMimeType,
} from "@/lib/goal-evidence";
import {
  isEvidenceBlobRecord,
  privacySafeWorkspaceExport,
  type EvidenceBlobRecord,
} from "@/lib/persistence";
import {
  CURRENT_STATE_VERSION,
  MAX_WORKSPACE_SERIALIZED_BYTES,
  parseImportedState,
} from "@/lib/state-schema";
import type {
  AppState,
  GoalFileEvidence,
} from "@/lib/types";
import {
  mergeAnonymousWorkspace,
  workspaceMergeFileEvidenceCopies,
  type WorkspaceMergeIdRemap,
} from "@/lib/workspace-merge";

export const PORTABLE_WORKSPACE_ARCHIVE_FORMAT = "evolvra-portable-workspace";
export const PORTABLE_WORKSPACE_ARCHIVE_VERSION = 1 as const;
export const PORTABLE_WORKSPACE_ARCHIVE_EXTENSION = ".evolvra";
export const PORTABLE_WORKSPACE_ARCHIVE_MIME_TYPE =
  "application/vnd.evolvra.workspace-archive";

export const MAX_PORTABLE_WORKSPACE_ARCHIVE_BYTES = 1024 * 1024 * 1024;
export const MAX_PORTABLE_WORKSPACE_ARCHIVE_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_PORTABLE_WORKSPACE_ARCHIVE_EVIDENCE_FILES = 10_000;

const ARCHIVE_MAGIC: Uint8Array<ArrayBuffer> =
  new TextEncoder().encode("EVOLVRA-WORKSPACE-ARCHIVE\n");
const MANIFEST_LENGTH_BYTES = 4;
const SHA_256_BYTES = 32;
const ARCHIVE_HEADER_BYTES =
  ARCHIVE_MAGIC.byteLength + MANIFEST_LENGTH_BYTES + SHA_256_BYTES;
const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UTF_8_DECODER = new TextDecoder("utf-8", { fatal: true });

type UnknownRecord = Record<string, unknown>;

export type PortableWorkspaceArchiveIssueCode =
  | "archive-too-large"
  | "duplicate-evidence"
  | "evidence-integrity"
  | "evidence-metadata"
  | "evidence-scope"
  | "extra-payload"
  | "invalid-archive"
  | "invalid-manifest"
  | "invalid-workspace"
  | "manifest-integrity"
  | "missing-evidence"
  | "payload-length"
  | "unsupported-version"
  | "workspace-integrity";

export interface PortableWorkspaceArchiveIssue {
  code: PortableWorkspaceArchiveIssueCode;
  message: string;
  key?: string;
}

export class PortableWorkspaceArchiveError extends Error {
  readonly code: PortableWorkspaceArchiveIssueCode;
  readonly issues: readonly PortableWorkspaceArchiveIssue[];

  constructor(issue: PortableWorkspaceArchiveIssue) {
    super(issue.message);
    this.name = "PortableWorkspaceArchiveError";
    this.code = issue.code;
    this.issues = [issue];
  }
}

export interface PortableWorkspaceManifestState {
  encoding: "utf-8-json";
  size: number;
  sha256: string;
}

export interface PortableWorkspaceManifestEvidence {
  key: string;
  goalId: string;
  evidenceId: string;
  name: string;
  mimeType: GoalFileEvidence["mimeType"];
  size: number;
  status: "included" | "missing";
  sha256: string | null;
}

export interface PortableWorkspaceArchiveManifestV1 {
  format: typeof PORTABLE_WORKSPACE_ARCHIVE_FORMAT;
  version: typeof PORTABLE_WORKSPACE_ARCHIVE_VERSION;
  createdAt: string;
  hashAlgorithm: "SHA-256";
  workspace: PortableWorkspaceManifestState;
  evidence: PortableWorkspaceManifestEvidence[];
}

export interface PortableWorkspaceEvidenceKey {
  goalId: string;
  evidenceId: string;
  key: string;
}

export interface PortableWorkspaceArchiveCreationReport {
  complete: boolean;
  includedEvidence: PortableWorkspaceEvidenceKey[];
  missingEvidence: PortableWorkspaceEvidenceKey[];
  orphanedEvidence: PortableWorkspaceEvidenceKey[];
  evidenceBytes: number;
}

export interface PortableWorkspaceArchiveArtifact {
  blob: Blob;
  manifest: PortableWorkspaceArchiveManifestV1;
  report: PortableWorkspaceArchiveCreationReport;
}

export interface CreatePortableWorkspaceArchiveInput {
  state: AppState;
  sourceAccountId: string;
  evidence: readonly EvidenceBlobRecord[];
  createdAt: string;
}

export interface ValidatedPortableWorkspaceEvidence
  extends PortableWorkspaceEvidenceKey {
  name: string;
  mimeType: GoalFileEvidence["mimeType"];
  size: number;
  sha256: string;
  blob: Blob;
}

export interface ValidatedPortableWorkspaceArchive {
  blob: Blob;
  manifest: PortableWorkspaceArchiveManifestV1;
  state: AppState;
  evidence: ValidatedPortableWorkspaceEvidence[];
}

export type PortableWorkspaceArchiveInspection =
  | {
      status: "valid";
      issues: [];
      content: ValidatedPortableWorkspaceArchive;
    }
  | {
      status: "incomplete";
      issues: PortableWorkspaceArchiveIssue[];
      content: ValidatedPortableWorkspaceArchive;
    }
  | {
      status: "invalid";
      issues: PortableWorkspaceArchiveIssue[];
      content?: undefined;
    };

export interface PortableWorkspaceEvidenceWrite
  extends PortableWorkspaceEvidenceKey {
  targetGoalId: string;
  targetEvidenceId: string;
  name: string;
  mimeType: GoalFileEvidence["mimeType"];
  size: number;
  sha256: string;
  blob: Blob;
}

export interface PortableWorkspaceReplaceDecision {
  kind: "replace";
  state: AppState;
  evidenceWrites: PortableWorkspaceEvidenceWrite[];
  currentWorkspacePolicy: "discard";
  currentEvidencePolicy: "replace-all";
  requiresDestructiveConfirmation: true;
}

export interface PortableWorkspaceMergeDecision {
  kind: "merge";
  state: AppState;
  evidenceWrites: PortableWorkspaceEvidenceWrite[];
  remap: WorkspaceMergeIdRemap;
  currentWorkspacePolicy: "preserve";
  currentEvidencePolicy: "preserve";
  requiresDestructiveConfirmation: false;
}

export interface PortableWorkspaceArchiveImportPlan {
  requiresChoice: true;
  archiveCreatedAt: string;
  archiveWorkspaceUpdatedAt: string;
  importedEvidenceFiles: number;
  importedEvidenceBytes: number;
  replace: PortableWorkspaceReplaceDecision;
  merge: PortableWorkspaceMergeDecision;
}

class ArchiveValidationFailure extends Error {
  readonly issue: PortableWorkspaceArchiveIssue;

  constructor(issue: PortableWorkspaceArchiveIssue) {
    super(issue.message);
    this.name = "ArchiveValidationFailure";
    this.issue = issue;
  }
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const lexicalCompare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const cloneJson = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(lexicalCompare);
  const rightKeys = Object.keys(right).sort(lexicalCompare);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
};

function fail(
  code: PortableWorkspaceArchiveIssueCode,
  message: string,
  key?: string,
): never {
  throw new ArchiveValidationFailure({
    code,
    message,
    ...(key ? { key } : {}),
  });
}

function requireExactKeys(
  value: UnknownRecord,
  keys: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort(lexicalCompare);
  const expected = [...keys].sort(lexicalCompare);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    fail("invalid-manifest", `${label} contains missing or unsupported fields.`);
  }
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail("invalid-manifest", `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function requireSafeByteCount(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    fail("invalid-manifest", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_256_HEX_PATTERN.test(value)) {
    fail("invalid-manifest", `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireCanonicalJsonValue(value: unknown, path = "value"): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => requireCanonicalJsonValue(item, `${path}[${index}]`))
      .join(",")}]`;
  }
  if (isRecord(value)) {
    const fields = Object.keys(value)
      .sort(lexicalCompare)
      .map((key) => {
        const item = value[key];
        if (item === undefined) {
          throw new TypeError(`${path}.${key} is undefined.`);
        }
        return `${JSON.stringify(key)}:${requireCanonicalJsonValue(item, `${path}.${key}`)}`;
      });
    return `{${fields.join(",")}}`;
  }
  throw new TypeError(`${path} is not JSON-compatible.`);
}

function canonicalJsonBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(requireCanonicalJsonValue(value));
}

function cryptoSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Secure browser hashing is unavailable. The workspace archive was not created or trusted.",
    );
  }
  return subtle;
}

async function sha256Bytes(
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await cryptoSubtle().digest("SHA-256", bytes));
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<string> {
  return hexFromBytes(await sha256Bytes(bytes));
}

async function sha256Blob(blob: Blob): Promise<string> {
  return sha256Hex(await blob.arrayBuffer());
}

function evidenceArchiveKey(goalId: string, evidenceId: string): string {
  return `evidence/${encodeURIComponent(goalId)}/${encodeURIComponent(evidenceId)}`;
}

function workspaceFileEvidence(
  state: AppState,
): Array<{ goalId: string; evidence: GoalFileEvidence; key: string }> {
  return state.goals
    .flatMap((goal) =>
      goal.evidence
        .filter((item): item is GoalFileEvidence => item.type === "file")
        .map((evidence) => ({
          goalId: goal.id,
          evidence,
          key: evidenceArchiveKey(goal.id, evidence.id),
        })))
    .sort((left, right) => lexicalCompare(left.key, right.key));
}

function normalizedArchiveBlob(
  record: EvidenceBlobRecord,
  metadata: GoalFileEvidence,
): Blob {
  const mimeType = normalizeEvidenceMimeType(record.blob.type);
  if (
    mimeType !== metadata.mimeType
    || record.blob.size !== metadata.size
    || !isAllowedEvidenceMimeType(mimeType)
    || !isValidEvidenceFileSize(record.blob.size)
  ) {
    throw new PortableWorkspaceArchiveError({
      code: "evidence-metadata",
      key: evidenceArchiveKey(record.goalId, record.evidenceId),
      message:
        "Stored evidence bytes do not match the workspace file size or MIME metadata.",
    });
  }
  return record.blob.type === mimeType
    ? record.blob
    : record.blob.slice(0, record.blob.size, mimeType);
}

function requireCreationTimestamp(value: string): string {
  try {
    return requireIsoTimestamp(value, "Archive creation time");
  } catch (error) {
    if (error instanceof ArchiveValidationFailure) {
      throw new PortableWorkspaceArchiveError(error.issue);
    }
    throw error;
  }
}

function requirePortableWorkspaceState(
  value: unknown,
  migrationTimestamp: string,
): AppState {
  let state: AppState;
  try {
    state = parseImportedState(value, migrationTimestamp);
  } catch (error) {
    throw new PortableWorkspaceArchiveError({
      code: "invalid-workspace",
      message:
        error instanceof Error
          ? `The workspace cannot be archived: ${error.message}`
          : "The workspace cannot be archived because it is invalid.",
    });
  }
  if (state.version !== CURRENT_STATE_VERSION) {
    throw new PortableWorkspaceArchiveError({
      code: "invalid-workspace",
      message: `Workspace archives require state version ${CURRENT_STATE_VERSION}.`,
    });
  }
  return privacySafeWorkspaceExport(state);
}

function headerBytes(
  manifestLength: number,
  manifestDigest: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(ARCHIVE_HEADER_BYTES);
  header.set(ARCHIVE_MAGIC, 0);
  new DataView(header.buffer).setUint32(
    ARCHIVE_MAGIC.byteLength,
    manifestLength,
    false,
  );
  header.set(
    manifestDigest,
    ARCHIVE_MAGIC.byteLength + MANIFEST_LENGTH_BYTES,
  );
  return header;
}

function portableKey(
  goalId: string,
  evidenceId: string,
): PortableWorkspaceEvidenceKey {
  return {
    goalId,
    evidenceId,
    key: evidenceArchiveKey(goalId, evidenceId),
  };
}

/**
 * Builds a deterministic binary archive from one validated workspace snapshot
 * and the exact account-fenced evidence records supplied by the caller.
 *
 * Missing referenced bytes remain explicit in the checksummed manifest. Orphaned
 * records are reported and excluded. Duplicate or cross-account records are
 * rejected rather than guessed at.
 */
export async function createPortableWorkspaceArchive(
  input: CreatePortableWorkspaceArchiveInput,
): Promise<PortableWorkspaceArchiveArtifact> {
  const createdAt = requireCreationTimestamp(input.createdAt);
  const portableState = requirePortableWorkspaceState(input.state, createdAt);
  const expectedFiles = workspaceFileEvidence(portableState);
  if (expectedFiles.length > MAX_PORTABLE_WORKSPACE_ARCHIVE_EVIDENCE_FILES) {
    throw new PortableWorkspaceArchiveError({
      code: "archive-too-large",
      message: `A portable archive can contain at most ${MAX_PORTABLE_WORKSPACE_ARCHIVE_EVIDENCE_FILES} evidence files.`,
    });
  }

  const sourceByKey = new Map<string, EvidenceBlobRecord>();
  for (const record of input.evidence) {
    if (!isEvidenceBlobRecord(record)) {
      throw new PortableWorkspaceArchiveError({
        code: "evidence-metadata",
        message: "One or more supplied evidence records are invalid.",
      });
    }
    const key = evidenceArchiveKey(record.goalId, record.evidenceId);
    if (record.accountId !== input.sourceAccountId) {
      throw new PortableWorkspaceArchiveError({
        code: "evidence-scope",
        key,
        message:
          "Evidence from another workspace account was refused before archive creation.",
      });
    }
    if (sourceByKey.has(key)) {
      throw new PortableWorkspaceArchiveError({
        code: "duplicate-evidence",
        key,
        message: "The same evidence record was supplied more than once.",
      });
    }
    sourceByKey.set(key, record);
  }

  const workspaceBytes = canonicalJsonBytes(portableState);
  const workspaceDigest = await sha256Hex(workspaceBytes);
  const payloadBlobs: Blob[] = [];
  const evidence: PortableWorkspaceManifestEvidence[] = [];
  const includedEvidence: PortableWorkspaceEvidenceKey[] = [];
  const missingEvidence: PortableWorkspaceEvidenceKey[] = [];
  let evidenceBytes = 0;

  for (const expected of expectedFiles) {
    const source = sourceByKey.get(expected.key);
    sourceByKey.delete(expected.key);
    if (!source) {
      evidence.push({
        key: expected.key,
        goalId: expected.goalId,
        evidenceId: expected.evidence.id,
        name: expected.evidence.name,
        mimeType: expected.evidence.mimeType,
        size: expected.evidence.size,
        status: "missing",
        sha256: null,
      });
      missingEvidence.push(
        portableKey(expected.goalId, expected.evidence.id),
      );
      continue;
    }

    const blob = normalizedArchiveBlob(source, expected.evidence);
    const digest = await sha256Blob(blob);
    evidence.push({
      key: expected.key,
      goalId: expected.goalId,
      evidenceId: expected.evidence.id,
      name: expected.evidence.name,
      mimeType: expected.evidence.mimeType,
      size: expected.evidence.size,
      status: "included",
      sha256: digest,
    });
    payloadBlobs.push(blob);
    includedEvidence.push(
      portableKey(expected.goalId, expected.evidence.id),
    );
    evidenceBytes += blob.size;
  }

  const orphanedEvidence = [...sourceByKey.values()]
    .map((record) => portableKey(record.goalId, record.evidenceId))
    .sort((left, right) => lexicalCompare(left.key, right.key));
  const manifest: PortableWorkspaceArchiveManifestV1 = {
    format: PORTABLE_WORKSPACE_ARCHIVE_FORMAT,
    version: PORTABLE_WORKSPACE_ARCHIVE_VERSION,
    createdAt,
    hashAlgorithm: "SHA-256",
    workspace: {
      encoding: "utf-8-json",
      size: workspaceBytes.byteLength,
      sha256: workspaceDigest,
    },
    evidence,
  };
  const manifestBytes = canonicalJsonBytes(manifest);
  if (manifestBytes.byteLength > MAX_PORTABLE_WORKSPACE_ARCHIVE_MANIFEST_BYTES) {
    throw new PortableWorkspaceArchiveError({
      code: "archive-too-large",
      message: "The portable archive manifest is larger than the supported limit.",
    });
  }
  const totalBytes =
    ARCHIVE_HEADER_BYTES
    + manifestBytes.byteLength
    + workspaceBytes.byteLength
    + evidenceBytes;
  if (totalBytes > MAX_PORTABLE_WORKSPACE_ARCHIVE_BYTES) {
    throw new PortableWorkspaceArchiveError({
      code: "archive-too-large",
      message: "The portable archive is larger than the supported 1 GiB limit.",
    });
  }

  const manifestDigest = await sha256Bytes(manifestBytes);
  return {
    blob: new Blob(
      [
        headerBytes(manifestBytes.byteLength, manifestDigest),
        manifestBytes,
        workspaceBytes,
        ...payloadBlobs,
      ],
      { type: PORTABLE_WORKSPACE_ARCHIVE_MIME_TYPE },
    ),
    manifest,
    report: {
      complete: missingEvidence.length === 0,
      includedEvidence,
      missingEvidence,
      orphanedEvidence,
      evidenceBytes,
    },
  };
}

function toArchiveBlob(input: Blob | ArrayBuffer | Uint8Array): Blob {
  if (input instanceof Blob) return input;
  if (input instanceof Uint8Array) {
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    return new Blob([copy]);
  }
  return new Blob([input]);
}

function parseManifestEvidence(
  value: unknown,
  index: number,
): PortableWorkspaceManifestEvidence {
  if (!isRecord(value)) {
    fail("invalid-manifest", `Evidence manifest entry ${index} is not an object.`);
  }
  requireExactKeys(
    value,
    [
      "key",
      "goalId",
      "evidenceId",
      "name",
      "mimeType",
      "size",
      "status",
      "sha256",
    ],
    `Evidence manifest entry ${index}`,
  );
  if (
    typeof value.goalId !== "string"
    || !value.goalId
    || value.goalId !== value.goalId.trim()
    || typeof value.evidenceId !== "string"
    || !value.evidenceId
    || value.evidenceId !== value.evidenceId.trim()
  ) {
    fail("invalid-manifest", `Evidence manifest entry ${index} has invalid identifiers.`);
  }
  const expectedKey = evidenceArchiveKey(value.goalId, value.evidenceId);
  if (value.key !== expectedKey) {
    fail(
      "invalid-manifest",
      `Evidence manifest entry ${index} has a non-canonical key.`,
      expectedKey,
    );
  }
  if (!isValidEvidenceFileName(value.name)) {
    fail("invalid-manifest", `Evidence manifest entry ${index} has an invalid file name.`);
  }
  if (!isAllowedEvidenceMimeType(value.mimeType)) {
    fail("invalid-manifest", `Evidence manifest entry ${index} has an unsupported MIME type.`);
  }
  if (!isValidEvidenceFileSize(value.size)) {
    fail("invalid-manifest", `Evidence manifest entry ${index} has an invalid file size.`);
  }
  if (value.status !== "included" && value.status !== "missing") {
    fail("invalid-manifest", `Evidence manifest entry ${index} has an invalid status.`);
  }
  if (value.status === "included") {
    requireSha256(value.sha256, `Evidence manifest entry ${index} digest`);
  } else if (value.sha256 !== null) {
    fail(
      "invalid-manifest",
      `Missing evidence manifest entry ${index} must not claim a digest.`,
    );
  }
  return {
    key: expectedKey,
    goalId: value.goalId,
    evidenceId: value.evidenceId,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    status: value.status,
    sha256: value.sha256 as string | null,
  };
}

function parseArchiveManifest(value: unknown): PortableWorkspaceArchiveManifestV1 {
  if (!isRecord(value)) {
    fail("invalid-manifest", "The portable archive manifest is not an object.");
  }
  requireExactKeys(
    value,
    [
      "format",
      "version",
      "createdAt",
      "hashAlgorithm",
      "workspace",
      "evidence",
    ],
    "The portable archive manifest",
  );
  if (value.format !== PORTABLE_WORKSPACE_ARCHIVE_FORMAT) {
    fail("invalid-manifest", "This file is not an Evolvra portable workspace archive.");
  }
  if (value.version !== PORTABLE_WORKSPACE_ARCHIVE_VERSION) {
    fail(
      "unsupported-version",
      `Archive version ${String(value.version)} is not supported by this app.`,
    );
  }
  if (value.hashAlgorithm !== "SHA-256") {
    fail("invalid-manifest", "The archive uses an unsupported integrity algorithm.");
  }
  const createdAt = requireIsoTimestamp(value.createdAt, "Archive creation time");
  if (!isRecord(value.workspace)) {
    fail("invalid-manifest", "The workspace manifest entry is not an object.");
  }
  requireExactKeys(
    value.workspace,
    ["encoding", "size", "sha256"],
    "The workspace manifest entry",
  );
  if (value.workspace.encoding !== "utf-8-json") {
    fail("invalid-manifest", "The workspace payload encoding is unsupported.");
  }
  const workspaceSize = requireSafeByteCount(
    value.workspace.size,
    "Workspace payload size",
  );
  if (workspaceSize > MAX_WORKSPACE_SERIALIZED_BYTES) {
    fail(
      "archive-too-large",
      "The archived workspace exceeds the supported serialized workspace limit.",
    );
  }
  const workspaceSha256 = requireSha256(
    value.workspace.sha256,
    "Workspace payload digest",
  );
  if (!Array.isArray(value.evidence)) {
    fail("invalid-manifest", "The evidence manifest must be an array.");
  }
  if (value.evidence.length > MAX_PORTABLE_WORKSPACE_ARCHIVE_EVIDENCE_FILES) {
    fail(
      "archive-too-large",
      `The archive contains more than ${MAX_PORTABLE_WORKSPACE_ARCHIVE_EVIDENCE_FILES} evidence entries.`,
    );
  }
  const evidence = value.evidence.map(parseManifestEvidence);
  const seen = new Set<string>();
  for (let index = 0; index < evidence.length; index += 1) {
    const item = evidence[index];
    if (seen.has(item.key)) {
      fail(
        "duplicate-evidence",
        "The evidence manifest contains a duplicate file reference.",
        item.key,
      );
    }
    seen.add(item.key);
    if (index > 0 && lexicalCompare(evidence[index - 1].key, item.key) >= 0) {
      fail(
        "invalid-manifest",
        "The evidence manifest is not in deterministic key order.",
        item.key,
      );
    }
  }
  return {
    format: PORTABLE_WORKSPACE_ARCHIVE_FORMAT,
    version: PORTABLE_WORKSPACE_ARCHIVE_VERSION,
    createdAt,
    hashAlgorithm: "SHA-256",
    workspace: {
      encoding: "utf-8-json",
      size: workspaceSize,
      sha256: workspaceSha256,
    },
    evidence,
  };
}

function parsePortableWorkspacePayload(
  value: unknown,
): AppState {
  let state: AppState;
  try {
    state = parseImportedState(value);
  } catch (error) {
    fail(
      "invalid-workspace",
      error instanceof Error
        ? `The archived workspace is invalid: ${error.message}`
        : "The archived workspace is invalid.",
    );
  }
  if (state.version !== CURRENT_STATE_VERSION) {
    fail(
      "invalid-workspace",
      `The archived workspace must use state version ${CURRENT_STATE_VERSION}.`,
    );
  }
  if (!jsonValuesEqual(state, value)) {
    fail(
      "invalid-workspace",
      "The archived workspace is not a canonical current-version snapshot.",
    );
  }
  const privacySafe = privacySafeWorkspaceExport(state);
  if (!jsonValuesEqual(state, privacySafe)) {
    fail(
      "invalid-workspace",
      "The archived workspace contains account-bound evidence paths.",
    );
  }
  return state;
}

function evidenceMetadataEqual(
  manifest: PortableWorkspaceManifestEvidence,
  goalId: string,
  evidence: GoalFileEvidence,
) {
  return manifest.goalId === goalId
    && manifest.evidenceId === evidence.id
    && manifest.name === evidence.name
    && manifest.mimeType === evidence.mimeType
    && manifest.size === evidence.size;
}

/**
 * Verifies the envelope, canonical manifest, workspace, and every included
 * evidence segment before exposing restore data. The function never mutates
 * persistence and never treats an incomplete archive as valid.
 */
export async function inspectPortableWorkspaceArchive(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<PortableWorkspaceArchiveInspection> {
  try {
    const blob = toArchiveBlob(input);
    if (
      blob.size < ARCHIVE_HEADER_BYTES
      || blob.size > MAX_PORTABLE_WORKSPACE_ARCHIVE_BYTES
    ) {
      fail(
        "archive-too-large",
        blob.size < ARCHIVE_HEADER_BYTES
          ? "The selected archive is truncated."
          : "The selected archive exceeds the supported 1 GiB limit.",
      );
    }

    const header = new Uint8Array(
      await blob.slice(0, ARCHIVE_HEADER_BYTES).arrayBuffer(),
    );
    for (let index = 0; index < ARCHIVE_MAGIC.byteLength; index += 1) {
      if (header[index] !== ARCHIVE_MAGIC[index]) {
        fail("invalid-archive", "The selected file is not an Evolvra workspace archive.");
      }
    }
    const manifestLength = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    ).getUint32(ARCHIVE_MAGIC.byteLength, false);
    if (
      manifestLength === 0
      || manifestLength > MAX_PORTABLE_WORKSPACE_ARCHIVE_MANIFEST_BYTES
      || ARCHIVE_HEADER_BYTES + manifestLength > blob.size
    ) {
      fail("invalid-manifest", "The archive manifest length is invalid.");
    }

    const expectedManifestDigest = header.slice(
      ARCHIVE_MAGIC.byteLength + MANIFEST_LENGTH_BYTES,
      ARCHIVE_HEADER_BYTES,
    );
    const manifestBytes = new Uint8Array(
      await blob
        .slice(ARCHIVE_HEADER_BYTES, ARCHIVE_HEADER_BYTES + manifestLength)
        .arrayBuffer(),
    );
    const actualManifestDigest = await sha256Bytes(manifestBytes);
    if (hexFromBytes(actualManifestDigest) !== hexFromBytes(expectedManifestDigest)) {
      fail("manifest-integrity", "The archive manifest failed its integrity check.");
    }

    let manifestValue: unknown;
    let manifestText: string;
    try {
      manifestText = UTF_8_DECODER.decode(manifestBytes);
      manifestValue = JSON.parse(manifestText) as unknown;
    } catch {
      fail("invalid-manifest", "The archive manifest is not valid UTF-8 JSON.");
    }
    const manifest = parseArchiveManifest(manifestValue);
    if (requireCanonicalJsonValue(manifest) !== manifestText) {
      fail(
        "invalid-manifest",
        "The archive manifest is not canonical or contains duplicate fields.",
      );
    }

    const includedBytes = manifest.evidence.reduce(
      (sum, item) => sum + (item.status === "included" ? item.size : 0),
      0,
    );
    const expectedArchiveSize =
      ARCHIVE_HEADER_BYTES
      + manifestLength
      + manifest.workspace.size
      + includedBytes;
    if (expectedArchiveSize !== blob.size) {
      fail(
        expectedArchiveSize < blob.size ? "extra-payload" : "payload-length",
        expectedArchiveSize < blob.size
          ? "The archive contains bytes not declared by its checksummed manifest."
          : "The archive is missing bytes declared by its checksummed manifest.",
      );
    }

    let offset = ARCHIVE_HEADER_BYTES + manifestLength;
    const workspaceBlob = blob.slice(
      offset,
      offset + manifest.workspace.size,
      "application/json",
    );
    offset += manifest.workspace.size;
    if (await sha256Blob(workspaceBlob) !== manifest.workspace.sha256) {
      fail("workspace-integrity", "The archived workspace failed its integrity check.");
    }
    let workspaceText: string;
    let workspaceValue: unknown;
    try {
      workspaceText = UTF_8_DECODER.decode(await workspaceBlob.arrayBuffer());
      workspaceValue = JSON.parse(workspaceText) as unknown;
    } catch {
      fail("invalid-workspace", "The archived workspace is not valid UTF-8 JSON.");
    }
    const state = parsePortableWorkspacePayload(workspaceValue);
    if (requireCanonicalJsonValue(state) !== workspaceText) {
      fail(
        "invalid-workspace",
        "The archived workspace payload is not deterministic canonical JSON.",
      );
    }

    const expectedEvidence = workspaceFileEvidence(state);
    const expectedByKey = new Map(
      expectedEvidence.map((item) => [item.key, item]),
    );
    const manifestByKey = new Map(
      manifest.evidence.map((item) => [item.key, item]),
    );
    for (const expected of expectedEvidence) {
      const item = manifestByKey.get(expected.key);
      if (!item) {
        fail(
          "missing-evidence",
          "A workspace file reference has no evidence manifest entry.",
          expected.key,
        );
      }
      if (!evidenceMetadataEqual(item, expected.goalId, expected.evidence)) {
        fail(
          "evidence-metadata",
          "Evidence manifest metadata does not match the workspace reference.",
          expected.key,
        );
      }
    }
    for (const item of manifest.evidence) {
      if (!expectedByKey.has(item.key)) {
        fail(
          "evidence-metadata",
          "The evidence manifest contains a file not referenced by the workspace.",
          item.key,
        );
      }
    }

    const evidence: ValidatedPortableWorkspaceEvidence[] = [];
    const issues: PortableWorkspaceArchiveIssue[] = [];
    for (const item of manifest.evidence) {
      if (item.status === "missing") {
        issues.push({
          code: "missing-evidence",
          key: item.key,
          message: `The archive does not contain bytes for "${item.name}".`,
        });
        continue;
      }
      const evidenceBlob = blob.slice(
        offset,
        offset + item.size,
        item.mimeType,
      );
      offset += item.size;
      if (await sha256Blob(evidenceBlob) !== item.sha256) {
        fail(
          "evidence-integrity",
          `Evidence file "${item.name}" failed its integrity check.`,
          item.key,
        );
      }
      evidence.push({
        key: item.key,
        goalId: item.goalId,
        evidenceId: item.evidenceId,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        sha256: item.sha256,
        blob: evidenceBlob,
      });
    }

    const content: ValidatedPortableWorkspaceArchive = {
      blob,
      manifest,
      state,
      evidence,
    };
    return issues.length
      ? { status: "incomplete", issues, content }
      : { status: "valid", issues: [], content };
  } catch (error) {
    if (error instanceof ArchiveValidationFailure) {
      return { status: "invalid", issues: [error.issue] };
    }
    return {
      status: "invalid",
      issues: [{
        code: "invalid-archive",
        message:
          error instanceof Error
            ? `The archive could not be verified: ${error.message}`
            : "The archive could not be verified.",
      }],
    };
  }
}

export async function requireValidPortableWorkspaceArchive(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<ValidatedPortableWorkspaceArchive> {
  const inspection = await inspectPortableWorkspaceArchive(input);
  if (inspection.status !== "valid") {
    throw new PortableWorkspaceArchiveError(
      inspection.issues[0] ?? {
        code: "invalid-archive",
        message: "The archive could not be verified.",
      },
    );
  }
  return inspection.content;
}

function requirePlanTimestamp(value: string): string {
  try {
    return requireIsoTimestamp(value, "Import time");
  } catch (error) {
    if (error instanceof ArchiveValidationFailure) {
      throw new PortableWorkspaceArchiveError(error.issue);
    }
    throw error;
  }
}

function validatedCurrentState(state: AppState): AppState {
  try {
    const parsed = parseImportedState(state);
    if (!jsonValuesEqual(state, parsed)) {
      throw new Error("The current workspace is not canonical.");
    }
    return parsed;
  } catch (error) {
    throw new PortableWorkspaceArchiveError({
      code: "invalid-workspace",
      message:
        error instanceof Error
          ? `The current workspace cannot be reconciled: ${error.message}`
          : "The current workspace cannot be reconciled.",
    });
  }
}

function archiveEvidenceByKey(
  content: ValidatedPortableWorkspaceArchive,
): Map<string, ValidatedPortableWorkspaceEvidence> {
  return new Map(content.evidence.map((item) => [item.key, item]));
}

/**
 * Produces both explicit restore choices without writing anything. The caller
 * must present the choice, then execute the selected state/evidence transition
 * under the provider's account and generation fences.
 */
export function preparePortableWorkspaceArchiveImport(
  currentSource: AppState,
  archive: ValidatedPortableWorkspaceArchive,
  importedAt: string,
): PortableWorkspaceArchiveImportPlan {
  const timestamp = requirePlanTimestamp(importedAt);
  const current = validatedCurrentState(currentSource);
  const replacementState = {
    ...cloneJson(archive.state),
    updatedAt: timestamp,
  };
  parseImportedState(replacementState, timestamp);
  const evidenceByKey = archiveEvidenceByKey(archive);
  const replacementWrites = workspaceFileEvidence(archive.state).map((item) => {
    const source = evidenceByKey.get(item.key);
    if (!source) {
      throw new PortableWorkspaceArchiveError({
        code: "missing-evidence",
        key: item.key,
        message: "A validated archive evidence payload is unexpectedly missing.",
      });
    }
    return {
      ...portableKey(item.goalId, item.evidence.id),
      targetGoalId: item.goalId,
      targetEvidenceId: item.evidence.id,
      name: source.name,
      mimeType: source.mimeType,
      size: source.size,
      sha256: source.sha256,
      blob: source.blob,
    };
  });

  const merged = mergeAnonymousWorkspace(current, archive.state, timestamp);
  const mergeCopies = workspaceMergeFileEvidenceCopies(archive.state, merged);
  const mergeWrites = mergeCopies.map((copy) => {
    const key = evidenceArchiveKey(
      copy.sourceGoalId,
      copy.sourceEvidenceId,
    );
    const source = evidenceByKey.get(key);
    if (!source) {
      throw new PortableWorkspaceArchiveError({
        code: "missing-evidence",
        key,
        message: "A validated archive evidence payload is unexpectedly missing.",
      });
    }
    return {
      ...portableKey(copy.sourceGoalId, copy.sourceEvidenceId),
      targetGoalId: copy.mergedGoalId,
      targetEvidenceId: copy.mergedEvidenceId,
      name: source.name,
      mimeType: source.mimeType,
      size: source.size,
      sha256: source.sha256,
      blob: source.blob,
    };
  });
  const importedEvidenceBytes = archive.evidence.reduce(
    (sum, item) => sum + item.size,
    0,
  );

  return {
    requiresChoice: true,
    archiveCreatedAt: archive.manifest.createdAt,
    archiveWorkspaceUpdatedAt: archive.state.updatedAt,
    importedEvidenceFiles: archive.evidence.length,
    importedEvidenceBytes,
    replace: {
      kind: "replace",
      state: replacementState,
      evidenceWrites: replacementWrites,
      currentWorkspacePolicy: "discard",
      currentEvidencePolicy: "replace-all",
      requiresDestructiveConfirmation: true,
    },
    merge: {
      kind: "merge",
      state: merged.state,
      evidenceWrites: mergeWrites,
      remap: merged.remap,
      currentWorkspacePolicy: "preserve",
      currentEvidencePolicy: "preserve",
      requiresDestructiveConfirmation: false,
    },
  };
}

export async function inspectAndPreparePortableWorkspaceArchiveImport(
  currentState: AppState,
  input: Blob | ArrayBuffer | Uint8Array,
  importedAt: string,
): Promise<PortableWorkspaceArchiveImportPlan> {
  const archive = await requireValidPortableWorkspaceArchive(input);
  return preparePortableWorkspaceArchiveImport(
    currentState,
    archive,
    importedAt,
  );
}
