import type { AppState } from "@/lib/types";
import {
  assertInternalWorkspaceTransition,
  MAX_WORKSPACE_NESTING_DEPTH,
  MAX_WORKSPACE_NODES,
  MAX_WORKSPACE_SERIALIZED_BYTES,
  MAX_WORKSPACE_STRING_BYTES,
  parseImportedState,
  WorkspaceImportError,
} from "@/lib/state-schema";
import {
  NonJsonWorkspaceValueError,
  profileJsonValue,
} from "@/lib/workspace-json-profile";

export const cloneWorkspaceValue = <T,>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

export const MAX_UNDO_HISTORY_BYTES = 20 * 1024 * 1024;
export const MAX_UNDO_HISTORY_ITEMS = 10;

export function trimWorkspaceHistory(
  history: readonly AppState[],
  maximumItems = MAX_UNDO_HISTORY_ITEMS,
  maximumBytes = MAX_UNDO_HISTORY_BYTES,
) {
  const itemLimit = Number.isFinite(maximumItems)
    ? Math.max(0, Math.trunc(maximumItems))
    : 0;
  const byteLimit = Number.isFinite(maximumBytes)
    ? Math.max(0, Math.trunc(maximumBytes))
    : 0;
  if (itemLimit === 0 || byteLimit === 0) return [];

  const retained: AppState[] = [];
  let bytes = 0;
  for (const snapshot of history.slice(-itemLimit).reverse()) {
    const snapshotBytes = profileJsonValue(snapshot).bytes;
    if (bytes + snapshotBytes > byteLimit) break;
    retained.unshift(snapshot);
    bytes += snapshotBytes;
  }
  return retained;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonValuesEqual(item, right[index]));
  }
  if (
    typeof left !== "object"
    || left === null
    || typeof right !== "object"
    || right === null
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonValuesEqual(leftRecord[key], rightRecord[key]));
}

export const workspaceStatesEqual = (left: AppState, right: AppState) =>
  jsonValuesEqual(left, right);

export interface WorkspaceMutationResult {
  state: AppState;
  history: AppState[];
}

type DraftContainer = Record<PropertyKey, unknown> | unknown[];

interface DraftNode {
  base: DraftContainer;
  copy: DraftContainer | null;
  parent: DraftNode | null;
  parentKey: PropertyKey | null;
  drafts: Map<PropertyKey, DraftNode>;
  assigned: Set<PropertyKey>;
  modified: boolean;
  finalized: boolean;
  result: DraftContainer | null;
  proxy: DraftContainer;
}

const DRAFT_NODE = Symbol("evolvra-workspace-draft");

const isDraftContainer = (value: unknown): value is DraftContainer => {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const currentContainer = (node: DraftNode) => node.copy ?? node.base;

function draftNodeFor(value: unknown): DraftNode | null {
  if (!isDraftContainer(value)) return null;
  try {
    const node = Reflect.get(value, DRAFT_NODE);
    return node && typeof node === "object" ? node as DraftNode : null;
  } catch {
    return null;
  }
}

function markDraftModified(node: DraftNode) {
  if (node.modified) return;
  node.modified = true;
  node.copy = Array.isArray(node.base)
    ? node.base.slice()
    : { ...node.base };
  if (!node.parent || node.parentKey === null) return;
  const parentValue = Reflect.get(currentContainer(node.parent), node.parentKey);
  if (parentValue !== node.base && parentValue !== node.proxy) return;
  markDraftModified(node.parent);
  Reflect.set(node.parent.copy!, node.parentKey, node.proxy);
}

function createDraftNode(
  base: DraftContainer,
  parent: DraftNode | null,
  parentKey: PropertyKey | null,
): DraftNode {
  const node = {
    base,
    copy: null,
    parent,
    parentKey,
    drafts: new Map<PropertyKey, DraftNode>(),
    assigned: new Set<PropertyKey>(),
    modified: false,
    finalized: false,
    result: null,
    proxy: {} as DraftContainer,
  } satisfies DraftNode;

  const proxyTarget: DraftContainer = Array.isArray(base) ? [] : {};
  node.proxy = new Proxy(proxyTarget, {
    get(_target, property) {
      if (property === DRAFT_NODE) return node;
      const source = currentContainer(node);
      const value = Reflect.get(source, property);
      if (!isDraftContainer(value)) return value;
      const existing = node.drafts.get(property);
      if (existing && (value === existing.base || value === existing.proxy)) {
        return existing.proxy;
      }
      const child = createDraftNode(value, node, property);
      node.drafts.set(property, child);
      return child.proxy;
    },
    set(_target, property, value) {
      const source = currentContainer(node);
      if (Object.is(Reflect.get(source, property), value)) return true;
      markDraftModified(node);
      node.assigned.add(property);
      node.drafts.delete(property);
      return Reflect.set(node.copy!, property, value);
    },
    deleteProperty(_target, property) {
      if (!Reflect.has(currentContainer(node), property)) return true;
      markDraftModified(node);
      node.assigned.add(property);
      node.drafts.delete(property);
      return Reflect.deleteProperty(node.copy!, property);
    },
    defineProperty() {
      throw new TypeError("Workspace commands cannot define property descriptors.");
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        currentContainer(node),
        property,
      );
      return descriptor;
    },
    has(_target, property) {
      return Reflect.has(currentContainer(node), property);
    },
    ownKeys() {
      return Reflect.ownKeys(currentContainer(node));
    },
    setPrototypeOf() {
      throw new TypeError("Workspace commands cannot change object prototypes.");
    },
  }) as DraftContainer;
  return node;
}

function cloneAssignedValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  const draftNode = draftNodeFor(value);
  if (draftNode) return finalizeDraftNode(draftNode);
  if (!isDraftContainer(value)) return value;
  const existing = seen.get(value);
  if (existing) return existing;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    value.forEach((item) => clone.push(cloneAssignedValue(item, seen)));
    return clone;
  }
  const clone: Record<PropertyKey, unknown> = {};
  seen.set(value, clone);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) return;
    clone[key] = cloneAssignedValue(Reflect.get(value, key), seen);
  });
  return clone;
}

function finalizeDraftNode(node: DraftNode): DraftContainer {
  if (node.finalized) return node.result ?? node.base;
  node.finalized = true;
  if (!node.modified) {
    node.result = node.base;
    return node.base;
  }
  const result = node.copy!;
  const assignedSeen = new WeakMap<object, unknown>();
  Reflect.ownKeys(result).forEach((property) => {
    const value = Reflect.get(result, property);
    const child = draftNodeFor(value) ?? node.drafts.get(property);
    if (child && (value === child.proxy || value === child.base)) {
      Reflect.set(result, property, finalizeDraftNode(child));
      return;
    }
    if (node.assigned.has(property)) {
      Reflect.set(result, property, cloneAssignedValue(value, assignedSeen));
    }
  });
  node.result = result;
  return result;
}

function produceWorkspaceState(
  current: AppState,
  recipe: (draft: AppState) => void,
  updatedAt: string,
) {
  const root = createDraftNode(
    current as unknown as DraftContainer,
    null,
    null,
  );
  const draft = root.proxy as unknown as AppState;
  recipe(draft);
  draft.updatedAt = updatedAt;
  return finalizeDraftNode(root) as unknown as AppState;
}

function assertWorkspaceResourceLimits(state: AppState) {
  let profile;
  try {
    profile = profileJsonValue(state);
  } catch (error) {
    if (error instanceof NonJsonWorkspaceValueError) {
      throw new WorkspaceImportError(error.message);
    }
    throw error;
  }
  if (profile.bytes > MAX_WORKSPACE_SERIALIZED_BYTES) {
    throw new WorkspaceImportError(
      `workspace is larger than the ${Math.round(MAX_WORKSPACE_SERIALIZED_BYTES / (1024 * 1024))} MB safety limit.`,
    );
  }
  if (profile.nodes > MAX_WORKSPACE_NODES) {
    throw new WorkspaceImportError(
      `workspace exceeds the ${MAX_WORKSPACE_NODES.toLocaleString()}-node safety limit.`,
    );
  }
  if (profile.maximumDepth > MAX_WORKSPACE_NESTING_DEPTH) {
    throw new WorkspaceImportError(
      `workspace exceeds the maximum nesting depth of ${MAX_WORKSPACE_NESTING_DEPTH}.`,
    );
  }
  if (profile.maximumStringBytes > MAX_WORKSPACE_STRING_BYTES) {
    throw new WorkspaceImportError("workspace exceeds the per-string size limit.");
  }
}

function runWorkspaceTransaction(
  current: AppState,
  recipe: (draft: AppState) => void,
  updatedAt: string,
) {
  const state = produceWorkspaceState(current, recipe, updatedAt);
  assertWorkspaceResourceLimits(state);
  assertInternalWorkspaceTransition(current, state);
  return state;
}

/**
 * A cloud snapshot selected as the source of truth starts a new local undo
 * boundary. Retaining device history here would let Undo resurrect and upload
 * a snapshot that predates the cloud state the person just adopted.
 */
export function adoptAuthoritativeWorkspaceState(
  authoritativeState: AppState,
): WorkspaceMutationResult {
  const state = parseImportedState(authoritativeState);
  return { state, history: [] };
}

/** One domain command produces exactly one undo snapshot. */
export function runUndoableWorkspaceMutation(
  current: AppState,
  history: AppState[],
  recipe: (draft: AppState) => void,
  updatedAt = new Date().toISOString(),
): WorkspaceMutationResult {
  const state = runWorkspaceTransaction(current, recipe, updatedAt);
  return {
    state,
    history: trimWorkspaceHistory([...history, current]),
  };
}

/** File-backed or destructive operations deliberately invalidate undo history. */
export function runNonUndoableWorkspaceMutation(
  current: AppState,
  recipe: (draft: AppState) => void,
  updatedAt = new Date().toISOString(),
): WorkspaceMutationResult {
  const state = runWorkspaceTransaction(current, recipe, updatedAt);
  return { state, history: [] };
}
