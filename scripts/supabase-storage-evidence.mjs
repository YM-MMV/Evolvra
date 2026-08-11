#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BUCKET = "evidence";
const FORMAT_VERSION = 1;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_SIZE = 1_000;
const MAX_CONCURRENCY = 16;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const PRODUCTION_CONFIRMATION = "RESTORE_EVIDENCE_TO_PRODUCTION";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalize(value, depth = 0) {
  if (depth > 32) throw new Error("Metadata nesting exceeds the supported safety limit.");
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key], depth + 1)]),
    );
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error("Metadata contains a value that cannot be represented safely in JSON.");
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function metadataHash(value) {
  return sha256(Buffer.from(stableStringify(value), "utf8"));
}

function normalizedOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, a query, or a fragment.`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${label} must not contain a path.`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS unless it is a loopback URL.`);
  }
  return url.origin;
}

function requireCredential(value, label) {
  if (typeof value !== "string" || value.trim().length < 20) {
    throw new Error(`${label} is missing or invalid.`);
  }
  if (value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
  return value;
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function normalizeAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === path.parse(normalized).root) {
    throw new Error(`${label} must be a normalized, non-root absolute path.`);
  }
  return normalized;
}

async function requireRealDirectory(directory, label) {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink.`);
  }
  const resolved = await realpath(directory);
  if (resolved !== directory) {
    throw new Error(`${label} must not pass through symlinked path components.`);
  }
}

export async function validateNewPath(value, label = "Output path") {
  const target = normalizeAbsolutePath(value, label);
  const parent = path.dirname(target);
  await requireRealDirectory(parent, `${label} parent`);
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return target;
    throw error;
  }
  throw new Error(`${label} already exists; choose a fresh path.`);
}

async function validateExistingDirectory(value, label) {
  const directory = normalizeAbsolutePath(value, label);
  await requireRealDirectory(directory, label);
  return directory;
}

function safeRemoteSegment(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeRemotePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_024
    && value.split("/").every(safeRemoteSegment);
}

function encodedRemotePath(value) {
  if (!safeRemotePath(value)) throw new Error("Storage returned an unsafe object path.");
  return value.split("/").map(encodeURIComponent).join("/");
}

export function objectStorageRelativePath(remotePath) {
  if (!safeRemotePath(remotePath)) throw new Error("Storage returned an unsafe object path.");
  return `objects/${sha256(Buffer.from(remotePath, "utf8"))}.bin`;
}

function metadataDocument(item, remotePath) {
  return canonicalize({
    path: remotePath,
    id: item.id ?? null,
    bucketId: item.bucket_id ?? BUCKET,
    createdAt: item.created_at ?? null,
    updatedAt: item.updated_at ?? null,
    lastAccessedAt: item.last_accessed_at ?? null,
    metadata: item.metadata ?? null,
  });
}

function inventoryDigest(records) {
  return sha256(Buffer.from(stableStringify(
    records.map((item) => ({
      path: item.path,
      metadataSha256: item.metadataSha256,
    })),
  ), "utf8"));
}

function authHeaders(key, extras = {}) {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    ...extras,
  };
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240);
}

async function responseFailure(response, operation) {
  // Provider error bodies are not surfaced or persisted because they may echo
  // private object names. The status and path hash identify the failed request.
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the useful HTTP failure if discarding the body also fails.
  }
  return new Error(`${operation} returned HTTP ${response.status}.`);
}

async function fetchWithRetry(makeRequest, {
  operation,
  attempts = 4,
  retryable = true,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await makeRequest();
      if (
        retryable
        && attempt < attempts
        && (response.status === 408 || response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** (attempt - 1))));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (!retryable || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** (attempt - 1))));
    }
  }
  throw lastError ?? new Error(`${operation} failed.`);
}

