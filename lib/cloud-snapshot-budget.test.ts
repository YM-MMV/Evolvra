import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  saveWorkspaceSnapshotWithDeadline,
  WORKSPACE_SNAPSHOT_RPC_TIMEOUT_MS,
} from "@/lib/supabase";
import { MAX_WORKSPACE_SERIALIZED_BYTES } from "@/lib/state-schema";

const MEBIBYTE = 1024 * 1024;

function representativeFullSnapshot() {
  const state = {
    version: 3,
    chunks: Array.from({ length: 20 }, (_, index) => (
      `${index}:`.padEnd(240 * 1024, "x")
    )),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  expect(bytes).toBeGreaterThan(4.5 * MEBIBYTE);
  expect(bytes).toBeLessThan(MAX_WORKSPACE_SERIALIZED_BYTES);
  return state;
}

function delayedSnapshotClient(delayMs: number) {
  let submittedSignal: AbortSignal | null = null;
  const abortSignal = vi.fn((signal: AbortSignal) => {
    submittedSignal = signal;
    return new Promise<{ data: Array<{ revision: number }>; error: null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({ data: [{ revision: 9 }], error: null });
        }, delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The snapshot request was aborted.", "AbortError"));
        }, { once: true });
      },
    );
  });
  const rpc = vi.fn(() => ({ abortSignal }));
  return {
    client: { rpc } as unknown as SupabaseClient,
    rpc,
    abortSignal,
    submittedSignal: () => submittedSignal,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("full cloud snapshot timing budget", () => {
  it("allows a reproducible 7.5 second near-limit round trip within the 10 second budget", async () => {
    vi.useFakeTimers();
    const state = representativeFullSnapshot();
    const mock = delayedSnapshotClient(7_500);
    const pending = saveWorkspaceSnapshotWithDeadline(
      mock.client,
      "00000000-0000-0000-0000-0000000000a1",
      state,
      8,
    );

    await vi.advanceTimersByTimeAsync(7_500);

    await expect(pending).resolves.toEqual({
      data: [{ revision: 9 }],
      error: null,
    });
    expect(mock.rpc).toHaveBeenCalledWith("save_workspace_snapshot", {
      p_expected_account_id: "00000000-0000-0000-0000-0000000000a1",
      p_state: state,
      p_expected_revision: 8,
    });
    expect(mock.submittedSignal()?.aborted).toBe(false);
  });

  it("interrupts a stalled near-limit round trip at the documented deadline", async () => {
    vi.useFakeTimers();
    const state = representativeFullSnapshot();
    const mock = delayedSnapshotClient(
      WORKSPACE_SNAPSHOT_RPC_TIMEOUT_MS + 5_000,
    );
    const pending = saveWorkspaceSnapshotWithDeadline(
      mock.client,
      "00000000-0000-0000-0000-0000000000a1",
      state,
      8,
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(WORKSPACE_SNAPSHOT_RPC_TIMEOUT_MS);

    await rejection;
    expect(mock.abortSignal).toHaveBeenCalledTimes(1);
    expect(mock.submittedSignal()?.aborted).toBe(true);
  });
});
