import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CloudAccountErasureError,
  createLazySupabaseFacade,
  eraseConnectedAccount,
  erasePrivateEvidence,
  saveWorkspaceSnapshotWithDeadline,
} from "@/lib/supabase";

type Entry = { id: string | null; name: string };

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

    await expect(saveWorkspaceSnapshotWithDeadline(client, { version: 3 }, 3))
      .resolves.toEqual(response);
    expect(rpc).toHaveBeenCalledWith("save_workspace_snapshot", {
      p_state: { version: 3 },
      p_expected_revision: 3,
    });
    expect(abortSignal.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
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

    await expect(eraseConnectedAccount(client, "account-1")).resolves.toBe(1);
    expect(events).toEqual([
      "begin_account_deletion",
      "remove-evidence",
      "delete_my_account",
    ]);
    expect(rpc).toHaveBeenNthCalledWith(1, "begin_account_deletion", {
      p_expected_account_id: "account-1",
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

    await expect(eraseConnectedAccount(client, "account-1")).rejects.toMatchObject({
      name: "CloudAccountErasureError",
      stage: "evidence",
    } satisfies Partial<CloudAccountErasureError>);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("begin_account_deletion", {
      p_expected_account_id: "account-1",
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

    await expect(eraseConnectedAccount(client, "account-1")).rejects.toMatchObject({
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
      onFinalDeletionStarting: () => { throw new Error("storage blocked"); },
    })).rejects.toMatchObject({
      stage: "account",
      accountDeletionMayHaveSucceeded: false,
    } satisfies Partial<CloudAccountErasureError>);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("begin_account_deletion", {
      p_expected_account_id: "account-1",
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

    await expect(eraseConnectedAccount(client, "account-1")).rejects.toMatchObject({
      stage: "evidence",
      accountDeletionMayHaveSucceeded: false,
    } satisfies Partial<CloudAccountErasureError>);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("begin_account_deletion", {
      p_expected_account_id: "account-1",
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

    await expect(eraseConnectedAccount(client, "account-1")).rejects.toMatchObject({
      stage: "account",
      accountDeletionMayHaveSucceeded: true,
      responseStatus: 0,
      transportFailure: true,
    } satisfies Partial<CloudAccountErasureError>);
  });
});