function storageClient({ origin, key, timeoutMs, fetchImpl = fetch }) {
  const request = (url, init, retryable = true) => fetchWithRetry(
    () => fetchImpl(url, {
      ...init,
      headers: authHeaders(key, init?.headers),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    }),
    { operation: "Storage request", retryable },
  );

  return {
    async list(prefix, limit, offset) {
      const response = await request(
        new URL(`/storage/v1/object/list/${BUCKET}`, origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prefix,
            limit,
            offset,
            sortBy: { column: "name", order: "asc" },
          }),
        },
      );
      if (!response.ok) throw await responseFailure(response, "Storage listing");
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("Storage listing returned an invalid response.");
      return rows;
    },

    async download(remotePath) {
      const response = await request(
        new URL(`/storage/v1/object/${BUCKET}/${encodedRemotePath(remotePath)}`, origin),
        { method: "GET" },
      );
      if (!response.ok) {
        throw await responseFailure(response, `Evidence download ${sha256(remotePath)}`);
      }
      if (!response.body) throw new Error("Evidence download returned no response body.");
      return response;
    },

    async upload(remotePath, localPath, size, headers, upsert) {
      const response = await request(
        new URL(`/storage/v1/object/${BUCKET}/${encodedRemotePath(remotePath)}`, origin),
        {
          method: "POST",
          headers: {
            "content-type": headers.contentType,
            "content-length": String(size),
            "x-upsert": upsert ? "true" : "false",
            ...(headers.cacheControl ? { "cache-control": headers.cacheControl } : {}),
          },
          body: createReadStream(localPath),
          duplex: "half",
        },
        false,
      );
      if (!response.ok) {
        throw await responseFailure(response, `Evidence upload ${sha256(remotePath)}`);
      }
      await response.body?.cancel();
    },
  };
}

async function listInventory(client, pageSize) {
  const queue = [""];
  const visited = new Set();
  const records = [];
  const paths = new Set();

  while (queue.length > 0) {
    const prefix = queue.shift();
    if (visited.has(prefix)) throw new Error("Storage listing returned a recursive folder.");
    visited.add(prefix);

    let offset = 0;
    while (true) {
      const rows = await client.list(prefix, pageSize, offset);
      for (const item of rows) {
        if (!isPlainObject(item) || !safeRemoteSegment(item.name)) {
          throw new Error("Storage listing returned an unsafe item name.");
        }
        const remotePath = prefix ? `${prefix}/${item.name}` : item.name;
        if (!safeRemotePath(remotePath)) {
          throw new Error("Storage listing returned an unsafe object path.");
        }
        if (item.id === null || item.id === undefined) {
          if (!visited.has(remotePath) && !queue.includes(remotePath)) queue.push(remotePath);
          continue;
        }
        if (paths.has(remotePath)) throw new Error("Storage listing returned a duplicate object.");
        paths.add(remotePath);
        const metadata = metadataDocument(item, remotePath);
        records.push({
          path: remotePath,
          file: objectStorageRelativePath(remotePath),
          metadata,
          metadataSha256: metadataHash(metadata),
        });
      }
      if (rows.length < pageSize) break;
      offset += rows.length;
    }
  }

  return records.sort((left, right) => left.path.localeCompare(right.path));
}

async function atomicWriteFile(target, bytes) {
  const temporary = `${target}.tmp-${randomUUID()}`;
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const parentHandle = await open(path.dirname(target), fsConstants.O_RDONLY);
  try {
    await parentHandle.sync();
  } finally {
    await parentHandle.close();
  }
}

