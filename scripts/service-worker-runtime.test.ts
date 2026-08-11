import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type RequestLike = {
  url: string;
  method: string;
  headers: Headers;
  mode: string;
  destination: string;
};

type WorkerCacheStores = Map<string, Map<string, Response>>;

type WorkerRuntime = {
  listeners: Map<string, (event: Record<string, unknown>) => void>;
  caches: CacheStorage;
  lifecycle: {
    claimedClients: number;
    skipWaitingCalls: number;
    clientMessages: unknown[];
    clientMatchOptions: unknown[];
    clientNavigations: Array<{ id: string; url: string }>;
  };
  test: {
    navigationStrategy: (request: RequestLike) => Promise<Response>;
    staticAssetStrategy: (request: RequestLike) => Promise<Response>;
    syncWorkspaceGoalRoutes: (paths: unknown) => Promise<{
      accepted: boolean;
      requested: number;
      cached: number;
      failed: number;
      cancelled?: boolean;
    }>;
    syncClientWorkspaceGoalRoutes: (
      source: { id: string; type: "window" },
      paths: unknown,
    ) => Promise<{
      accepted: boolean;
      reason?: string;
      clientRequested: number;
      requested: number;
      cached: number;
      failed: number;
      cancelled?: boolean;
    }>;
    installPrecache: () => Promise<void>;
    PRECACHE_NAME: string;
    NAVIGATION_CACHE_NAME: string;
    WORKSPACE_ROUTES_CACHE_NAME: string;
    WORKSPACE_MANIFEST_CACHE_NAME: string;
    BUILD_ASSET_CACHE_NAME: string;
    STATIC_CACHE_NAME: string;
    MAX_WORKSPACE_GOAL_ROUTES: number;
    MAX_WORKSPACE_ROUTE_UNION: number;
    WORKER_VERSION: string;
  };
};

function request(path: string, destination = "document", mode = destination === "document" ? "navigate" : "no-cors"): RequestLike {
  return {
    url: `https://evolvra.test${path}`,
    method: "GET",
    headers: new Headers(),
    mode,
    destination,
  };
}

function createRuntime(
  fetchImplementation: (input: Request | RequestLike) => Promise<Response>,
  liveClientIds = ["client-a"],
  stores: WorkerCacheStores = new Map(),
): WorkerRuntime {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const lifecycle: WorkerRuntime["lifecycle"] = {
    claimedClients: 0,
    skipWaitingCalls: 0,
    clientMessages: [],
    clientMatchOptions: [],
    clientNavigations: [],
  };
  const key = (input: RequestInfo | URL | RequestLike) => typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const cacheStorage = {
    async open(name: string) {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        async match(input: RequestInfo | URL) { return store.get(key(input))?.clone(); },
        async put(input: RequestInfo | URL, response: Response) { store.set(key(input), response.clone()); },
        async delete(input: RequestInfo | URL) { return store.delete(key(input)); },
        async keys() { return [...store.keys()].map((url) => new Request(url)); },
      };
    },
    async match(input: RequestInfo | URL, options?: MultiCacheQueryOptions) {
      if (options?.cacheName) return stores.get(options.cacheName)?.get(key(input))?.clone();
      for (const store of stores.values()) {
        const response = store.get(key(input));
        if (response) return response.clone();
      }
      return undefined;
    },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async has(name: string) { return stores.has(name); },
  } as unknown as CacheStorage;
  const workerSelf = {
    location: { origin: "https://evolvra.test" },
    clients: {
      claim: async () => { lifecycle.claimedClients += 1; },
      matchAll: async (options: unknown) => {
        lifecycle.clientMatchOptions.push(options);
        return liveClientIds.map((id) => ({
          id,
          type: "window",
          url: `https://evolvra.test/open/${id}`,
          postMessage: (message: unknown) => lifecycle.clientMessages.push(message),
          navigate: async (url: string) => {
            lifecycle.clientNavigations.push({ id, url });
            return null;
          },
        }));
      },
    },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) { listeners.set(type, listener); },
    skipWaiting: async () => { lifecycle.skipWaitingCalls += 1; },
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    Set,
    Map,
    Promise,
    console,
    self: workerSelf,
    caches: cacheStorage,
    fetch: fetchImplementation,
  });
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  vm.runInContext(`${source}\nglobalThis.__swTest = { navigationStrategy, staticAssetStrategy, syncWorkspaceGoalRoutes, syncClientWorkspaceGoalRoutes, installPrecache, PRECACHE_NAME, NAVIGATION_CACHE_NAME, WORKSPACE_ROUTES_CACHE_NAME, WORKSPACE_MANIFEST_CACHE_NAME, BUILD_ASSET_CACHE_NAME, STATIC_CACHE_NAME, MAX_WORKSPACE_GOAL_ROUTES, MAX_WORKSPACE_ROUTE_UNION, WORKER_VERSION };`, context);
  return {
    listeners,
    caches: cacheStorage,
    lifecycle,
    test: (context as unknown as { __swTest: WorkerRuntime["test"] }).__swTest,
  };
}

