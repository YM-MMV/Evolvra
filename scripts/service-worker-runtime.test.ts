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

type WorkerRuntime = {
  listeners: Map<string, (event: Record<string, unknown>) => void>;
  caches: CacheStorage;
  lifecycle: {
    claimedClients: number;
    skipWaitingCalls: number;
    clientMessages: unknown[];
    clientMatchOptions: unknown[];
  };
  test: {
    navigationStrategy: (request: RequestLike) => Promise<Response>;
    staticAssetStrategy: (request: RequestLike) => Promise<Response>;
    PRECACHE_NAME: string;
    NAVIGATION_CACHE_NAME: string;
    STATIC_CACHE_NAME: string;
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

function createRuntime(fetchImplementation: (input: Request | RequestLike) => Promise<Response>): WorkerRuntime {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const lifecycle: WorkerRuntime["lifecycle"] = {
    claimedClients: 0,
    skipWaitingCalls: 0,
    clientMessages: [],
    clientMatchOptions: [],
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
        return [{ postMessage: (message: unknown) => lifecycle.clientMessages.push(message) }];
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
  vm.runInContext(`${source}\nglobalThis.__swTest = { navigationStrategy, staticAssetStrategy, PRECACHE_NAME, NAVIGATION_CACHE_NAME, STATIC_CACHE_NAME, WORKER_VERSION };`, context);
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

    expect(runtime.lifecycle.skipWaitingCalls).toBe(1);
    expect(lifetime).not.toBeNull();
    await lifetime;
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

  it("reuses a visited goal document offline without caching its query string", async () => {
    let online = true;
    const runtime = createRuntime(async () => {
      if (!online) throw new Error("offline");
      return new Response("goal shell", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    });
    expect(await (await runtime.test.navigationStrategy(request("/goals/abc?view=detail"))).text()).toBe("goal shell");
    online = false;
    expect(await (await runtime.test.navigationStrategy(request("/goals/abc?view=another"))).text()).toBe("goal shell");
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
});
