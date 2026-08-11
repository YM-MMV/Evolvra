import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  claimPrivateEvidenceCleanup,
  CloudAccountErasureError,
  createLazySupabaseFacade,
  eraseConnectedAccount,
  erasePrivateEvidence,
  isStaleAccountErasureBackupError,
  readAccountErasureBackupBoundary,
  saveWorkspaceSnapshotWithDeadline,
} from "@/lib/supabase";

type Entry = { id: string | null; name: string };

const backupBoundary = {
  workspaceRevision: 7,
  evidenceRevision: 11,
};

describe("lazy Supabase boundary", () => {
  it("keeps the SDK behind a dynamic import outside the initial application graph", async () => {
    const source = await readFile(new URL("./supabase.ts", import.meta.url), "utf8");
    const eagerSdkImports = source.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("import ")
        && !trimmed.startsWith("import type ")
        && trimmed.includes("@supabase/supabase-js");
    });

    expect(eagerSdkImports).toEqual([]);
    expect(source).toContain('import("@supabase/supabase-js")');
  });

  it("defers fluent query execution and preserves the RPC contract", async () => {
    const events: string[] = [];
    const response = { data: { revision: 2 }, error: null };
    const builder = {
      select(columns: string) {
        events.push(`select:${columns}`);
        return builder;
      },
      eq(column: string, value: string) {
        events.push(`eq:${column}:${value}`);
        return builder;
      },
      maybeSingle() {
        events.push("maybeSingle");
        return Promise.resolve(response);
      },
    };
    const rpc = vi.fn(async () => response);
    const actual = {
      from(table: string) {
        events.push(`from:${table}`);
        return builder;
      },
      rpc,
    } as unknown as SupabaseClient;
    const load = vi.fn(async () => actual);
    const facade = createLazySupabaseFacade(load);

    const pending = facade
      .from("workspace_snapshots")
      .select("state,revision")
      .eq("user_id", "user-a")
      .maybeSingle();
    expect(events).toEqual([]);
    await expect(pending).resolves.toEqual(response);
    expect(events).toEqual([
      "from:workspace_snapshots",
      "select:state,revision",
      "eq:user_id:user-a",
      "maybeSingle",
    ]);

    await expect(facade.rpc("save_workspace_snapshot", { p_expected_revision: 1 }))
      .resolves.toEqual(response);
    expect(rpc).toHaveBeenCalledWith("save_workspace_snapshot", { p_expected_revision: 1 });
  });

  it("keeps fluent RPC abort signals available through the lazy facade", async () => {
    const response = { data: [{ revision: 3 }], error: null };
    const abortSignal = vi.fn(async (signal: AbortSignal) => {
      void signal;
      return response;
    });
    const rpc = vi.fn(() => ({ abortSignal }));
    const facade = createLazySupabaseFacade(async () => ({ rpc }) as unknown as SupabaseClient);
    const controller = new AbortController();

    await expect(facade
      .rpc("save_workspace_snapshot", { p_expected_revision: 2 })
      .abortSignal(controller.signal))
      .resolves.toEqual(response);
    expect(rpc).toHaveBeenCalledWith("save_workspace_snapshot", { p_expected_revision: 2 });
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });
});

