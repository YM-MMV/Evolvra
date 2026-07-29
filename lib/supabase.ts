import type { SupabaseClient } from "@supabase/supabase-js";

let clientPromise: Promise<SupabaseClient> | null = null;
let lazyClient: SupabaseClient | null = null;

export interface CloudUser {
  id: string;
  email?: string;
}

export type CloudAccountErasureStage = "begin" | "evidence" | "account";

export class CloudAccountErasureError extends Error {
  readonly stage: CloudAccountErasureStage;
  readonly cause?: unknown;
  readonly accountDeletionMayHaveSucceeded: boolean;
  readonly responseStatus: number | null;
  readonly transportFailure: boolean;

  constructor(
    stage: CloudAccountErasureStage,
    message: string,
    cause?: unknown,
    accountDeletionMayHaveSucceeded = false,
    responseStatus: number | null = null,
    transportFailure = false,
  ) {
    super(message);
    this.name = "CloudAccountErasureError";
    this.stage = stage;
    this.cause = cause;
    this.accountDeletionMayHaveSucceeded = accountDeletionMayHaveSucceeded;
    this.responseStatus = responseStatus;
    this.transportFailure = transportFailure;
  }
}

export const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

export const WORKSPACE_SNAPSHOT_RPC_TIMEOUT_MS = 10_000;

function configuredClient(): Promise<SupabaseClient> {
  if (!supabaseConfigured) {
    return Promise.reject(new Error("Add Supabase environment variables first."));
  }
  if (clientPromise) return clientPromise;
  const loading = import("@supabase/supabase-js").then(({ createClient }) => createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    },
  ));
  clientPromise = loading;
  void loading.catch(() => {
    if (clientPromise === loading) clientPromise = null;
  });
  return loading;
}

export function loadSupabaseClient(): Promise<SupabaseClient | null> {
  return supabaseConfigured ? configuredClient() : Promise.resolve(null);
}

type DeferredValue = { value: unknown };

/**
 * Supabase query and Storage builders are thenable themselves. Boxing each
 * intermediate value prevents Promise resolution from executing a request
 * before the caller has finished adding filters or options.
 */
function deferredBuilder<T>(load: () => Promise<DeferredValue>): T {
  const execute = () => load().then(({ value }) => value);
  return new Proxy(function deferredTarget() {}, {
    get(_target, property) {
      if (property === "then") {
        return (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => execute().then(onFulfilled, onRejected);
      }
      return (...args: unknown[]) => deferredBuilder(async () => {
        const { value } = await load();
        if ((typeof value !== "object" && typeof value !== "function") || value === null) {
          throw new Error("The deferred cloud operation returned an invalid builder.");
        }
        const member = Reflect.get(value, property);
        if (typeof member !== "function") {
          throw new Error(`The deferred cloud builder has no ${String(property)} method.`);
        }
        return { value: Reflect.apply(member, value, args) };
      });
    },
  }) as unknown as T;
}

export function createLazySupabaseFacade(
  loadClient: () => Promise<SupabaseClient>,
): SupabaseClient {
  const invokeClient = <T,>(
    operation: (client: SupabaseClient) => PromiseLike<T> | T,
  ): Promise<T> => loadClient().then(operation);
  const facade = {
    rpc: (...args: unknown[]) => deferredBuilder(async () => {
      const client = await loadClient();
      return { value: Reflect.apply(client.rpc, client, args) };
    }),
    from: (...args: unknown[]) => deferredBuilder(async () => {
      const client = await loadClient();
      return { value: Reflect.apply(client.from, client, args) };
    }),
    storage: {
      from: (...args: unknown[]) => deferredBuilder(async () => {
        const client = await loadClient();
        return { value: Reflect.apply(client.storage.from, client.storage, args) };
      }),
    },
    auth: {
      getSession: () => invokeClient((client) => client.auth.getSession()),
      getUser: () => invokeClient((client) => client.auth.getUser()),
      signInWithOtp: (...args: unknown[]) => invokeClient((client) =>
        Reflect.apply(client.auth.signInWithOtp, client.auth, args)),
      signOut: (...args: unknown[]) => invokeClient((client) =>
        Reflect.apply(client.auth.signOut, client.auth, args)),
      onAuthStateChange: (callback: Parameters<SupabaseClient["auth"]["onAuthStateChange"]>[0]) => {
        let unsubscribeRequested = false;
        let unsubscribeReal: (() => void) | null = null;
        void loadClient().then((client) => {
          const { data } = client.auth.onAuthStateChange(callback);
          unsubscribeReal = () => data.subscription.unsubscribe();
          if (unsubscribeRequested) unsubscribeReal();
        }).catch(() => {
          // getSession surfaces the same loader failure to the provider. This
          // branch only prevents a second unhandled rejection from registration.
        });
        return {
          data: {
            subscription: {
              unsubscribe() {
                unsubscribeRequested = true;
                unsubscribeReal?.();
              },
            },
          },
        };
      },
    },
  };
  return facade as unknown as SupabaseClient;
}

export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  lazyClient ??= createLazySupabaseFacade(configuredClient);
  return lazyClient;
}

/**
 * Bounds a compare-and-swap round trip without pretending an aborted response
 * means the database did not commit. Callers reconcile the remote revision
 * after any thrown transport outcome.
 */