async function syncDirectory(directory, openDirectory = open) {
  const handle = await openDirectory(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function invalidatePublishedBackup(target, publicationError) {
  const failures = [];
  let checksumRemoved = false;
  try {
    await rm(path.join(target, "MANIFEST.sha256"), { force: true });
    checksumRemoved = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    await atomicWriteFile(
      path.join(target, "FAILURE.json"),
      `${JSON.stringify({
        format: "evolvra-evidence-storage-backup-failure",
        version: FORMAT_VERSION,
        failedAt: new Date().toISOString(),
        error: safeErrorMessage(publicationError),
      }, null, 2)}\n`,
    );
  } catch (error) {
    failures.push(error);
  }
  return { checksumRemoved, failures };
}

async function publishBackupDirectory(
  staging,
  target,
  { openDirectory = open, renameDirectory = rename } = {},
) {
  const parent = path.dirname(target);
  await renameDirectory(staging, target);
  try {
    await syncDirectory(parent, openDirectory);
  } catch (publicationError) {
    try {
      await renameDirectory(target, staging);
    } catch (rollbackError) {
      const invalidation = await invalidatePublishedBackup(target, publicationError);
      if (!invalidation.checksumRemoved) {
        throw new AggregateError(
          [publicationError, rollbackError, ...invalidation.failures],
          "Backup publication failed and the requested destination could not be invalidated.",
        );
      }
      throw new AggregateError(
        [publicationError, rollbackError, ...invalidation.failures],
        "Backup publication failed; the requested destination was marked incomplete.",
      );
    }

    try {
      await syncDirectory(parent, openDirectory);
    } catch (rollbackSyncError) {
      throw new AggregateError(
        [publicationError, rollbackSyncError],
        "Backup publication was rolled back, but the rollback could not be synced.",
      );
    }
    throw new AggregateError(
      [publicationError],
      "Backup publication failed after rename and was rolled back.",
    );
  }
}

function hashingTransform(maxBytes) {
  const hash = createHash("sha256");
  let size = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new Error(`Evidence object exceeds the configured ${maxBytes}-byte limit.`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return {
    stream,
    result: () => ({ size, sha256: hash.digest("hex") }),
  };
}

function metadataReportedSize(metadata) {
  const value = metadata?.metadata?.size;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

async function downloadToFile(client, item, root, maxObjectBytes) {
  const target = path.join(root, item.file);
  const temporary = `${target}.partial-${randomUUID()}`;
  const response = await client.download(item.path);
  const tracker = hashingTransform(maxObjectBytes);
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      tracker.stream,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const result = tracker.result();
    const listedSize = metadataReportedSize(item.metadata);
    if (listedSize !== undefined && listedSize !== result.size) {
      throw new Error("Downloaded evidence size did not match Storage metadata.");
    }
    const fileHandle = await open(temporary, fsConstants.O_RDONLY);
    try {
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }
    await rename(temporary, target);
    return { ...item, ...result };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function hashResponse(response, maxObjectBytes) {
  const tracker = hashingTransform(maxObjectBytes);
  await pipeline(Readable.fromWeb(response.body), tracker.stream, new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }));
  return tracker.result();
}

async function mapBounded(items, concurrency, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await task(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function safeFailure(error, item) {
  return {
    objectPathSha256: sha256(Buffer.from(item.path, "utf8")),
    error: safeErrorMessage(error),
  };
}

async function mapBoundedSettled(items, concurrency, task) {
  const successes = [];
  const failures = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        const item = items[index];
        try {
          successes.push(await task(item, index));
        } catch (error) {
          failures.push(safeFailure(error, item));
        }
      }
    },
  );
  await Promise.all(workers);
  return { successes, failures };
}

function runtimeOptions(options = {}) {
  return {
    pageSize: parseInteger(
      options.pageSize ?? DEFAULT_PAGE_SIZE,
      "Page size",
      1,
      MAX_PAGE_SIZE,
    ),
    concurrency: parseInteger(
      options.concurrency ?? DEFAULT_CONCURRENCY,
      "Concurrency",
      1,
      MAX_CONCURRENCY,
    ),
    timeoutMs: parseInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Request timeout",
      1_000,
      MAX_TIMEOUT_MS,
    ),
    maxObjectBytes: parseInteger(
      options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES,
      "Maximum object bytes",
      1,
      MAX_OBJECT_BYTES,
    ),
  };
}

function inventoryIdentity(records) {
  return records.map((item) => ({
    path: item.path,
    // Reading an object may legitimately advance provider access metadata.
    // Creation/update identity and the Storage metadata payload must remain
    // stable; those fields detect a concurrent replacement.
    mutationMetadataSha256: metadataHash({
      ...item.metadata,
      lastAccessedAt: null,
    }),
  }));
}

export async function runBackup({
  output,
  sourceUrl,
  sourceKey,
  fetchImpl = fetch,
  publicationFileSystem,
  ...options
}) {
  const target = await validateNewPath(output);
  const origin = normalizedOrigin(sourceUrl, "Source Supabase URL");
  const key = requireCredential(sourceKey, "Source service-role key");
  const limits = runtimeOptions(options);
  const client = storageClient({
    origin,
    key,
    timeoutMs: limits.timeoutMs,
    fetchImpl,
  });
  const staging = `${target}.incomplete-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  await mkdir(path.join(staging, "objects"), { mode: 0o700 });

  try {
    const startedAt = new Date().toISOString();
    const initial = await listInventory(client, limits.pageSize);
    const downloaded = await mapBoundedSettled(
      initial,
      limits.concurrency,
      (item) => downloadToFile(client, item, staging, limits.maxObjectBytes),
    );
    if (downloaded.failures.length > 0) {
      await atomicWriteFile(
        path.join(staging, "FAILURE.json"),
        `${JSON.stringify({
          format: "evolvra-evidence-storage-backup-failure",
          version: FORMAT_VERSION,
          failedAt: new Date().toISOString(),
          failureCount: downloaded.failures.length,
          failures: downloaded.failures,
        }, null, 2)}\n`,
      );
      throw new Error(
        `${downloaded.failures.length} evidence object(s) could not be backed up; `
        + `incomplete data remains at ${staging}.`,
      );
    }

    const finalInventory = await listInventory(client, limits.pageSize);
    if (
      stableStringify(inventoryIdentity(initial))
      !== stableStringify(inventoryIdentity(finalInventory))
    ) {
      throw new Error(
        `The evidence bucket changed during backup; incomplete data remains at ${staging}.`,
      );
    }

    const objects = downloaded.successes.sort((left, right) => left.path.localeCompare(right.path));
    const totalBytes = objects.reduce((sum, item) => sum + item.size, 0);
    const manifest = {
      format: "evolvra-evidence-storage-backup",
      version: FORMAT_VERSION,
      status: "complete",
      bucket: BUCKET,
      sourceHost: new URL(origin).host,
      startedAt,
      completedAt: new Date().toISOString(),
      objectCount: objects.length,
      totalBytes,
      inventorySha256: inventoryDigest(objects),
      objects,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const manifestSha256 = sha256(manifestBytes);
    await atomicWriteFile(path.join(staging, "manifest.json"), manifestBytes);
    await atomicWriteFile(
      path.join(staging, "MANIFEST.sha256"),
      `${manifestSha256}  manifest.json\n`,
    );
    const directoryHandle = await open(staging, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await publishBackupDirectory(staging, target, publicationFileSystem);
    return {
      output: target,
      objectCount: objects.length,
      totalBytes,
      manifestSha256,
    };
  } catch (error) {
    const failurePath = path.join(staging, "FAILURE.json");
    try {
      await lstat(failurePath);
    } catch (failureStatError) {
      if (failureStatError?.code === "ENOENT") {
        try {
          await atomicWriteFile(
            failurePath,
            `${JSON.stringify({
              format: "evolvra-evidence-storage-backup-failure",
              version: FORMAT_VERSION,
              failedAt: new Date().toISOString(),
              error: safeErrorMessage(error),
            }, null, 2)}\n`,
          );
        } catch {
          // Preserve the original operational failure if reporting also fails.
        }
      }
    }
    throw error;
  }
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unexpected fields.`);
}

