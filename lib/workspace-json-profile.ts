/**
 * Exact JSON resource accounting without serialising a whole workspace.
 *
 * Profiles are cached per immutable object. Provider transactions preserve
 * references for untouched branches, so profiling a new state only has to
 * inspect the objects along changed paths. The byte count matches UTF-8
 * JSON.stringify output for JSON-compatible values.
 */

export interface JsonResourceProfile {
  bytes: number;
  nodes: number;
  maximumDepth: number;
  maximumStringBytes: number;
}

export class NonJsonWorkspaceValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonJsonWorkspaceValueError";
  }
}

const profileCache = new WeakMap<object, JsonResourceProfile>();
const encoder = new TextEncoder();

const encodedJsonScalarBytes = (value: string | number) => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new NonJsonWorkspaceValueError("The workspace contains a value that cannot exist in JSON.");
  }
  return encoder.encode(serialized).byteLength;
};

function profileValue(
  value: unknown,
  ancestors: WeakSet<object>,
): JsonResourceProfile {
  if (typeof value === "string") {
    const rawBytes = encoder.encode(value).byteLength;
    return {
      bytes: encodedJsonScalarBytes(value),
      nodes: 1,
      maximumDepth: 0,
      maximumStringBytes: rawBytes,
    };
  }
  if (value === null) {
    return { bytes: 4, nodes: 1, maximumDepth: 0, maximumStringBytes: 0 };
  }
  if (typeof value === "boolean") {
    return {
      bytes: value ? 4 : 5,
      nodes: 1,
      maximumDepth: 0,
      maximumStringBytes: 0,
    };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new NonJsonWorkspaceValueError("The workspace contains a non-finite number.");
    }
    return {
      bytes: encodedJsonScalarBytes(value),
      nodes: 1,
      maximumDepth: 0,
      maximumStringBytes: 0,
    };
  }
  if (typeof value !== "object") {
    throw new NonJsonWorkspaceValueError("The workspace contains a value that cannot exist in JSON.");
  }
  if (ancestors.has(value)) {
    throw new NonJsonWorkspaceValueError("The workspace contains a circular reference.");
  }
  const cached = profileCache.get(value);
  if (cached) return cached;

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value)
    && prototype !== Object.prototype
    && prototype !== null
  ) {
    throw new NonJsonWorkspaceValueError("The workspace contains a non-JSON object.");
  }

  ancestors.add(value);
  let bytes = 2;
  let nodes = 1;
  let maximumDepth = 0;
  let maximumStringBytes = 0;
  const values: Array<[string | null, unknown]> = Array.isArray(value)
    ? Array.from(value, (item) => [null, item])
    : Object.entries(value);

  values.forEach(([key, item], index) => {
    const itemProfile = profileValue(item, ancestors);
    if (index > 0) bytes += 1;
    if (key !== null) {
      bytes += encodedJsonScalarBytes(key) + 1;
      maximumStringBytes = Math.max(
        maximumStringBytes,
        encoder.encode(key).byteLength,
      );
    }
    bytes += itemProfile.bytes;
    nodes += itemProfile.nodes;
    maximumDepth = Math.max(maximumDepth, itemProfile.maximumDepth + 1);
    maximumStringBytes = Math.max(
      maximumStringBytes,
      itemProfile.maximumStringBytes,
    );
  });
  ancestors.delete(value);

  const profile = { bytes, nodes, maximumDepth, maximumStringBytes };
  profileCache.set(value, profile);
  return profile;
}

export function profileJsonValue(value: unknown): JsonResourceProfile {
  return profileValue(value, new WeakSet<object>());
}
