import type {
  GoalEvidence,
  GoalFileEvidence,
  GoalLinkEvidence,
  GoalNoteEvidence,
} from "@/lib/types";

export const MAX_GOAL_EVIDENCE_ITEMS = 100;
export const MAX_EVIDENCE_NOTE_LENGTH = 2_000;
export const MAX_EVIDENCE_URL_LENGTH = 2_048;
export const MAX_EVIDENCE_FILE_NAME_LENGTH = 255;
export const MAX_EVIDENCE_FILE_SIZE = 10_485_760;
export const MAX_REMOTE_EVIDENCE_PATH_LENGTH = 1_024;

export const ALLOWED_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,199}$/i;

type UnknownRecord = Record<string, unknown>;

export interface MigrationFileEvidence extends GoalFileEvidence {
  /** Only present between legacy decode and externalizeEmbeddedEvidence. */
  migrationDataUrl: string;
}

export type LegacyEvidenceDecodeResult =
  | { status: "valid"; evidence: GoalEvidence }
  | { status: "invalid"; reason: string };

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isUuidCompatibleId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** New evidence ids are UUIDs; safe legacy ids remain stable to avoid stranding blobs. */
export function isStableEvidenceId(value: unknown): value is string {
  return typeof value === "string" && (UUID_PATTERN.test(value) || LEGACY_ID_PATTERN.test(value));
}

/** Deterministic UUIDv5-shaped identifier for records that predate UUID ids. */
export function stableEvidenceId(seed: string): string {
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex += 1) {
      hashes[hashIndex] ^= code + hashIndex * 97;
      hashes[hashIndex] = Math.imul(hashes[hashIndex], 0x01000193) >>> 0;
    }
  }
  const hex = hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function isAllowedEvidenceMimeType(value: unknown): value is (typeof ALLOWED_EVIDENCE_MIME_TYPES)[number] {
  return typeof value === "string"
    && ALLOWED_EVIDENCE_MIME_TYPES.includes(value as (typeof ALLOWED_EVIDENCE_MIME_TYPES)[number]);
}

export function normalizeEvidenceMimeType(value: unknown) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

export function normalizedEvidenceBlob(
  blob: Blob,
  metadata: Pick<GoalFileEvidence, "mimeType" | "size">,
): Blob | null {
  const mimeType = normalizeEvidenceMimeType(blob.type);
  if (
    !isAllowedEvidenceMimeType(mimeType)
    || mimeType !== metadata.mimeType
    || blob.size !== metadata.size
    || !isValidEvidenceFileSize(blob.size)
  ) return null;
  return blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType);
}

/** Exact byte-and-type comparison for immutable Storage-object adoption. */
export async function evidenceBlobsEqual(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size || left.type !== right.type) return false;
  const [leftBuffer, rightBuffer] = await Promise.all([
    left.arrayBuffer(),
    right.arrayBuffer(),
  ]);
  const leftBytes = new Uint8Array(leftBuffer);
  const rightBytes = new Uint8Array(rightBuffer);
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

export function isValidEvidenceFileSize(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_EVIDENCE_FILE_SIZE;
}

export function isValidEvidenceFileName(value: unknown): value is string {
  return typeof value === "string"
    && Boolean(value.trim())
    && value === value.trim()
    && value.length <= MAX_EVIDENCE_FILE_NAME_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isValidEvidenceUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_EVIDENCE_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function safeDecodedPathSegment(segment: string) {
  if (!segment || segment === "." || segment === ".." || segment.includes("\\")) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded !== "."
      && decoded !== ".."
      && !decoded.includes("/")
      && !decoded.includes("\\")
      && !/[\u0000-\u001f\u007f]/.test(decoded);
  } catch {
    return false;
  }
}

export function isStructurallyValidRemoteEvidencePath(
  path: unknown,
  evidenceId: string,
  goalId?: string,
): path is string {
  if (typeof path !== "string" || !path || path.length > MAX_REMOTE_EVIDENCE_PATH_LENGTH) return false;
  const parts = path.split("/");
  return parts.length === 4
    && parts[2] === evidenceId
    && (goalId === undefined || parts[1] === goalId)
    && parts.every(safeDecodedPathSegment)
    && parts[3].length <= 120;
}

function dataUrlMetadata(dataUrl: string): { mimeType: string; size: number } | null {
  if (!dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma <= 5) return null;
  const metadata = dataUrl.slice(5, comma).split(";");
  const mimeType = metadata[0].toLowerCase();
  if (!isAllowedEvidenceMimeType(mimeType)) return null;
  const isBase64 = metadata.includes("base64");
  if (metadata.some((part, index) => index > 0 && part !== "base64" && !part.startsWith("charset="))) return null;
  const payload = dataUrl.slice(comma + 1);
  let size: number;
  if (isBase64) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) return null;
    size = (payload.length / 4) * 3
      - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  } else {
    try {
      size = new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
    } catch {
      return null;
    }
  }
  return isValidEvidenceFileSize(size) ? { mimeType, size } : null;
}