export function validateManifest(manifest) {
  assertExactKeys(
    manifest,
    [
      "format",
      "version",
      "status",
      "bucket",
      "sourceHost",
      "startedAt",
      "completedAt",
      "objectCount",
      "totalBytes",
      "inventorySha256",
      "objects",
    ],
    "Backup manifest",
  );
  if (
    manifest.format !== "evolvra-evidence-storage-backup"
    || manifest.version !== FORMAT_VERSION
    || manifest.status !== "complete"
    || manifest.bucket !== BUCKET
  ) {
    throw new Error("Backup manifest has an unsupported identity or version.");
  }
  if (!Array.isArray(manifest.objects)) throw new Error("Backup manifest objects are invalid.");
  if (
    typeof manifest.sourceHost !== "string"
    || !manifest.sourceHost
    || manifest.sourceHost.length > 255
    || /[\u0000-\u001f\u007f]/.test(manifest.sourceHost)
  ) {
    throw new Error("Backup source host is invalid.");
  }
  const validTimestamp = (value) => (
    typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
  );
  if (!validTimestamp(manifest.startedAt) || !validTimestamp(manifest.completedAt)) {
    throw new Error("Backup timestamps are invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.inventorySha256)) {
    throw new Error("Backup inventory hash is invalid.");
  }
  if (
    !Number.isSafeInteger(manifest.objectCount)
    || manifest.objectCount < 0
    || manifest.objectCount !== manifest.objects.length
  ) {
    throw new Error("Backup manifest object count is invalid.");
  }

  const seenPaths = new Set();
  const seenFiles = new Set();
  let totalBytes = 0;
  let priorPath;
  for (const item of manifest.objects) {
    assertExactKeys(
      item,
      ["path", "file", "metadata", "metadataSha256", "size", "sha256"],
      "Backup object",
    );
    if (!safeRemotePath(item.path)) throw new Error("Backup object path is invalid.");
    if (priorPath !== undefined && priorPath.localeCompare(item.path) >= 0) {
      throw new Error("Backup object paths must be unique and sorted.");
    }
    priorPath = item.path;
    const expectedFile = objectStorageRelativePath(item.path);
    if (item.file !== expectedFile) throw new Error("Backup object file mapping is invalid.");
    if (seenPaths.has(item.path) || seenFiles.has(item.file)) {
      throw new Error("Backup object paths must be unique.");
    }
    seenPaths.add(item.path);
    seenFiles.add(item.file);
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_OBJECT_BYTES) {
      throw new Error("Backup object size is invalid.");
    }
    totalBytes += item.size;
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("Backup object hash is invalid.");
    if (!/^[a-f0-9]{64}$/.test(item.metadataSha256)) {
      throw new Error("Backup object metadata hash is invalid.");
    }
    assertExactKeys(
      item.metadata,
      [
        "path",
        "id",
        "bucketId",
        "createdAt",
        "updatedAt",
        "lastAccessedAt",
        "metadata",
      ],
      "Backup object metadata",
    );
    if (item.metadata.path !== item.path || item.metadata.bucketId !== BUCKET) {
      throw new Error("Backup object metadata identity is invalid.");
    }
    if (metadataHash(item.metadata) !== item.metadataSha256) {
      throw new Error("Backup object metadata hash does not match.");
    }
  }
  if (!Number.isSafeInteger(totalBytes)) throw new Error("Backup total byte count is unsafe.");
  if (manifest.totalBytes !== totalBytes) throw new Error("Backup total byte count is invalid.");
  if (manifest.inventorySha256 !== inventoryDigest(manifest.objects)) {
    throw new Error("Backup inventory hash does not match.");
  }
  return manifest;
}

