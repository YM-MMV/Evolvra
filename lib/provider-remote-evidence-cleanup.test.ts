import { describe, expect, it, vi } from "vitest";
import {
  runClaimedRemoteEvidenceCleanup,
  type ClaimedRemoteEvidenceCleanupPorts,
} from "@/lib/provider-remote-evidence-cleanup";

type TestPorts = ClaimedRemoteEvidenceCleanupPorts;

function ports(overrides: Partial<TestPorts> = {}): TestPorts {
  return {
    claimCleanup: async () => "claimed",
    cancelCleanup: async () => undefined,
    removeRemote: async () => undefined,
    completeCleanup: async () => undefined,
    ...overrides,
  };
}

describe("claimed remote evidence cleanup", () => {
  it("cancels a referenced intent without removing the object", async () => {
    const events: string[] = [];
    const removeRemote = vi.fn<TestPorts["removeRemote"]>();
    const completeCleanup = vi.fn<TestPorts["completeCleanup"]>();

    await expect(runClaimedRemoteEvidenceCleanup(ports({
      claimCleanup: async () => {
        events.push("claim");
        return "referenced";
      },
      cancelCleanup: async () => {
        events.push("cancel");
      },
      removeRemote,
      completeCleanup,
    }))).resolves.toBe("cancelled-referenced");
    expect(events).toEqual(["claim", "cancel"]);
    expect(removeRemote).not.toHaveBeenCalled();
    expect(completeCleanup).not.toHaveBeenCalled();
  });

  it("removes and completes only after the server claim succeeds", async () => {
    const events: string[] = [];

    await expect(runClaimedRemoteEvidenceCleanup(ports({
      claimCleanup: async () => {
        events.push("claim");
        return "claimed";
      },
      removeRemote: async () => {
        events.push("remove");
      },
      completeCleanup: async () => {
        events.push("complete");
      },
    }))).resolves.toBe("completed");
    expect(events).toEqual(["claim", "remove", "complete"]);
  });

  it("retains the intent and never removes when the claim is ambiguous", async () => {
    const cancelCleanup = vi.fn<TestPorts["cancelCleanup"]>();
    const removeRemote = vi.fn<TestPorts["removeRemote"]>();
    const completeCleanup = vi.fn<TestPorts["completeCleanup"]>();

    await expect(runClaimedRemoteEvidenceCleanup(ports({
      claimCleanup: async () => {
        throw new Error("claim response lost");
      },
      cancelCleanup,
      removeRemote,
      completeCleanup,
    }))).resolves.toBe("retained-claim-failed");
    expect(cancelCleanup).not.toHaveBeenCalled();
    expect(removeRemote).not.toHaveBeenCalled();
    expect(completeCleanup).not.toHaveBeenCalled();
  });

  it("retains a referenced intent when local cancellation fails", async () => {
    const removeRemote = vi.fn<TestPorts["removeRemote"]>();
    const completeCleanup = vi.fn<TestPorts["completeCleanup"]>();

    await expect(runClaimedRemoteEvidenceCleanup(ports({
      claimCleanup: async () => "referenced",
      cancelCleanup: async () => {
        throw new Error("local journal unavailable");
      },
      removeRemote,
      completeCleanup,
    }))).resolves.toBe("retained-cancellation-failed");
    expect(removeRemote).not.toHaveBeenCalled();
    expect(completeCleanup).not.toHaveBeenCalled();
  });

  it("retains a claimed intent when object removal fails", async () => {
    const completeCleanup = vi.fn<TestPorts["completeCleanup"]>();

    await expect(runClaimedRemoteEvidenceCleanup(ports({
      removeRemote: async () => {
        throw new Error("storage response lost");
      },
      completeCleanup,
    }))).resolves.toBe("retained-removal-failed");
    expect(completeCleanup).not.toHaveBeenCalled();
  });

  it("retains a claimed intent when completion fails after removal", async () => {
    const events: string[] = [];

    await expect(runClaimedRemoteEvidenceCleanup(ports({
      claimCleanup: async () => {
        events.push("claim");
        return "claimed";
      },
      removeRemote: async () => {
        events.push("remove");
      },
      completeCleanup: async () => {
        events.push("complete");
        throw new Error("completion response lost");
      },
    }))).resolves.toBe("retained-completion-failed");
    expect(events).toEqual(["claim", "remove", "complete"]);
  });
});
