declare const workspaceScopeKeyBrand: unique symbol;

/**
 * An opaque, monotonically increasing workspace generation.
 *
 * Decimal strings avoid the Number.MAX_SAFE_INTEGER rollover that could make a
 * newly opened scope equal to a retired one. They are private process-local
 * coordination keys, not persisted workspace data.
 */
export type WorkspaceScopeKey = string & {
  readonly [workspaceScopeKeyBrand]: "WorkspaceScopeKey";
};

const DECIMAL_SCOPE_KEY = /^(0|[1-9]\d*)$/;

export const INITIAL_WORKSPACE_SCOPE_KEY = "0" as WorkspaceScopeKey;

export function workspaceScopeKeyFromDecimal(value: string): WorkspaceScopeKey {
  if (!DECIMAL_SCOPE_KEY.test(value)) {
    throw new Error("Workspace scope keys must be canonical unsigned decimal strings.");
  }
  return value as WorkspaceScopeKey;
}

export function compareWorkspaceScopeKeys(
  left: WorkspaceScopeKey,
  right: WorkspaceScopeKey,
): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function incrementWorkspaceScopeKey(current: WorkspaceScopeKey): WorkspaceScopeKey {
  const digits = current.split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] === "9") {
      digits[index] = "0";
      continue;
    }
    digits[index] = String(Number(digits[index]) + 1);
    return digits.join("") as WorkspaceScopeKey;
  }
  return `1${digits.join("")}` as WorkspaceScopeKey;
}
