import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runProviderCloudSave,
  type ProviderCloudSaveCurrentness,
  type ProviderCloudSavePorts,
  type ProviderCloudSaveRequest,
} from "@/lib/provider-cloud-save";
import { parseWorkspaceRevision } from "@/lib/sync-reconciliation";

const ACCOUNT_ID = "account-a";
const UPDATED_AT = "2026-07-29T12:00:00.000Z";

interface TestSnapshot {
  readonly version: number;
  readonly chunks?: readonly string[];
}

type TestRequest = ProviderCloudSaveRequest<TestSnapshot, string>;
type TestPorts = ProviderCloudSavePorts<TestSnapshot, string>;

function request(snapshot: TestSnapshot = { version: 3 }): TestRequest {
  return {
    boundary: {
      accountId: ACCOUNT_ID,
      workspaceGeneration: "generation-7",
      workspaceScopeKey: "scope-11",
    },
    snapshot,
    expectedRevision: 8,
    changeVersion: 13,
  };
}

function ports(overrides: Partial<TestPorts> = {}): TestPorts {
  return {
    saveSnapshot: async () => ({
      data: [{ revision: 9, updated_at: UPDATED_AT }],
      error: null,
    }),
    inspectCurrentness: () => ({ current: true }),
    readChangeVersion: () => 13,
    parseRevision: parseWorkspaceRevision,
    isRevisionConflict: (error) => (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "PT409"
    ),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function representativeLargeSnapshot(): TestSnapshot {
  const chunks = Array.from({ length: 20 }, (_, index) => (
    `${index}:`.padEnd(240 * 1024, "x")
  ));
  const snapshot = { version: 3, chunks };
  expect(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength)
    .toBeGreaterThan(4.5 * 1024 * 1024);
  return snapshot;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider cloud save coordination", () => {
  it("returns the validated revision and whether the submitted local version stayed unchanged", async () => {
    const saveSnapshot = vi.fn<TestPorts["saveSnapshot"]>(async () => ({
      data: { revision: "9", updated_at: UPDATED_AT },
      error: null,
    }));
    const submitted = request();

    await expect(runProviderCloudSave(
      submitted,
      ports({ saveSnapshot }),
    )).resolves.toEqual({
      kind: "saved",
      revision: 9,
      updatedAt: UPDATED_AT,
      localUnchanged: true,
    });
    expect(saveSnapshot).toHaveBeenCalledWith(
      submitted.snapshot,
      submitted.expectedRevision,
    );

    await expect(runProviderCloudSave(
      submitted,
      ports({ readChangeVersion: () => 14 }),
    )).resolves.toMatchObject({
      kind: "saved",
      localUnchanged: false,
    });
  });

  it("does not start a request after the account boundary becomes stale", async () => {
    const saveSnapshot = vi.fn<TestPorts["saveSnapshot"]>();

    await expect(runProviderCloudSave(
      request(),
      ports({
        saveSnapshot,
        inspectCurrentness: () => ({
          current: false,
          reason: "account",
        }),
      }),
    )).resolves.toEqual({
      kind: "superseded",
      phase: "preflight",
      reason: "account",
    });
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["account", "account"] as const,
    ["workspace scope", "scope"] as const,
  ])("ignores a response that settles after the %s changes", async (_label, reason) => {
    const pending = deferred<{
      data: Array<{ revision: number; updated_at: string }>;
      error: null;
    }>();
    let currentness: ProviderCloudSaveCurrentness = { current: true };
    const outcome = runProviderCloudSave(
      request(),
      ports({
        saveSnapshot: () => pending.promise,
        inspectCurrentness: () => currentness,
      }),
    );

    currentness = { current: false, reason };
    pending.resolve({
      data: [{ revision: 9, updated_at: UPDATED_AT }],
      error: null,
    });

    await expect(outcome).resolves.toEqual({
      kind: "superseded",
      phase: "settlement",
      reason,
    });
  });

  it.each([
    ["missing row", [], null],
    ["invalid revision", [{ revision: -1, updated_at: UPDATED_AT }], null],
    ["missing timestamp", [{ revision: 9 }], null],
  ])("rejects a %s as a malformed response", async (_label, data, error) => {
    await expect(runProviderCloudSave(
      request(),
      ports({ saveSnapshot: async () => ({ data, error }) }),
    )).resolves.toEqual({
      kind: "malformed-response",
      data,
    });
  });

  it("distinguishes a returned revision conflict from an ordinary returned error", async () => {
    const conflict = { code: "PT409", message: "revision changed" };
    const ordinary = { code: "XX000", message: "database unavailable" };

    await expect(runProviderCloudSave(
      request(),
      ports({
        saveSnapshot: async () => ({ data: null, error: conflict }),
      }),
    )).resolves.toEqual({
      kind: "revision-conflict",
      error: conflict,
    });
    await expect(runProviderCloudSave(
      request(),
      ports({
        saveSnapshot: async () => ({ data: null, error: ordinary }),
      }),
    )).resolves.toEqual({
      kind: "error",
      error: ordinary,
    });
  });

  it("marks a lost response as ambiguous because the server may have committed", async () => {
    const lostResponse = new TypeError("network response was lost");

    await expect(runProviderCloudSave(
      request(),
      ports({
        saveSnapshot: async () => {
          throw lostResponse;
        },
      }),
    )).resolves.toEqual({
      kind: "ambiguous",
      error: lostResponse,
    });
  });

  it("accepts a slow successful near-limit snapshot without cloning or timing it out locally", async () => {
    vi.useFakeTimers();
    const snapshot = representativeLargeSnapshot();
    const saveSnapshot = vi.fn<TestPorts["saveSnapshot"]>(() => (
      new Promise((resolve) => {
        setTimeout(() => resolve({
          data: [{ revision: 9, updated_at: UPDATED_AT }],
          error: null,
        }), 7_500);
      })
    ));
    const outcome = runProviderCloudSave(
      request(snapshot),
      ports({ saveSnapshot }),
    );

    await vi.advanceTimersByTimeAsync(7_499);
    expect(saveSnapshot).toHaveBeenCalledWith(snapshot, 8);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject({
      kind: "saved",
      revision: 9,
      localUnchanged: true,
    });
  });

  it("treats an interrupted near-limit snapshot as ambiguous and leaves adoption to reconciliation", async () => {
    vi.useFakeTimers();
    const snapshot = representativeLargeSnapshot();
    const interrupted = new DOMException(
      "The snapshot request was aborted.",
      "AbortError",
    );
    const outcome = runProviderCloudSave(
      request(snapshot),
      ports({
        saveSnapshot: () => new Promise((_resolve, reject) => {
          setTimeout(() => reject(interrupted), 10_000);
        }),
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toEqual({
      kind: "ambiguous",
      error: interrupted,
    });
  });
});