/**
 * Decodes a previously validated legacy data URL without a network request.
 * `fetch(data:)` is intentionally avoided because production CSP correctly
 * excludes the data scheme from connect-src.
 */
export function migrationDataUrlBlob(
  dataUrl: string,
  expected: Pick<GoalFileEvidence, "mimeType" | "size">,
): Blob | null {
  const metadata = dataUrlMetadata(dataUrl);
  if (!metadata || metadata.mimeType !== expected.mimeType || metadata.size !== expected.size) return null;
  const comma = dataUrl.indexOf(",");
  const descriptor = dataUrl.slice(5, comma).split(";");
  const payload = dataUrl.slice(comma + 1);
  try {
    let bytes: Uint8Array;
    if (descriptor.includes("base64")) {
      const decoded = globalThis.atob(payload);
      bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return normalizedEvidenceBlob(
      new Blob([buffer], { type: metadata.mimeType }),
      expected,
    );
  } catch {
    return null;
  }
}

function decodeLegacyEmbeddedFile(value: string, goalId: string, index: number): LegacyEvidenceDecodeResult | null {
  const dataMarker = value.indexOf("|data:", 5);
  if (!value.startsWith("file|") || dataMarker <= 5) return null;
  const rawName = value.slice(5, dataMarker);
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    name = rawName;
  }
  name = name.trim();
  if (!isValidEvidenceFileName(name)) return { status: "invalid", reason: "legacy file name is invalid" };
  const migrationDataUrl = value.slice(dataMarker + 1);
  const metadata = dataUrlMetadata(migrationDataUrl);
  if (!metadata) return { status: "invalid", reason: "legacy embedded file payload is malformed, unsupported, or too large" };
  const evidence: MigrationFileEvidence = {
    id: stableEvidenceId(`${goalId}\u0000${index}\u0000${value}`),
    type: "file",
    name,
    mimeType: metadata.mimeType,
    size: metadata.size,
    migrationDataUrl,
  };
  return { status: "valid", evidence };
}

function decodeLegacyPipeFile(value: string, goalId: string, index: number): LegacyEvidenceDecodeResult | null {
  if (!value.startsWith("file|")) return null;
  const parts = value.split("|");
  if (parts.length !== 6) return { status: "invalid", reason: "legacy file reference must contain six fields" };
  let decoded: string[];
  try {
    decoded = parts.map((part) => decodeURIComponent(part));
  } catch {
    return { status: "invalid", reason: "legacy file reference contains invalid encoding" };
  }
  const [kind, legacyId, name, mimeType, rawSize, remotePath] = decoded;
  if (kind !== "file") return { status: "invalid", reason: "legacy file reference type is invalid" };
  if (!/^(?:0|[1-9]\d*)$/.test(rawSize)) {
    return { status: "invalid", reason: "legacy file size must be a base-10 integer" };
  }
  const numericSize = Number(rawSize);
  const normalizedName = name.trim();
  if (!isValidEvidenceFileName(normalizedName)) return { status: "invalid", reason: "legacy file name is invalid" };
  if (!isAllowedEvidenceMimeType(mimeType)) return { status: "invalid", reason: "legacy file MIME type is not supported" };
  if (!isValidEvidenceFileSize(numericSize)) return { status: "invalid", reason: "legacy file size is invalid or too large" };
  const id = isStableEvidenceId(legacyId)
    ? legacyId
    : stableEvidenceId(`${goalId}\u0000${index}\u0000${value}`);
  if (remotePath && (!isStableEvidenceId(legacyId) || !isStructurallyValidRemoteEvidencePath(remotePath, legacyId, goalId))) {
    return { status: "invalid", reason: "legacy file cloud path is invalid" };
  }
  return {
    status: "valid",
    evidence: {
      id,
      type: "file",
      name: normalizedName,
      mimeType,
      size: numericSize,
      ...(remotePath ? { remotePath } : {}),
    },
  };
}

export function decodeLegacyGoalEvidence(value: string, goalId: string, index: number): LegacyEvidenceDecodeResult {
  const embedded = decodeLegacyEmbeddedFile(value, goalId, index);
  if (embedded) return embedded;
  const file = decodeLegacyPipeFile(value, goalId, index);
  if (file) return file;
  const trimmed = value.trim();
  if (!trimmed) return { status: "invalid", reason: "legacy evidence text is empty" };
  const id = stableEvidenceId(`${goalId}\u0000${index}\u0000${value}`);
  if (/^https?:\/\//i.test(trimmed)) {
    if (!isValidEvidenceUrl(trimmed)) return { status: "invalid", reason: "legacy evidence URL is invalid or too long" };
    return { status: "valid", evidence: { id, type: "link", url: trimmed } };
  }
  if (trimmed.length > MAX_EVIDENCE_NOTE_LENGTH) {
    return { status: "invalid", reason: "legacy evidence note is too long" };
  }
  return { status: "valid", evidence: { id, type: "note", text: trimmed } };
}

