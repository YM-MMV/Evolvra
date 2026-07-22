import type { AppState } from "@/lib/types";
import { parseImportedState } from "@/lib/state-schema";

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
    const snapshotBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
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

/**
 * A cloud snapshot selected as the source of truth starts a new local undo
 * boundary. Retaining device history here would let Undo resurrect and upload
 * a snapshot that predates the cloud state the person just adopted.
 */
export function adoptAuthoritativeWorkspaceState(
  authoritativeState: AppState,
): WorkspaceMutationResult {
  const state = cloneWorkspaceValue(authoritativeState);
  parseImportedState(state);
  return { state, history: [] };
}

/** One domain command produces exactly one undo snapshot. */
export function runUndoableWorkspaceMutation(
  current: AppState,
  history: AppState[],
  recipe: (draft: AppState) => void,
  updatedAt = new Date().toISOString(),
): WorkspaceMutationResult {
  const draft = cloneWorkspaceValue(current);
  recipe(draft);
  draft.updatedAt = updatedAt;
  parseImportedState(draft);
  return {
    state: draft,
    history: trimWorkspaceHistory([...history, current]),
  };
}

/** File-backed or destructive operations deliberately invalidate undo history. */
export function runNonUndoableWorkspaceMutation(
  current: AppState,
  recipe: (draft: AppState) => void,
  updatedAt = new Date().toISOString(),
): WorkspaceMutationResult {
  const draft = cloneWorkspaceValue(current);
  recipe(draft);
  draft.updatedAt = updatedAt;
  parseImportedState(draft);
  return { state: draft, history: [] };
}