async function loadManifest(input) {
  const directory = await validateExistingDirectory(input, "Backup path");
  await requireRealDirectory(path.join(directory, "objects"), "Backup object directory");
  const manifestPath = path.join(directory, "manifest.json");
  const checksumPath = path.join(directory, "MANIFEST.sha256");
  for (const [target, label] of [
    [manifestPath, "Manifest"],
    [checksumPath, "Manifest checksum"],
  ]) {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`${label} must be a regular file.`);
    }
    const maximum = target === manifestPath ? MAX_MANIFEST_BYTES : 256;
    if (details.size > maximum) throw new Error(`${label} exceeds its safety limit.`);
  }
  const manifestBytes = await readFile(manifestPath);
  const checksum = (await readFile(checksumPath, "utf8")).trim();
  const match = /^([a-f0-9]{64})  manifest\.json$/.exec(checksum);
  if (!match || match[1] !== sha256(manifestBytes)) {
    throw new Error("Manifest checksum does not match.");
  }
  let parsed;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Backup manifest is not valid JSON.");
  }
  return { directory, manifest: validateManifest(parsed), manifestSha256: match[1] };
}

async function verifyObjectFile(directory, item) {
  const target = path.join(directory, item.file);
  const objectsRoot = path.join(directory, "objects");
  if (path.dirname(target) !== objectsRoot) throw new Error("Backup object escaped its data folder.");
  const details = await lstat(target);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("Backup object must be a regular file.");
  }
  if (details.size !== item.size) throw new Error("Backup object size does not match.");
  const tracker = hashingTransform(item.size + 1);
  await pipeline(createReadStream(target), tracker.stream, new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }));
  const digest = tracker.result();
  if (digest.sha256 !== item.sha256 || digest.size !== item.size) {
    throw new Error("Backup object hash does not match.");
  }
  return item.size;
}