export function goalEvidenceFromText(value: string, id: string): GoalNoteEvidence | GoalLinkEvidence | null {
  const trimmed = value.trim();
  if (!isUuidCompatibleId(id) || !trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return isValidEvidenceUrl(trimmed) ? { id, type: "link", url: trimmed } : null;
  }
  return trimmed.length <= MAX_EVIDENCE_NOTE_LENGTH ? { id, type: "note", text: trimmed } : null;
}

export function migrationDataUrl(evidence: GoalEvidence): string | undefined {
  const candidate = evidence as GoalEvidence & { migrationDataUrl?: unknown };
  return typeof candidate.migrationDataUrl === "string" ? candidate.migrationDataUrl : undefined;
}

export function sanitizeGoalEvidence(value: unknown, goalId: string, index: number): GoalEvidence | null {
  if (typeof value === "string") {
    const decoded = decodeLegacyGoalEvidence(value, goalId, index);
    return decoded.status === "valid" ? decoded.evidence : null;
  }
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const id = isStableEvidenceId(value.id)
    ? value.id
    : stableEvidenceId(`${goalId}\u0000${index}\u0000${JSON.stringify(value)}`);
  if (value.type === "note") {
    const text = typeof value.text === "string" ? value.text.trim() : "";
    return text && text.length <= MAX_EVIDENCE_NOTE_LENGTH ? { id, type: "note", text } : null;
  }
  if (value.type === "link") {
    const url = typeof value.url === "string" ? value.url.trim() : "";
    return isValidEvidenceUrl(url) ? { id, type: "link", url } : null;
  }
  if (
    value.type !== "file"
    || !isValidEvidenceFileName(value.name)
    || !isAllowedEvidenceMimeType(value.mimeType)
    || !isValidEvidenceFileSize(value.size)
  ) return null;
  const remotePath = isStructurallyValidRemoteEvidencePath(value.remotePath, id, goalId)
    ? value.remotePath
    : undefined;
  const file: GoalFileEvidence = {
    id,
    type: "file",
    name: value.name.trim(),
    mimeType: value.mimeType,
    size: value.size,
    ...(remotePath ? { remotePath } : {}),
  };
  const embeddedDataUrl = typeof value.migrationDataUrl === "string" ? value.migrationDataUrl : undefined;
  const embeddedMetadata = embeddedDataUrl ? dataUrlMetadata(embeddedDataUrl) : null;
  if (
    embeddedDataUrl
    && embeddedMetadata
    && embeddedMetadata.mimeType === file.mimeType
    && embeddedMetadata.size === file.size
  ) {
    return { ...file, migrationDataUrl: embeddedDataUrl } as MigrationFileEvidence;
  }
  return file;
}

export function sanitizeGoalEvidenceList(value: unknown, goalId: string): GoalEvidence[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const evidence: GoalEvidence[] = [];
  for (let index = 0; index < value.length && evidence.length < MAX_GOAL_EVIDENCE_ITEMS; index += 1) {
    const item = sanitizeGoalEvidence(value[index], goalId, index);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    evidence.push(item);
  }
  return evidence;
}

export function validateGoalEvidenceList(evidence: readonly GoalEvidence[], goalId: string) {
  if (evidence.length > MAX_GOAL_EVIDENCE_ITEMS) {
    throw new Error(`A goal can contain at most ${MAX_GOAL_EVIDENCE_ITEMS} evidence items.`);
  }
  const seen = new Set<string>();
  evidence.forEach((item) => {
    if (!isStableEvidenceId(item.id) || seen.has(item.id)) {
      throw new Error("Evidence items must have unique, stable identifiers.");
    }
    seen.add(item.id);
    if (item.type === "note") {
      if (Object.keys(item).some((key) => !["id", "type", "text"].includes(key))) {
        throw new Error("Evidence notes contain unsupported metadata.");
      }
      if (!item.text.trim() || item.text.trim().length > MAX_EVIDENCE_NOTE_LENGTH) {
        throw new Error("Evidence notes must be non-empty and within the supported length.");
      }
      return;
    }
    if (item.type === "link") {
      if (Object.keys(item).some((key) => !["id", "type", "url"].includes(key))) {
        throw new Error("Evidence links contain unsupported metadata.");
      }
      if (!isValidEvidenceUrl(item.url)) throw new Error("Evidence links must use a valid HTTP or HTTPS URL.");
      return;
    }
    if (
      item.type !== "file"
      || Object.keys(item).some((key) => !["id", "type", "name", "mimeType", "size", "remotePath"].includes(key))
      || !isValidEvidenceFileName(item.name)
      || !isAllowedEvidenceMimeType(item.mimeType)
      || !isValidEvidenceFileSize(item.size)
      || (item.remotePath !== undefined
        && !isStructurallyValidRemoteEvidencePath(item.remotePath, item.id, goalId))
    ) {
      throw new Error("Evidence file metadata is invalid or outside the supported limits.");
    }
  });
}