describe("service worker runtime safety", () => {
  it("keeps the SKIP_WAITING request alive until update activation starts", async () => {
    const runtime = createRuntime(async () => new Response("unused"));
    const listener = runtime.listeners.get("message");
    let lifetime: Promise<unknown> | null = null;

    listener?.({
      data: { type: "SKIP_WAITING" },
      waitUntil: (promise: Promise<unknown>) => { lifetime = promise; },
    });

    expect(lifetime).not.toBeNull();
    await lifetime;
    expect(runtime.lifecycle.skipWaitingCalls).toBe(1);
  });

  it("claims clients, removes only old Evolvra caches, and announces activation", async () => {
    const runtime = createRuntime(async () => new Response("unused"));
    await runtime.caches.open("evolvra-precache-old");
    await runtime.caches.open(runtime.test.STATIC_CACHE_NAME);
    await runtime.caches.open("another-app-cache");
    const listener = runtime.listeners.get("activate");
    let lifetime: Promise<unknown> | null = null;

    listener?.({
      waitUntil: (promise: Promise<unknown>) => { lifetime = promise; },
    });
    expect(lifetime).not.toBeNull();
    await lifetime;

    expect(await runtime.caches.has("evolvra-precache-old")).toBe(false);
    expect(await runtime.caches.has(runtime.test.STATIC_CACHE_NAME)).toBe(true);
    expect(await runtime.caches.has("another-app-cache")).toBe(true);
    expect(runtime.lifecycle.claimedClients).toBe(1);
    expect(runtime.lifecycle.clientMatchOptions).toEqual([{
      type: "window",
      includeUncontrolled: true,
    }]);
    expect(runtime.lifecycle.clientMessages).toEqual([{
      type: "EVOLVRA_OFFLINE_READY",
      version: runtime.test.WORKER_VERSION,
    }]);
    expect(runtime.lifecycle.clientNavigations).toEqual([]);
  });

  it("navigates every open tab when a user-approved update activates", async () => {
    const stores: WorkerCacheStores = new Map();
    const waitingRuntime = createRuntime(
      async () => new Response("unused"),
      ["client-a", "client-b"],
      stores,
    );
    const messageListener = waitingRuntime.listeners.get("message");
    let skipLifetime: Promise<unknown> | null = null;

    messageListener?.({
      data: { type: "SKIP_WAITING" },
      waitUntil: (promise: Promise<unknown>) => { skipLifetime = promise; },
    });
    await skipLifetime;

    // Activation may run in a new worker global after the browser terminates
    // the waiting worker. Only the shared persistent CacheStorage survives.
    const activeRuntime = createRuntime(
      async () => new Response("unused"),
      ["client-a", "client-b"],
      stores,
    );
    const activateListener = activeRuntime.listeners.get("activate");
    let activationLifetime: Promise<unknown> | null = null;
    activateListener?.({
      waitUntil: (promise: Promise<unknown>) => { activationLifetime = promise; },
    });
    await activationLifetime;

    expect(waitingRuntime.lifecycle.clientNavigations).toEqual([]);
    expect(activeRuntime.lifecycle.clientNavigations).toEqual([
      { id: "client-a", url: "https://evolvra.test/open/client-a" },
      { id: "client-b", url: "https://evolvra.test/open/client-b" },
    ]);
    expect(activeRuntime.lifecycle.clientMatchOptions).toEqual([
      { type: "window", includeUncontrolled: true },
      { type: "window", includeUncontrolled: true },
    ]);
  });

  it("synchronizes a bounded exact set of declared workspace goals", async () => {
    const fetched: string[] = [];
    const runtime = createRuntime(async (input) => {
      fetched.push(input.url);
      return new Response(`shell for ${new URL(input.url).pathname}`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    const listener = runtime.listeners.get("message");
    let lifetime: Promise<unknown> | null = null;
    const replies: unknown[] = [];

    listener?.({
      data: {
        type: "SYNC_WORKSPACE_GOAL_ROUTES",
        paths: ["/goals/current-one", "/goals/current-two", "/goals/current-one"],
      },
      source: { id: "client-a", type: "window" },
      ports: [{ postMessage: (message: unknown) => replies.push(message) }],
      waitUntil: (promise: Promise<unknown>) => { lifetime = promise; },
    });
    expect(lifetime).not.toBeNull();
    await lifetime;

    expect(fetched).toEqual([
      "https://evolvra.test/goals/current-one",
      "https://evolvra.test/goals/current-two",
    ]);
    const cache = await runtime.caches.open(runtime.test.WORKSPACE_ROUTES_CACHE_NAME);
    expect(await (await cache.match(new Request("https://evolvra.test/goals/current-one")))?.text())
      .toBe("shell for /goals/current-one");
    expect(await (await cache.match(new Request("https://evolvra.test/goals/current-two")))?.text())
      .toBe("shell for /goals/current-two");
    expect(replies).toEqual([{
      type: "WORKSPACE_GOAL_ROUTES_SYNCED",
      accepted: true,
      clientRequested: 2,
      requested: 2,
      cached: 2,
      failed: 0,
      cancelled: false,
    }]);
  });

  it("keeps the bounded union of live client manifests so one tab cannot erase another", async () => {
    const runtime = createRuntime(async (input) => new Response(
      `shell for ${new URL(input.url).pathname}`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    ), ["client-a", "client-b"]);
    const clientA = { id: "client-a", type: "window" as const };
    const clientB = { id: "client-b", type: "window" as const };

    expect(await runtime.test.syncClientWorkspaceGoalRoutes(clientA, ["/goals/a"]))
      .toMatchObject({ accepted: true, clientRequested: 1, requested: 1, cached: 1 });
    expect(await runtime.test.syncClientWorkspaceGoalRoutes(clientB, ["/goals/b"]))
      .toMatchObject({ accepted: true, clientRequested: 1, requested: 2, cached: 2 });

    const routeCache = await runtime.caches.open(runtime.test.WORKSPACE_ROUTES_CACHE_NAME);
    expect(await routeCache.match(new Request("https://evolvra.test/goals/a"))).toBeDefined();
    expect(await routeCache.match(new Request("https://evolvra.test/goals/b"))).toBeDefined();

    expect(await runtime.test.syncClientWorkspaceGoalRoutes(clientA, []))
      .toMatchObject({ accepted: true, clientRequested: 0, requested: 1, cached: 1 });
    expect(await routeCache.match(new Request("https://evolvra.test/goals/a"))).toBeUndefined();
    expect(await routeCache.match(new Request("https://evolvra.test/goals/b"))).toBeDefined();
  });

  it("rejects route manifests that are not attributable to an exact window client", async () => {
    const runtime = createRuntime(async () => new Response("unexpected"));

    expect(await runtime.test.syncClientWorkspaceGoalRoutes(
      { id: "", type: "window" },
      ["/goals/a"],
    )).toMatchObject({
      accepted: false,
      reason: "invalid-client",
      clientRequested: 0,
    });
  });

  it("carries the persisted route union into an empty worker generation before activation", async () => {
    const runtime = createRuntime(async (input) => {
      const pathname = new URL(input.url).pathname;
      if (pathname.endsWith(".png")) {
        return new Response("png", { status: 200, headers: { "content-type": "image/png" } });
      }
      if (pathname.endsWith(".svg")) {
        return new Response("<svg />", { status: 200, headers: { "content-type": "image/svg+xml" } });
      }
      if (pathname.endsWith(".webmanifest")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/manifest+json" } });
      }
      return new Response(`shell for ${pathname}`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    await runtime.test.syncClientWorkspaceGoalRoutes(
      { id: "client-a", type: "window" },
      ["/goals/carried"],
    );
    await runtime.caches.delete(runtime.test.WORKSPACE_ROUTES_CACHE_NAME);

    await runtime.test.installPrecache();

    const routeCache = await runtime.caches.open(runtime.test.WORKSPACE_ROUTES_CACHE_NAME);
    expect(await (await routeCache.match(new Request("https://evolvra.test/goals/carried")))?.text())
      .toBe("shell for /goals/carried");
  });

  it.each([
    ["/api/workspace"],
    ["/auth/callback"],
    ["/goals/current?token=secret"],
    ["https://attacker.test/goals/current"],
    ["/goals/current/extra"],
  ])("rejects an unsafe workspace route manifest containing %s", async (unsafePath) => {
    let fetches = 0;
    const runtime = createRuntime(async () => {
      fetches += 1;
      return new Response("unexpected", { headers: { "content-type": "text/html" } });
    });
    const result = await runtime.test.syncWorkspaceGoalRoutes(["/goals/safe", unsafePath]);

    expect(result.accepted).toBe(false);
    expect(fetches).toBe(0);
    const cache = await runtime.caches.open(runtime.test.WORKSPACE_ROUTES_CACHE_NAME);
    expect(await cache.keys()).toEqual([]);
  });

  it("rejects a workspace route manifest above the schema bound", async () => {
    let fetches = 0;
    const runtime = createRuntime(async () => {
      fetches += 1;
      return new Response("unexpected", { headers: { "content-type": "text/html" } });
    });
    const paths = Array.from(
      { length: runtime.test.MAX_WORKSPACE_GOAL_ROUTES + 1 },
      (_, index) => `/goals/${index}`,
    );

    expect((await runtime.test.syncWorkspaceGoalRoutes(paths)).accepted).toBe(false);
    expect(fetches).toBe(0);
  });

  it("replaces stale declared goal routes without caching a failing response", async () => {
    const runtime = createRuntime(async (input) => {
      const path = new URL(input.url).pathname;
      if (path === "/goals/failing") {
        return new Response("<html>missing</html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(`shell for ${path}`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    await runtime.test.syncWorkspaceGoalRoutes(["/goals/old"]);
    const result = await runtime.test.syncWorkspaceGoalRoutes(["/goals/current", "/goals/failing"]);
    const cache = await runtime.caches.open(runtime.test.WORKSPACE_ROUTES_CACHE_NAME);

    expect(result).toEqual({
      accepted: true,
      requested: 2,
      cached: 1,
      failed: 1,
      cancelled: false,
    });
    expect(await cache.match(new Request("https://evolvra.test/goals/old"))).toBeUndefined();
    expect(await cache.match(new Request("https://evolvra.test/goals/failing"))).toBeUndefined();
    expect(await (await cache.match(new Request("https://evolvra.test/goals/current")))?.text())
      .toBe("shell for /goals/current");
  });

  it("does not publish a goal document whose discovered build asset is missing or HTML", async () => {
    const runtime = createRuntime(async (input) => {
      const path = new URL(input.url).pathname;
      if (path === "/goals/current") {
        return new Response('<script src="/_next/static/missing.js"></script>', {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("<html>not a script</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    expect(await runtime.test.syncWorkspaceGoalRoutes(["/goals/current"])).toEqual({
      accepted: true,
      requested: 1,
      cached: 0,
      failed: 1,
      cancelled: false,
    });
    const routeCache = await runtime.caches.open(runtime.test.WORKSPACE_ROUTES_CACHE_NAME);
    const staticCache = await runtime.caches.open(runtime.test.BUILD_ASSET_CACHE_NAME);
    expect(await routeCache.match(new Request("https://evolvra.test/goals/current"))).toBeUndefined();
    expect(await staticCache.match(new Request("https://evolvra.test/_next/static/missing.js"))).toBeUndefined();
  });

  it("stops serving a prepared goal if one of its required build assets is later missing", async () => {
    let online = true;
    const runtime = createRuntime(async (input) => {
      if (!online) throw new Error("offline");
      const pathname = new URL(input.url).pathname;
      if (pathname === "/goals/current") {
        return new Response('<script src="/_next/static/current.js"></script><main>goal</main>', {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/_next/static/current.js") {
        return new Response("export {};", {
          status: 200,
          headers: { "content-type": "application/javascript; charset=utf-8" },
        });
      }
      throw new Error(`Unexpected fetch: ${pathname}`);
    });
    const precache = await runtime.caches.open(runtime.test.PRECACHE_NAME);
    await precache.put("/__evolvra_offline__", new Response("offline document", {
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    expect(await runtime.test.syncWorkspaceGoalRoutes(["/goals/current"]))
      .toMatchObject({ cached: 1, failed: 0 });

    const buildAssetCache = await runtime.caches.open(runtime.test.BUILD_ASSET_CACHE_NAME);
    await buildAssetCache.delete(new Request("https://evolvra.test/_next/static/current.js"));
    online = false;

    expect(await (await runtime.test.navigationStrategy(request("/goals/current"))).text())
      .toBe("offline document");
  });

  it("does not intercept authentication, API, or token-bearing requests", () => {
    const runtime = createRuntime(async () => new Response("unexpected"));
    const listener = runtime.listeners.get("fetch");
    expect(listener).toBeTypeOf("function");
    for (const unsafe of [request("/api/workspace"), request("/callback?code=secret"), request("/goals?access_token=secret")]) {
      let intercepted = false;
      listener?.({ request: unsafe, respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
  });

  it("returns the explicit offline document when an uncached navigation fails", async () => {
    const runtime = createRuntime(async () => { throw new Error("offline"); });
    const precache = await runtime.caches.open(runtime.test.PRECACHE_NAME);
    await precache.put("/__evolvra_offline__", new Response("offline document", { headers: { "content-type": "text/html" } }));
    const response = await runtime.test.navigationStrategy(request("/goals/not-visited"));
    expect(await response.text()).toBe("offline document");
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("serves a declared goal offline without caching or replaying its query response", async () => {
    let online = true;
    const runtime = createRuntime(async (input) => {
      if (!online) throw new Error("offline");
      const url = new URL(input.url);
      return new Response(url.search ? "query response" : "declared goal shell", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    await runtime.test.syncWorkspaceGoalRoutes(["/goals/abc"]);
    expect(await (await runtime.test.navigationStrategy(request("/goals/abc?view=detail"))).text())
      .toBe("query response");
    const cache = await runtime.caches.open(runtime.test.WORKSPACE_ROUTES_CACHE_NAME);
    expect(await cache.match(new Request("https://evolvra.test/goals/abc?view=detail"))).toBeUndefined();
    expect(await (await cache.match(new Request("https://evolvra.test/goals/abc")))?.text())
      .toBe("declared goal shell");

    online = false;
    expect(await (await runtime.test.navigationStrategy(request("/goals/abc?view=another"))).text())
      .toBe("declared goal shell");
  });

  it("does not retain an arbitrary goal route merely because it was visited", async () => {
    let online = true;
    const runtime = createRuntime(async () => {
      if (!online) throw new Error("offline");
      return new Response("unknown online shell", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    const precache = await runtime.caches.open(runtime.test.PRECACHE_NAME);
    await precache.put("/__evolvra_offline__", new Response("offline document", {
      headers: { "content-type": "text/html" },
    }));

    expect(await (await runtime.test.navigationStrategy(request("/goals/not-in-workspace"))).text())
      .toBe("unknown online shell");
    online = false;
    expect(await (await runtime.test.navigationStrategy(request("/goals/not-in-workspace"))).text())
      .toBe("offline document");
  });

  it.each([
    ["/_next/static/missing.js", "script", "text/html", "application/javascript"],
    ["/_next/static/missing.css", "style", "text/html", "text/css"],
    ["/_next/static/wrong-mime.js", "script", "text/plain", "application/javascript"],
  ])("never serves a successful wrong-MIME response for %s", async (path, destination, upstreamType, expectedType) => {
    const runtime = createRuntime(async () => new Response("<html>wrong fallback</html>", {
      status: 200,
      headers: { "content-type": upstreamType },
    }));
    const response = await runtime.test.staticAssetStrategy(request(path, destination));

    expect(response.ok).toBe(false);
    expect(response.status).toBe(504);
    expect(response.headers.get("content-type")).toContain(expectedType);
    expect(await response.text()).toBe("");
  });

  it.each([200, 404])("turns an image HTML fallback with status %i into a network error", async (status) => {
    const runtime = createRuntime(async () => new Response("<html>not an image</html>", {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    const response = await runtime.test.staticAssetStrategy(request("/missing-icon.png", "image"));

    expect(response.type).toBe("error");
    expect(response.status).toBe(0);
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("serves but does not cache a valid no-store static response", async () => {
    const assetRequest = request("/_next/static/private.js", "script");
    const runtime = createRuntime(async () => new Response("export {};", {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/javascript; charset=utf-8",
      },
    }));
    const response = await runtime.test.staticAssetStrategy(assetRequest);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export {};");
    const cache = await runtime.caches.open(runtime.test.STATIC_CACHE_NAME);
    expect(await cache.match(new Request(assetRequest.url))).toBeUndefined();
  });

  it("serves but does not cache a query-bearing static response", async () => {
    const assetRequest = request("/_next/static/runtime.js?v=private", "script");
    const runtime = createRuntime(async () => new Response("export {};", {
      status: 200,
      headers: { "content-type": "application/javascript; charset=utf-8" },
    }));

    expect(await (await runtime.test.staticAssetStrategy(assetRequest)).text()).toBe("export {};");
    const cache = await runtime.caches.open(runtime.test.STATIC_CACHE_NAME);
    expect(await cache.match(new Request(assetRequest.url))).toBeUndefined();
  });
});