describe("workspace snapshot deadline", () => {
  it("submits the expected revision through an abortable RPC", async () => {
    const response = { data: [{ revision: 4 }], error: null };
    const abortSignal = vi.fn(async (signal: AbortSignal) => {
      void signal;
      return response;
    });
    const rpc = vi.fn(() => ({ abortSignal }));
    const client = { rpc } as unknown as SupabaseClient;

    await expect(saveWorkspaceSnapshotWithDeadline(
      client,
      "00000000-0000-0000-0000-0000000000a1",
      { version: 3 },
      3,
    ))
      .resolves.toEqual(response);
    expect(rpc).toHaveBeenCalledWith("save_workspace_snapshot", {
      p_expected_account_id: "00000000-0000-0000-0000-0000000000a1",
      p_state: { version: 3 },
      p_expected_revision: 3,
    });
    expect(abortSignal.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("private evidence cleanup claims", () => {
  it.each([
    {
      label: "a single RPC row",
      data: { claimed: true, workspace_revision: 8 },
      expectedKind: "claimed" as const,
    },
    {
      label: "the first row of an RPC rowset",
      data: [{ claimed: false, workspace_revision: 9 }],
      expectedKind: "referenced" as const,
    },
  ])("parses $label and preserves the atomic path batch", async ({
    data,
    expectedKind,
  }) => {
    const rpc = vi.fn(async () => ({ data, error: null }));
    const client = { rpc } as unknown as SupabaseClient;
    const paths = [
      "account-1/goal-1/evidence-1/one.txt",
      "account-1/goal-1/evidence-2/two.txt",
    ];

    await expect(claimPrivateEvidenceCleanup(client, "account-1", paths))
      .resolves.toEqual({
        kind: expectedKind,
        workspaceRevision: expectedKind === "claimed" ? 8 : 9,
      });
    expect(rpc).toHaveBeenCalledWith("claim_evidence_cleanup", {
      p_expected_account_id: "account-1",
      p_remote_paths: paths,
    });
  });

  it("rejects empty or duplicate path batches before dispatch", async () => {
    const rpc = vi.fn();
    for (const paths of [
      [] as string[],
      ["account-1/goal-1/evidence-1/one.txt", "account-1/goal-1/evidence-1/one.txt"],
    ]) {
      await expect(claimPrivateEvidenceCleanup(
        { rpc } as unknown as SupabaseClient,
        "account-1",
        paths,
      )).rejects.toThrow(/non-empty unique path batch/i);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null, message: /did not return/i },
    { data: { claimed: "yes", workspace_revision: 1 }, error: null, message: /invalid evidence cleanup claim/i },
    { data: { claimed: true, workspace_revision: -1 }, error: null, message: /invalid cleanup workspace revision/i },
  ])("rejects malformed claim responses", async ({ data, error, message }) => {
    const client = {
      rpc: vi.fn(async () => ({ data, error })),
    } as unknown as SupabaseClient;
    await expect(claimPrivateEvidenceCleanup(
      client,
      "account-1",
      ["account-1/goal-1/evidence-1/one.txt"],
    )).rejects.toThrow(message);
  });

  it("surfaces an RPC failure without guessing whether the claim committed", async () => {
    const failure = new Error("transport unavailable");
    const client = {
      rpc: vi.fn(async () => ({ data: null, error: failure })),
    } as unknown as SupabaseClient;
    await expect(claimPrivateEvidenceCleanup(
      client,
      "account-1",
      ["account-1/goal-1/evidence-1/one.txt"],
    )).rejects.toBe(failure);
  });
});

function storageClient(tree: Map<string, Entry[]>, removeFiles = true, events?: string[]) {
  const list = vi.fn(async (folder: string, options: { limit: number; offset: number }) => ({
    data: (tree.get(folder) ?? []).slice(options.offset, options.offset + options.limit),
    error: null,
  }));
  const remove = vi.fn(async (paths: string[]) => {
    events?.push("remove-evidence");
    if (removeFiles) {
      paths.forEach((path) => {
        const separator = path.lastIndexOf("/");
        const folder = path.slice(0, separator);
        const name = path.slice(separator + 1);
        tree.set(folder, (tree.get(folder) ?? []).filter((entry) => entry.name !== name));
      });
    }
    return { data: [], error: null };
  });
  return {
    client: { storage: { from: () => ({ list, remove }) } } as unknown as SupabaseClient,
    list,
    remove,
  };
}

function authenticatedAs(
  accountId: string,
  getUser = vi.fn(async () => ({
    data: { user: { id: accountId } },
    error: null,
  })),
) {
  return { auth: { getUser }, getUser };
}

describe("readAccountErasureBackupBoundary", () => {
  it.each([
    {
      label: "a single RPC row",
      data: { workspace_revision: 7, evidence_revision: 11 },
    },
    {
      label: "the first row of an RPC rowset",
      data: [{ workspace_revision: 7, evidence_revision: 11 }],
    },
  ])("parses $label after verifying the authenticated account", async ({ data }) => {
    const events: string[] = [];
    const getUser = vi.fn(async () => {
      events.push("get-user");
      return { data: { user: { id: "account-1" } }, error: null };
    });
    const rpc = vi.fn(async () => {
      events.push("read-boundary");
      return { data, error: null };
    });
    const client = { auth: { getUser }, rpc } as unknown as SupabaseClient;

    await expect(readAccountErasureBackupBoundary(client, "account-1"))
      .resolves.toEqual(backupBoundary);
    expect(events).toEqual(["get-user", "read-boundary"]);
    expect(rpc).toHaveBeenCalledWith("read_account_erasure_backup_boundary", {
      p_expected_account_id: "account-1",
    });
  });

  it.each([
    { label: "a missing row", data: null, message: /did not return/i },
    {
      label: "a negative workspace revision",
      data: { workspace_revision: -1, evidence_revision: 11 },
      message: /invalid workspace revision/i,
    },
    {
      label: "a fractional evidence revision",
      data: { workspace_revision: 7, evidence_revision: 1.5 },
      message: /invalid evidence revision/i,
    },
    {
      label: "an unsafe workspace revision",
      data: { workspace_revision: Number.MAX_SAFE_INTEGER + 1, evidence_revision: 11 },
      message: /invalid workspace revision/i,
    },
  ])("rejects $label", async ({ data, message }) => {
    const rpc = vi.fn(async () => ({ data, error: null }));
    const { auth } = authenticatedAs("account-1");
    const client = { auth, rpc } as unknown as SupabaseClient;

    await expect(readAccountErasureBackupBoundary(client, "account-1"))
      .rejects.toThrow(message);
  });

  it("rejects the boundary RPC error without parsing its data", async () => {
    const rpcError = new Error("boundary unavailable");
    const rpc = vi.fn(async () => ({
      data: { workspace_revision: 7, evidence_revision: 11 },
      error: rpcError,
    }));
    const { auth } = authenticatedAs("account-1");
    const client = { auth, rpc } as unknown as SupabaseClient;

    await expect(readAccountErasureBackupBoundary(client, "account-1"))
      .rejects.toBe(rpcError);
  });

  it("does not read a boundary for a different live authenticated account", async () => {
    const rpc = vi.fn();
    const { auth } = authenticatedAs("account-2");
    const client = { auth, rpc } as unknown as SupabaseClient;

    await expect(readAccountErasureBackupBoundary(client, "account-1"))
      .rejects.toMatchObject({
        name: "CloudAccountErasureError",
        stage: "begin",
      } satisfies Partial<CloudAccountErasureError>);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("erasePrivateEvidence", () => {
  it("recursively removes and verifies every file beneath the account prefix", async () => {
    const tree = new Map<string, Entry[]>([
      ["account-1", [{ id: null, name: "goal-1" }, { id: null, name: "goal-2" }]],
      ["account-1/goal-1", [{ id: null, name: "evidence-1" }]],
      ["account-1/goal-1/evidence-1", [{ id: "file-1", name: "proof.pdf" }]],
      ["account-1/goal-2", [{ id: null, name: "evidence-2" }]],
      ["account-1/goal-2/evidence-2", [{ id: "file-2", name: "photo.png" }]],
    ]);
    const { client, remove } = storageClient(tree);
    await expect(erasePrivateEvidence(client, "account-1")).resolves.toBe(2);
    expect(remove).toHaveBeenCalledWith(expect.arrayContaining([
      "account-1/goal-1/evidence-1/proof.pdf",
      "account-1/goal-2/evidence-2/photo.png",
    ]));
  });

  it("stops account deletion when Storage reports success but files remain", async () => {
    const tree = new Map<string, Entry[]>([
      ["account-1", [{ id: "file-1", name: "proof.pdf" }]],
    ]);
    const { client } = storageClient(tree, false);
    await expect(erasePrivateEvidence(client, "account-1")).rejects.toThrow(/file remains/i);
  });
});

describe("eraseConnectedAccount", () => {
  it("recognises only the authoritative stale-backup begin conflict", () => {
    expect(isStaleAccountErasureBackupError(new CloudAccountErasureError(
      "begin",
      "stale",
      { code: "PT409", message: "account_erasure_backup_stale" },
    ))).toBe(true);
    expect(isStaleAccountErasureBackupError(new CloudAccountErasureError(
      "begin",
      "network",
      { code: "500", message: "connection lost" },
    ))).toBe(false);
    expect(isStaleAccountErasureBackupError(new CloudAccountErasureError(
      "account",
      "late",
      { code: "PT409", message: "account_erasure_backup_stale" },
    ))).toBe(false);
  });

  it("fences uploads before the Storage sweep and finalizes only after verification", async () => {
    const events: string[] = [];
    const tree = new Map<string, Entry[]>([
      ["account-1", [{ id: "file-1", name: "proof.pdf" }]],
    ]);
    const { client: storageOnly } = storageClient(tree, true, events);
    const rpc = vi.fn(async (name: string) => {
      events.push(name);
      return { data: null, error: null };
    });
    const { auth } = authenticatedAs("account-1");
    const client = { ...storageOnly, auth, rpc } as unknown as SupabaseClient;

    await expect(eraseConnectedAccount(client, "account-1", { backupBoundary }))
      .resolves.toBe(1);
    expect(events).toEqual([
      "begin_account_deletion",
      "remove-evidence",
      "delete_my_account",
    ]);
    expect(rpc).toHaveBeenNthCalledWith(1, "begin_account_deletion", {
      p_expected_account_id: "account-1",
      p_expected_workspace_revision: 7,
      p_expected_evidence_revision: 11,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "delete_my_account", {
      p_expected_account_id: "account-1",
    });
  });

  it("does not finalize the account when Storage verification fails", async () => {
    const tree = new Map<string, Entry[]>([
      ["account-1", [{ id: "file-1", name: "proof.pdf" }]],
    ]);
    const { client: storageOnly } = storageClient(tree, false);
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const { auth } = authenticatedAs("account-1");
    const client = { ...storageOnly, auth, rpc } as unknown as SupabaseClient;

    await expect(eraseConnectedAccount(client, "account-1", { backupBoundary }))
      .rejects.toMatchObject({
      name: "CloudAccountErasureError",
      stage: "evidence",
    } satisfies Partial<CloudAccountErasureError>);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("begin_account_deletion", {
      p_expected_account_id: "account-1",
      p_expected_workspace_revision: 7,
      p_expected_evidence_revision: 11,
    });
  });

  it("checkpoints local cleanup before final deletion and marks a lost response as ambiguous", async () => {
    const tree = new Map<string, Entry[]>();
    const { client: storageOnly } = storageClient(tree, true);
    const checkpoint = vi.fn(async () => undefined);
    const rpc = vi.fn(async (name: string) => {
      if (name === "delete_my_account") throw new Error("response lost");
      return { data: null, error: null };
    });
    const { auth } = authenticatedAs("account-1");
    const client = { ...storageOnly, auth, rpc } as unknown as SupabaseClient;

    await expect(eraseConnectedAccount(client, "account-1", {
      backupBoundary,
      onFinalDeletionStarting: checkpoint,
    })).rejects.toMatchObject({
      name: "CloudAccountErasureError",
      stage: "account",
      accountDeletionMayHaveSucceeded: true,
    } satisfies Partial<CloudAccountErasureError>);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(checkpoint.mock.invocationCallOrder[0]).toBeLessThan(
      rpc.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("does not treat a returned finalization error as an ambiguous commit", async () => {
    const tree = new Map<string, Entry[]>();
    const { client: storageOnly } = storageClient(tree, true);
    const rpc = vi.fn(async (name: string) => ({
      data: null,
      error: name === "delete_my_account" ? new Error("transaction rejected") : null,
    }));
    const { auth } = authenticatedAs("account-1");
    const client = { ...storageOnly, auth, rpc } as unknown as SupabaseClient;

    await expect(eraseConnectedAccount(client, "account-1", { backupBoundary }))
      .rejects.toMatchObject({
      stage: "account",
      accountDeletionMayHaveSucceeded: false,
    } satisfies Partial<CloudAccountErasureError>);
  });

  it("does not attempt final deletion when its durable checkpoint fails", async () => {
    const tree = new Map<string, Entry[]>();
    const { client: storageOnly } = storageClient(tree, true);
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const { auth } = authenticatedAs("account-1");
    const client = { ...storageOnly, auth, rpc } as unknown as SupabaseClient;

    await expect(eraseConnectedAccount(client, "account-1", {
      backupBoundary,
      onFinalDeletionStarting: () => { throw new Error("storage blocked"); },
    })).rejects.toMatchObject({
      stage: "account",
      accountDeletionMayHaveSucceeded: false,
    } satisfies Partial<CloudAccountErasureError>);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("begin_account_deletion", {
      p_expected_account_id: "account-1",
      p_expected_workspace_revision: 7,
      p_expected_evidence_revision: 11,
    });
  });

  it("awaits durable finalization bookkeeping before invoking the final RPC", async () => {
    const tree = new Map<string, Entry[]>();
    const { client: storageOnly } = storageClient(tree, true);
    let releaseCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const { auth } = authenticatedAs("account-1");
    const client = { ...storageOnly, auth, rpc } as unknown as SupabaseClient;

    const erasing = eraseConnectedAccount(client, "account-1", {
      backupBoundary,
      onFinalDeletionStarting: () => checkpoint,
    });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc).not.toHaveBeenCalledWith("delete_my_account", expect.anything());

    releaseCheckpoint();
    await expect(erasing).resolves.toBe(0);
    expect(rpc).toHaveBeenLastCalledWith("delete_my_account", {
      p_expected_account_id: "account-1",
    });
  });

  it("stops when the live authenticated UUID changes between stages", async () => {
    const tree = new Map<string, Entry[]>();
    const { client: storageOnly } = storageClient(tree, true);
    const getUser = vi.fn()
      .mockResolvedValueOnce({ data: { user: { id: "account-1" } }, error: null })
      .mockResolvedValueOnce({ data: { user: { id: "account-2" } }, error: null });
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const client = {
      ...storageOnly,
      auth: { getUser },
      rpc,
    } as unknown as SupabaseClient;

    await expect(eraseConnectedAccount(client, "account-1", { backupBoundary }))
      .rejects.toMatchObject({
      stage: "evidence",
      accountDeletionMayHaveSucceeded: false,
    } satisfies Partial<CloudAccountErasureError>);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("begin_account_deletion", {
      p_expected_account_id: "account-1",
      p_expected_workspace_revision: 7,
      p_expected_evidence_revision: 11,
    });
  });

  it("treats a resolved PostgREST status-zero final response as ambiguous", async () => {
    const tree = new Map<string, Entry[]>();
    const { client: storageOnly } = storageClient(tree, true);
    const rpc = vi.fn(async (name: string) => name === "delete_my_account"
      ? {
        data: null,
        error: { code: "", message: "TypeError: response lost" },
        status: 0,
      }
      : { data: null, error: null, status: 204 });
    const { auth } = authenticatedAs("account-1");
    const client = { ...storageOnly, auth, rpc } as unknown as SupabaseClient;

    await expect(eraseConnectedAccount(client, "account-1", { backupBoundary }))
      .rejects.toMatchObject({
      stage: "account",
      accountDeletionMayHaveSucceeded: true,
      responseStatus: 0,
      transportFailure: true,
    } satisfies Partial<CloudAccountErasureError>);
  });
});