export async function runVerify({ input, concurrency = DEFAULT_CONCURRENCY }) {
  const validatedConcurrency = parseInteger(
    concurrency,
    "Concurrency",
    1,
    MAX_CONCURRENCY,
  );
  const loaded = await loadManifest(input);
  await mapBounded(
    loaded.manifest.objects,
    validatedConcurrency,
    (item) => verifyObjectFile(loaded.directory, item),
  );
  return {
    input: loaded.directory,
    objectCount: loaded.manifest.objectCount,
    totalBytes: loaded.manifest.totalBytes,
    manifestSha256: loaded.manifestSha256,
  };
}

function isLoopbackOrigin(origin) {
  return ["localhost", "127.0.0.1", "::1"].includes(new URL(origin).hostname);
}

export function assessRestoreTarget({
  targetUrl,
  targetKind,
  productionUrl,
  allowRemoteDrill = false,
  allowProductionRestore = false,
  productionConfirmation,
}) {
  const targetOrigin = normalizedOrigin(targetUrl, "Target Supabase URL");
  if (targetKind !== "drill" && targetKind !== "production") {
    throw new Error("Restore target kind must be explicitly set to drill or production.");
  }
  const loopback = isLoopbackOrigin(targetOrigin);
  const productionOrigin = productionUrl
    ? normalizedOrigin(productionUrl, "Production Supabase URL")
    : undefined;

  if (targetKind === "drill") {
    if (!loopback) {
      if (!productionOrigin) {
        throw new Error(
          "Remote drills require EVOLVRA_STORAGE_PRODUCTION_URL so production can be excluded.",
        );
      }
      if (targetOrigin === productionOrigin) {
        throw new Error("A drill restore cannot target the production Supabase project.");
      }
      if (!allowRemoteDrill) {
        throw new Error("Remote drill restore requires --allow-remote-drill.");
      }
    }
    return { targetOrigin, targetKind };
  }

  if (!productionOrigin || targetOrigin !== productionOrigin) {
    throw new Error("Production restore target must exactly match EVOLVRA_STORAGE_PRODUCTION_URL.");
  }
  if (!allowProductionRestore) {
    throw new Error("Production restore requires --allow-production-restore.");
  }
  if (productionConfirmation !== PRODUCTION_CONFIRMATION) {
    throw new Error(
      `Production restore requires EVOLVRA_CONFIRM_PRODUCTION_STORAGE_RESTORE=${PRODUCTION_CONFIRMATION}.`,
    );
  }
  return { targetOrigin, targetKind };
}

function safeUploadHeaders(item) {
  const rawType = item.metadata?.metadata?.mimetype;
  const contentType = typeof rawType === "string"
    && rawType.length <= 200
    && !/[\r\n]/.test(rawType)
    ? rawType
    : "application/octet-stream";
  const rawCache = item.metadata?.metadata?.cacheControl
    ?? item.metadata?.metadata?.cache_control;
  const validatedCache = (
    typeof rawCache === "string"
    && rawCache.length <= 200
    && !/[\r\n]/.test(rawCache)
  )
    ? rawCache
    : undefined;
  const cacheControl = validatedCache && /^\d+$/.test(validatedCache)
    ? `max-age=${validatedCache}`
    : validatedCache;
  return { contentType, cacheControl };
}