export async function saveWorkspaceSnapshotWithDeadline(
  supabase: SupabaseClient,
  state: unknown,
  expectedRevision: number,
  timeoutMs = WORKSPACE_SNAPSHOT_RPC_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await supabase
      .rpc("save_workspace_snapshot", {
        p_state: state,
        p_expected_revision: expectedRevision,
      })
      .abortSignal(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function listPrivateEvidencePaths(supabase: SupabaseClient, accountId: string) {
  const bucket = supabase.storage.from("evidence");
  const pendingFolders = [accountId];
  const visitedFolders = new Set<string>();
  const paths: string[] = [];

  while (pendingFolders.length) {
    const folder = pendingFolders.pop()!;
    if (visitedFolders.has(folder)) continue;
    visitedFolders.add(folder);
    let offset = 0;
    while (true) {
      const { data, error } = await bucket.list(folder, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`Private evidence could not be listed: ${error.message}`);
      const entries = data ?? [];
      for (const entry of entries) {
        const path = `${folder}/${entry.name}`;
        if (entry.id === null) pendingFolders.push(path);
        else paths.push(path);
      }
      if (entries.length < 100) break;
      offset += entries.length;
    }
  }

  return paths;
}

/** Removes bytes through the Storage API, then verifies the account prefix is empty. */
export async function erasePrivateEvidence(supabase: SupabaseClient, accountId: string) {
  const paths = await listPrivateEvidencePaths(supabase, accountId);
  const bucket = supabase.storage.from("evidence");
  for (let index = 0; index < paths.length; index += 1_000) {
    const { error } = await bucket.remove(paths.slice(index, index + 1_000));
    if (error) throw new Error(`Private evidence could not be erased: ${error.message}`);
  }
  const remaining = await listPrivateEvidencePaths(supabase, accountId);
  if (remaining.length) throw new Error(`${remaining.length} private evidence file${remaining.length === 1 ? " remains" : "s remain"}; account deletion was stopped.`);
  return paths.length;
}

function erasureFailure(
  stage: CloudAccountErasureStage,
  fallback: string,
  cause: unknown,
  accountDeletionMayHaveSucceeded = false,
  responseStatus: number | null = null,
  transportFailure = false,
) {
  const message = typeof cause === "object" && cause && "message" in cause
    ? String(cause.message)
    : fallback;
  return new CloudAccountErasureError(
    stage,
    message,
    cause,
    accountDeletionMayHaveSucceeded,
    responseStatus,
    transportFailure,
  );
}

async function requireExactAuthenticatedAccount(
  supabase: SupabaseClient,
  expectedAccountId: string,
  stage: CloudAccountErasureStage,
) {
  let response: Awaited<ReturnType<SupabaseClient["auth"]["getUser"]>>;
  try {
    response = await supabase.auth.getUser();
  } catch (error) {
    throw erasureFailure(
      stage,
      "The live authenticated account could not be verified.",
      error,
    );
  }
  if (response.error) {
    throw erasureFailure(
      stage,
      "The live authenticated account could not be verified.",
      response.error,
    );
  }
  if (!response.data.user || response.data.user.id !== expectedAccountId) {
    throw erasureFailure(
      stage,
      "The authenticated account changed during erasure. No other account was touched.",
      new Error("account_identity_mismatch"),
    );
  }
}

export interface EraseConnectedAccountOptions {
  /** Persist a durable local-cleanup checkpoint before the final RPC starts. */
  onFinalDeletionStarting?: () => void | Promise<void>;
}

/**
 * Fences new evidence writes, removes and verifies Storage bytes through the
 * supported API, then asks the database to delete the authenticated account.
 */
export async function eraseConnectedAccount(
  supabase: SupabaseClient,
  accountId: string,
  options: EraseConnectedAccountOptions = {},
) {
  await requireExactAuthenticatedAccount(supabase, accountId, "begin");
  let beginError: unknown;
  try {
    ({ error: beginError } = await supabase.rpc("begin_account_deletion", {
      p_expected_account_id: accountId,
    }));
  } catch (error) {
    beginError = error;
  }
  if (beginError) {
    throw erasureFailure(
      "begin",
      "Account erasure could not be started safely.",
      beginError,
    );
  }

  let erasedEvidenceCount: number;
  try {
    await requireExactAuthenticatedAccount(supabase, accountId, "evidence");
    erasedEvidenceCount = await erasePrivateEvidence(supabase, accountId);
  } catch (error) {
    throw erasureFailure(
      "evidence",
      "Private evidence could not be erased and verified.",
      error,
    );
  }

  try {
    await requireExactAuthenticatedAccount(supabase, accountId, "account");
    await options.onFinalDeletionStarting?.();
  } catch (error) {
    throw erasureFailure(
      "account",
      "A durable device-cleanup checkpoint could not be saved, so final account deletion was not attempted.",
      error,
    );
  }

  let accountError: unknown;
  let accountResponseStatus: number | null = null;
  let accountDeletionMayHaveSucceeded = false;
  let transportFailure = false;
  try {
    const response = await supabase.rpc("delete_my_account", {
      p_expected_account_id: accountId,
    });
    accountError = response.error;
    accountResponseStatus = typeof response.status === "number" ? response.status : null;
    // PostgREST resolves fetch failures as an error response with status zero.
    // The database may have committed before the response was lost.
    if (accountError && accountResponseStatus === 0) {
      accountDeletionMayHaveSucceeded = true;
      transportFailure = true;
    }
  } catch (error) {
    accountError = error;
    // The request may have committed even though its response was lost.
    accountDeletionMayHaveSucceeded = true;
    transportFailure = true;
  }
  if (accountError) {
    throw erasureFailure(
      "account",
      "The final account deletion step did not finish.",
      accountError,
      accountDeletionMayHaveSucceeded,
      accountResponseStatus,
      transportFailure,
    );
  }
  return erasedEvidenceCount;
}