async function restoreObject(client, directory, item, maxObjectBytes, upsert) {
  await verifyObjectFile(directory, item);
  const localPath = path.join(directory, item.file);
  await client.upload(
    item.path,
    localPath,
    item.size,
    safeUploadHeaders(item),
    upsert,
  );
  const downloaded = await client.download(item.path);
  const verified = await hashResponse(downloaded, maxObjectBytes);
  if (verified.size !== item.size || verified.sha256 !== item.sha256) {
    throw new Error("Restored evidence did not match its backup hash.");
  }
  return {
    objectPathSha256: sha256(Buffer.from(item.path, "utf8")),
    size: item.size,
    sha256: item.sha256,
  };
}

export async function runRestore({
  input,
  report,
  targetUrl,
  targetKey,
  targetKind,
  productionUrl,
  productionConfirmation,
  allowRemoteDrill = false,
  allowProductionRestore = false,
  upsert = false,
  fetchImpl = fetch,
  ...options
}) {
  const reportPath = await validateNewPath(report, "Restore report path");
  const target = assessRestoreTarget({
    targetUrl,
    targetKind,
    productionUrl,
    allowRemoteDrill,
    allowProductionRestore,
    productionConfirmation,
  });
  const key = requireCredential(targetKey, "Target service-role key");
  const limits = runtimeOptions(options);
  const loaded = await loadManifest(input);
  await runVerify({ input, concurrency: limits.concurrency });
  const client = storageClient({
    origin: target.targetOrigin,
    key,
    timeoutMs: limits.timeoutMs,
    fetchImpl,
  });
  const startedAt = new Date().toISOString();
  const restored = await mapBoundedSettled(
    loaded.manifest.objects,
    limits.concurrency,
    (item) => restoreObject(
      client,
      loaded.directory,
      item,
      limits.maxObjectBytes,
      upsert,
    ),
  );
  const reportDocument = {
    format: "evolvra-evidence-storage-restore-report",
    version: FORMAT_VERSION,
    status: restored.failures.length === 0 ? "complete" : "incomplete",
    targetKind: target.targetKind,
    targetHost: new URL(target.targetOrigin).host,
    upsert,
    sourceManifestSha256: loaded.manifestSha256,
    startedAt,
    completedAt: new Date().toISOString(),
    expectedObjectCount: loaded.manifest.objectCount,
    restoredObjectCount: restored.successes.length,
    failureCount: restored.failures.length,
    restored: restored.successes.sort(
      (left, right) => left.objectPathSha256.localeCompare(right.objectPathSha256),
    ),
    failures: restored.failures.sort(
      (left, right) => left.objectPathSha256.localeCompare(right.objectPathSha256),
    ),
  };
  await atomicWriteFile(reportPath, `${JSON.stringify(reportDocument, null, 2)}\n`);
  if (restored.failures.length > 0) {
    throw new Error(
      `${restored.failures.length} evidence object(s) failed restore or verification; `
      + `review ${reportPath}.`,
    );
  }
  return {
    report: reportPath,
    objectCount: restored.successes.length,
    totalBytes: loaded.manifest.totalBytes,
    manifestSha256: loaded.manifestSha256,
  };
}

function usage() {
  return `Usage:
  node scripts/supabase-storage-evidence.mjs backup --output /absolute/new-directory
  node scripts/supabase-storage-evidence.mjs verify --input /absolute/backup-directory
  node scripts/supabase-storage-evidence.mjs restore --input /absolute/backup-directory \\
    --report /absolute/new-report.json --target-kind drill

Backup environment:
  EVOLVRA_STORAGE_SOURCE_URL
  EVOLVRA_STORAGE_SOURCE_SERVICE_ROLE_KEY

Restore environment:
  EVOLVRA_STORAGE_TARGET_URL
  EVOLVRA_STORAGE_TARGET_SERVICE_ROLE_KEY
  EVOLVRA_STORAGE_PRODUCTION_URL (required for every remote restore)

Safety flags:
  --allow-remote-drill
  --allow-production-restore
  --upsert

Limits:
  --page-size ${DEFAULT_PAGE_SIZE}
  --concurrency ${DEFAULT_CONCURRENCY}
  --request-timeout-ms ${DEFAULT_TIMEOUT_MS}
  --max-object-bytes ${DEFAULT_MAX_OBJECT_BYTES}`;
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (!["backup", "verify", "restore"].includes(command)) {
    throw new Error(usage());
  }
  const values = {};
  const booleans = new Set([
    "--allow-remote-drill",
    "--allow-production-restore",
    "--upsert",
  ]);
  const supported = new Set({
    backup: [
      "--output",
      "--page-size",
      "--concurrency",
      "--request-timeout-ms",
      "--max-object-bytes",
    ],
    verify: ["--input", "--concurrency"],
    restore: [
      "--input",
      "--report",
      "--target-kind",
      "--concurrency",
      "--request-timeout-ms",
      "--max-object-bytes",
      ...booleans,
    ],
  }[command]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!supported.has(token)) throw new Error(`Unknown option ${token}.\n${usage()}`);
    if (Object.hasOwn(values, token)) throw new Error(`Duplicate option ${token}.`);
    if (booleans.has(token)) {
      values[token] = true;
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    values[token] = value;
    index += 1;
  }
  return { command, values };
}

function optionValues(values) {
  return {
    pageSize: values["--page-size"],
    concurrency: values["--concurrency"],
    timeoutMs: values["--request-timeout-ms"],
    maxObjectBytes: values["--max-object-bytes"],
  };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const { command, values } = parseArguments(argv);
  if (command === "backup") {
    if (!values["--output"]) throw new Error("backup requires --output.");
    const result = await runBackup({
      output: values["--output"],
      sourceUrl: environment.EVOLVRA_STORAGE_SOURCE_URL,
      sourceKey: environment.EVOLVRA_STORAGE_SOURCE_SERVICE_ROLE_KEY,
      ...optionValues(values),
    });
    console.log(`Evidence backup complete: ${result.output}`);
    console.log(`Objects: ${result.objectCount}; bytes: ${result.totalBytes}`);
    console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    return;
  }
  if (command === "verify") {
    if (!values["--input"]) throw new Error("verify requires --input.");
    const result = await runVerify({
      input: values["--input"],
      concurrency: values["--concurrency"],
    });
    console.log(`Evidence backup verified: ${result.input}`);
    console.log(`Objects: ${result.objectCount}; bytes: ${result.totalBytes}`);
    console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    return;
  }
  if (!values["--input"] || !values["--report"] || !values["--target-kind"]) {
    throw new Error("restore requires --input, --report, and --target-kind.");
  }
  const result = await runRestore({
    input: values["--input"],
    report: values["--report"],
    targetUrl: environment.EVOLVRA_STORAGE_TARGET_URL,
    targetKey: environment.EVOLVRA_STORAGE_TARGET_SERVICE_ROLE_KEY,
    targetKind: values["--target-kind"],
    productionUrl: environment.EVOLVRA_STORAGE_PRODUCTION_URL,
    productionConfirmation: environment.EVOLVRA_CONFIRM_PRODUCTION_STORAGE_RESTORE,
    allowRemoteDrill: values["--allow-remote-drill"] === true,
    allowProductionRestore: values["--allow-production-restore"] === true,
    upsert: values["--upsert"] === true,
    ...optionValues(values),
  });
  console.log(`Evidence restore verified: ${result.report}`);
  console.log(`Objects: ${result.objectCount}; bytes: ${result.totalBytes}`);
  console.log(`Source manifest SHA-256: ${result.manifestSha256}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(`Evidence Storage operation failed: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
