const WORKER_VERSION = "2026-07-28.1";
const CACHE_PREFIX = "evolvra-";
const PRECACHE_NAME = `${CACHE_PREFIX}precache-${WORKER_VERSION}`;
const NAVIGATION_CACHE_NAME = `${CACHE_PREFIX}navigation-${WORKER_VERSION}`;
const WORKSPACE_ROUTES_CACHE_NAME = `${CACHE_PREFIX}workspace-routes-${WORKER_VERSION}`;
const WORKSPACE_MANIFEST_CACHE_NAME = `${CACHE_PREFIX}workspace-manifests-v1`;
const BUILD_ASSET_CACHE_NAME = `${CACHE_PREFIX}build-assets-${WORKER_VERSION}`;
const STATIC_CACHE_NAME = `${CACHE_PREFIX}static-${WORKER_VERSION}`;
const CURRENT_CACHES = new Set([
  PRECACHE_NAME,
  NAVIGATION_CACHE_NAME,
  WORKSPACE_ROUTES_CACHE_NAME,
  WORKSPACE_MANIFEST_CACHE_NAME,
  BUILD_ASSET_CACHE_NAME,
  STATIC_CACHE_NAME,
]);
const MAX_NAVIGATION_ENTRIES = 40;
const MAX_STATIC_ENTRIES = 140;
const MAX_BUILD_ASSET_ENTRIES = 256;
// The validated workspace schema permits at most 2,000 goals. Keeping the
// worker boundary at the same finite limit prevents untrusted messages from
// turning one event into unbounded network or cache work.
const MAX_WORKSPACE_GOAL_ROUTES = 2_000;
const MAX_WORKSPACE_ROUTE_UNION = MAX_WORKSPACE_GOAL_ROUTES;
const MAX_WORKSPACE_CLIENT_MANIFESTS = 8;
const MAX_CLIENT_ID_LENGTH = 256;
const MAX_WORKSPACE_ROUTE_PATH_LENGTH = 4_096;
const WORKSPACE_ROUTE_FETCH_CONCURRENCY = 4;
const OFFLINE_FALLBACK_URL = "/__evolvra_offline__";
const INTERNAL_WORKER_PATH = "/__evolvra_worker__";
const CLIENT_MANIFEST_PATH_PREFIX = `${INTERNAL_WORKER_PATH}/client/`;
const ROUTE_UNION_PATH = `${INTERNAL_WORKER_PATH}/route-union`;

const SHELL_ROUTES = ["/", "/goals", "/quests", "/stats", "/reviews", "/timeline", "/settings"];
const PUBLIC_ASSETS = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

const SENSITIVE_PATH_PREFIXES = [
  "/api",
  "/auth",
  "/callback",
  "/oauth",
  "/login",
  "/logout",
  "/supabase",
  "/storage",
  "/evidence",
  "/_next/image",
  INTERNAL_WORKER_PATH,
];
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "code",
  "error",
  "error_code",
  "error_description",
  "id_token",
  "provider_token",
  "refresh_token",
  "state",
  "token",
]);

const OFFLINE_DOCUMENT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#030403">
  <title>Offline · Evolvra</title>
  <style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#030403;color:#f2f3ed}
    *{box-sizing:border-box}body{min-height:100vh;display:grid;place-items:center;margin:0;padding:24px;background:radial-gradient(circle at 50% 0,rgba(255,139,34,.12),transparent 42%),#030403}
    main{width:min(520px,100%);padding:28px;border:1px solid #353a35;background:#080a08}small{color:#ff8b22;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
    h1{margin:12px 0 10px;font-size:clamp(28px,8vw,44px)}p{margin:0;color:#a5aaa3;line-height:1.65}nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}
    a,button{min-height:42px;padding:0 14px;border:1px solid #353a35;color:#f2f3ed;background:#101310;font:inherit;cursor:pointer;text-decoration:none}
    a:first-child{border-color:#ff8b22;color:#130b04;background:#ff8b22;font-weight:800}
  </style>
</head>
<body><main><small>Offline mode</small><h1>This page is not available offline yet.</h1><p>Pages prepared for the current workspace and core workspace pages remain available. Reconnect to open this page.</p><nav><button onclick="location.reload()">Try again</button><a href="/">Open command centre</a></nav></main></body>
</html>`;

function urlFor(request) {
  return new URL(request.url);
}

function isSafeSameOriginRequest(request) {
  if (request.method !== "GET") return false;
  const url = urlFor(request);
  if (url.origin !== self.location.origin) return false;
  if (request.headers.has("authorization") || request.headers.has("range")) return false;
  if (url.pathname === "/sw.js") return false;

  const path = url.pathname.toLowerCase();
  if (SENSITIVE_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return false;
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) return false;
  }
  return true;
}

function isNavigationRequest(request) {
  return request.mode === "navigate" || request.destination === "document";
}

function isStaticAssetRequest(request) {
  const url = urlFor(request);
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (PUBLIC_ASSETS.includes(url.pathname)) return true;
  return ["font", "image", "manifest", "script", "style", "worker"].includes(request.destination);
}

function navigationCacheKey(request) {
  const url = urlFor(request);
  return new Request(`${url.origin}${url.pathname}`, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "text/html" },
  });
}

function normalizedAppPath(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
}

function isShellRoute(pathname) {
  return SHELL_ROUTES.includes(normalizedAppPath(pathname));
}

function isGoalRoute(pathname) {
  return /^\/goals\/[^/]+$/.test(normalizedAppPath(pathname));
}

function isCacheableAppPath(pathname) {
  return isShellRoute(pathname) || isGoalRoute(pathname);
}

function isSafeBaseResponse(response, allowRestrictedCacheControl = false) {
  if (!response || !response.ok || response.redirected) return false;
  if (!['basic', 'default'].includes(response.type)) return false;
  const responseUrl = response.url ? new URL(response.url) : null;
  if (responseUrl && responseUrl.origin !== self.location.origin) return false;
  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
  if (!allowRestrictedCacheControl && (cacheControl.includes("no-store") || cacheControl.includes("private"))) return false;
  return response.headers.get("vary") !== "*";
}

function isCacheableNavigationResponse(response, request) {
  const requestUrl = urlFor(request);
  if (requestUrl.search || !isCacheableAppPath(requestUrl.pathname)) return false;
  // These routes render only the client application shell; user workspace data
  // is loaded locally after hydration. Restricting the path allowlist lets
  // declared workspace goal pages work offline without caching arbitrary HTML.
  if (!isSafeBaseResponse(response, true)) return false;
  return (response.headers.get("content-type") || "").toLowerCase().includes("text/html");
}

function expectedAssetKind(request) {
  const path = urlFor(request).pathname.toLowerCase();
  if (request.destination === "script" || request.destination === "worker" || /\.(?:js|mjs)$/.test(path)) return "script";
  if (request.destination === "style" || path.endsWith(".css")) return "style";
  if (request.destination === "font" || /\.(?:woff2?|ttf|otf)$/.test(path)) return "font";
  if (request.destination === "image" || /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/.test(path)) return "image";
  if (request.destination === "manifest" || path.endsWith(".webmanifest")) return "manifest";
  return "other";
}

function hasExpectedStaticContentType(response, request) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html")) return false;

  switch (expectedAssetKind(request)) {
    case "script": return contentType.includes("javascript");
    case "style": return contentType.includes("text/css");
    case "font": return contentType.includes("font") || contentType.includes("application/octet-stream");
    case "image": return contentType.startsWith("image/");
    case "manifest": return contentType.includes("manifest") || contentType.includes("json");
    default: return urlFor(request).pathname.startsWith("/_next/static/");
  }
}

function isUsableStaticResponse(response, request) {
  if (!response || !response.ok || response.redirected) return false;
  if (!["basic", "default"].includes(response.type)) return false;
  const responseUrl = response.url ? new URL(response.url) : null;
  if (responseUrl && responseUrl.origin !== self.location.origin) return false;
  return hasExpectedStaticContentType(response, request);
}

function isCacheableStaticResponse(response, request) {
  return !urlFor(request).search
    && isSafeBaseResponse(response)
    && hasExpectedStaticContentType(response, request);
}

function assetFailureResponse(request) {
  const kind = expectedAssetKind(request);
  if (kind === "script") {
    return new Response("", { status: 504, statusText: "Script unavailable offline", headers: { "content-type": "application/javascript; charset=utf-8" } });
  }
  if (kind === "style") {
    return new Response("", { status: 504, statusText: "Stylesheet unavailable offline", headers: { "content-type": "text/css; charset=utf-8" } });
  }
  return Response.error();
}

async function trimCache(cacheName, maximumEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const overflow = keys.length - maximumEntries;
  if (overflow > 0) await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
}

async function cacheNavigation(request, response, cacheName = NAVIGATION_CACHE_NAME) {
  if (!isCacheableNavigationResponse(response, request)) return;
  const cache = await caches.open(cacheName);
  await cache.put(navigationCacheKey(request), response.clone());
  if (cacheName === NAVIGATION_CACHE_NAME) await trimCache(cacheName, MAX_NAVIGATION_ENTRIES);
}

async function cacheStaticAsset(request, response) {
  if (!isCacheableStaticResponse(response, request)) return false;
  const cache = await caches.open(STATIC_CACHE_NAME);
  await cache.put(request, response.clone());
  await trimCache(STATIC_CACHE_NAME, MAX_STATIC_ENTRIES);
  return true;
}

function discoverBuildAssets(html) {
  const assets = new Set();
  const attributePattern = /(?:src|href)=["']([^"'#]+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin === self.location.origin && url.pathname.startsWith("/_next/static/")) {
        assets.add(url.href);
        if (assets.size > MAX_BUILD_ASSET_ENTRIES) return null;
      }
    } catch {
      // Ignore malformed attributes rather than failing installation.
    }
  }
  return assets;
}

let buildAssetCacheQueue = Promise.resolve();

function queueBuildAssetCacheOperation(callback) {
  const operation = buildAssetCacheQueue.then(callback);
  buildAssetCacheQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function cacheBuildAssetResponse(request, response) {
  return queueBuildAssetCacheOperation(async () => {
    if (!urlFor(request).pathname.startsWith("/_next/static/") || urlFor(request).search) {
      return false;
    }
    if (!isCacheableStaticResponse(response, request)) return false;
    const cache = await caches.open(BUILD_ASSET_CACHE_NAME);
    const existing = await cache.match(request);
    if (existing && isCacheableStaticResponse(existing, request)) return true;
    if (existing) await cache.delete(request);
    if ((await cache.keys()).length >= MAX_BUILD_ASSET_ENTRIES) return false;
    await cache.put(request, response.clone());
    return true;
  });
}

function ensureBuildAssetCached(pathname) {
  return queueBuildAssetCacheOperation(async () => {
    const request = new Request(new URL(pathname, self.location.origin).href, {
      cache: "reload",
      credentials: "same-origin",
    });
    if (!urlFor(request).pathname.startsWith("/_next/static/") || urlFor(request).search) {
      return false;
    }
    const cache = await caches.open(BUILD_ASSET_CACHE_NAME);
    const existing = await cache.match(request);
    if (existing && isCacheableStaticResponse(existing, request)) return true;
    if (existing) await cache.delete(request);
    if ((await cache.keys()).length >= MAX_BUILD_ASSET_ENTRIES) return false;
    try {
      const response = await fetch(request);
      if (!isCacheableStaticResponse(response, request)) return false;
      await cache.put(request, response.clone());
      return true;
    } catch {
      return false;
    }
  });
}

async function precacheShellRoute(pathname) {
  const url = new URL(pathname, self.location.origin);
  const request = new Request(url.href, {
    cache: "reload",
    credentials: "same-origin",
    headers: { accept: "text/html" },
  });
  const response = await fetch(request);
  if (!isCacheableNavigationResponse(response, request)) {
    throw new Error(`The shell route ${pathname} is not safe to cache.`);
  }
  const html = await response.clone().text();
  const assets = discoverBuildAssets(html);
  if (!assets) throw new Error(`The shell route ${pathname} references too many build assets.`);
  await cacheNavigation(request, response, PRECACHE_NAME);
  return [...assets];
}

function parseWorkspaceGoalRoutes(value, maximumRoutes = MAX_WORKSPACE_GOAL_ROUTES) {
  if (!Array.isArray(value) || value.length > maximumRoutes) return null;
  const routes = new Set();
  for (const candidate of value) {
    if (
      typeof candidate !== "string"
      || !candidate.startsWith("/")
      || candidate.startsWith("//")
      || candidate.length > MAX_WORKSPACE_ROUTE_PATH_LENGTH
      || candidate.includes("?")
      || candidate.includes("#")
    ) return null;
    let url;
    try {
      url = new URL(candidate, self.location.origin);
    } catch {
      return null;
    }
    if (
      url.origin !== self.location.origin
      || url.search
      || url.hash
      || url.pathname !== candidate
      || !isGoalRoute(url.pathname)
    ) return null;
    routes.add(url.pathname);
  }
  return [...routes];
}

async function workspaceGoalResponseIsReady(
  response,
  request,
  { fetchMissingAssets = false, isCurrent = () => true } = {},
) {
  if (!isCacheableNavigationResponse(response, request) || !isCurrent()) return false;
  const html = await response.clone().text();
  const discoveredAssets = discoverBuildAssets(html);
  if (!discoveredAssets) return false;
  const assets = [...discoveredAssets];
  if (fetchMissingAssets) {
    const results = await Promise.all(assets.map((asset) => ensureBuildAssetCached(asset)));
    return isCurrent() && results.every(Boolean);
  }
  const cache = await caches.open(BUILD_ASSET_CACHE_NAME);
  const results = await Promise.all(assets.map(async (asset) => {
    const assetRequest = new Request(asset, { credentials: "same-origin" });
    const cached = await cache.match(assetRequest);
    return Boolean(cached && isCacheableStaticResponse(cached, assetRequest));
  }));
  return isCurrent() && results.every(Boolean);
}

async function cacheWorkspaceGoalRoute(pathname, isCurrent = () => true) {
  const url = new URL(pathname, self.location.origin);
  const request = new Request(url.href, {
    cache: "reload",
    credentials: "same-origin",
    headers: { accept: "text/html" },
  });
  const response = await fetch(request);
  if (!await workspaceGoalResponseIsReady(response, request, {
    fetchMissingAssets: true,
    isCurrent,
  })) return false;
  const cache = await caches.open(WORKSPACE_ROUTES_CACHE_NAME);
  await cache.put(navigationCacheKey(request), response.clone());
  return true;
}

async function syncWorkspaceGoalRoutes(
  value,
  isCurrent = () => true,
  maximumRoutes = MAX_WORKSPACE_GOAL_ROUTES,
) {
  const routes = parseWorkspaceGoalRoutes(value, maximumRoutes);
  if (!routes) {
    return { accepted: false, requested: 0, cached: 0, failed: 0 };
  }
  if (!isCurrent()) {
    return { accepted: true, requested: routes.length, cached: 0, failed: 0, cancelled: true };
  }

  const cache = await caches.open(WORKSPACE_ROUTES_CACHE_NAME);
  const desiredUrls = new Set(routes.map((pathname) => new URL(pathname, self.location.origin).href));
  const existingKeys = await cache.keys();
  await Promise.all(existingKeys
    .filter((key) => !desiredUrls.has(key.url))
    .map((key) => cache.delete(key)));

  let nextRouteIndex = 0;
  let cachedCount = 0;
  let failedCount = 0;
  const workerCount = Math.min(WORKSPACE_ROUTE_FETCH_CONCURRENCY, routes.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (isCurrent()) {
      const routeIndex = nextRouteIndex;
      nextRouteIndex += 1;
      if (routeIndex >= routes.length) return;
      const pathname = routes[routeIndex];
      const routeRequest = navigationCacheKey(new Request(new URL(pathname, self.location.origin).href));
      const existing = await cache.match(routeRequest);
      if (existing && await workspaceGoalResponseIsReady(existing, routeRequest, {
        fetchMissingAssets: true,
        isCurrent,
      })) {
        cachedCount += 1;
        continue;
      }
      if (existing) await cache.delete(routeRequest);
      try {
        if (await cacheWorkspaceGoalRoute(pathname, isCurrent)) {
          cachedCount += 1;
        } else if (isCurrent()) {
          failedCount += 1;
        }
      } catch {
        if (isCurrent()) failedCount += 1;
      }
    }
  });
  await Promise.all(workers);
  return {
    accepted: true,
    requested: routes.length,
    cached: cachedCount,
    failed: failedCount,
    cancelled: !isCurrent(),
  };
}

async function precachePublicAsset(pathname) {
  const request = new Request(new URL(pathname, self.location.origin).href, { cache: "reload", credentials: "same-origin" });
  const response = await fetch(request);
  return cacheStaticAsset(request, response);
}

function internalWorkerRequest(pathname) {
  return new Request(new URL(pathname, self.location.origin).href, {
    credentials: "same-origin",
  });
}

function clientManifestRequest(clientId) {
  return internalWorkerRequest(`${CLIENT_MANIFEST_PATH_PREFIX}${encodeURIComponent(clientId)}`);
}

async function readRouteListResponse(response, maximumRoutes) {
  if (!response?.ok) return null;
  try {
    return parseWorkspaceGoalRoutes(await response.json(), maximumRoutes);
  } catch {
    return null;
  }
}

async function readPersistedWorkspaceRouteUnion() {
  const cache = await caches.open(WORKSPACE_MANIFEST_CACHE_NAME);
  const response = await cache.match(internalWorkerRequest(ROUTE_UNION_PATH));
  return await readRouteListResponse(response, MAX_WORKSPACE_ROUTE_UNION) ?? [];
}

async function writePersistedWorkspaceRouteUnion(cache, routes) {
  await cache.put(internalWorkerRequest(ROUTE_UNION_PATH), new Response(JSON.stringify(routes), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  }));
}

async function syncClientWorkspaceGoalRoutes(source, value) {
  if (
    !source
    || source.type !== "window"
    || typeof source.id !== "string"
    || !source.id
    || source.id.length > MAX_CLIENT_ID_LENGTH
  ) {
    return {
      accepted: false,
      reason: "invalid-client",
      clientRequested: 0,
      requested: 0,
      cached: 0,
      failed: 0,
    };
  }
  const routes = parseWorkspaceGoalRoutes(value);
  if (!routes) {
    return {
      accepted: false,
      reason: "invalid-routes",
      clientRequested: 0,
      requested: 0,
      cached: 0,
      failed: 0,
    };
  }

  const liveClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const liveClientIds = new Set(liveClients
    .map((client) => client.id)
    .filter((clientId) => typeof clientId === "string" && clientId.length <= MAX_CLIENT_ID_LENGTH));
  liveClientIds.add(source.id);

  const cache = await caches.open(WORKSPACE_MANIFEST_CACHE_NAME);
  const keys = await cache.keys();
  const manifests = new Map();
  const staleKeys = [];
  for (const key of keys) {
    const url = new URL(key.url);
    if (!url.pathname.startsWith(CLIENT_MANIFEST_PATH_PREFIX)) continue;
    let clientId;
    try {
      clientId = decodeURIComponent(url.pathname.slice(CLIENT_MANIFEST_PATH_PREFIX.length));
    } catch {
      staleKeys.push(key);
      continue;
    }
    if (!liveClientIds.has(clientId)) {
      staleKeys.push(key);
      continue;
    }
    const manifest = await readRouteListResponse(
      await cache.match(key),
      MAX_WORKSPACE_GOAL_ROUTES,
    );
    if (!manifest) {
      staleKeys.push(key);
      continue;
    }
    manifests.set(clientId, manifest);
  }

  if (routes.length) manifests.set(source.id, routes);
  else manifests.delete(source.id);
  if (manifests.size > MAX_WORKSPACE_CLIENT_MANIFESTS) {
    return {
      accepted: false,
      reason: "client-limit",
      clientRequested: routes.length,
      requested: 0,
      cached: 0,
      failed: 0,
    };
  }

  const routeUnion = new Set();
  for (const manifest of manifests.values()) {
    manifest.forEach((pathname) => routeUnion.add(pathname));
    if (routeUnion.size > MAX_WORKSPACE_ROUTE_UNION) {
      return {
        accepted: false,
        reason: "union-limit",
        clientRequested: routes.length,
        requested: routeUnion.size,
        cached: 0,
        failed: 0,
      };
    }
  }
  const union = [...routeUnion].sort();

  await Promise.all(staleKeys.map((key) => cache.delete(key)));
  const sourceManifestKey = clientManifestRequest(source.id);
  if (routes.length) {
    await cache.put(sourceManifestKey, new Response(JSON.stringify(routes), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      },
    }));
  } else {
    await cache.delete(sourceManifestKey);
  }
  await writePersistedWorkspaceRouteUnion(cache, union);

  const result = await syncWorkspaceGoalRoutes(
    union,
    () => true,
    MAX_WORKSPACE_ROUTE_UNION,
  );
  return {
    ...result,
    clientRequested: routes.length,
  };
}

async function installPrecache() {
  const precache = await caches.open(PRECACHE_NAME);
  await precache.put(OFFLINE_FALLBACK_URL, new Response(OFFLINE_DOCUMENT, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "x-evolvra-offline": "true" },
  }));

  const routeResults = await Promise.all(SHELL_ROUTES.map(precacheShellRoute));
  const discoveredAssets = new Set();
  routeResults.forEach((assets) => assets.forEach((asset) => discoveredAssets.add(asset)));
  if (discoveredAssets.size > MAX_BUILD_ASSET_ENTRIES) {
    throw new Error("The application shell references too many build assets.");
  }

  const assetResults = await Promise.all([
    ...PUBLIC_ASSETS.map(precachePublicAsset),
    ...[...discoveredAssets].map((asset) => ensureBuildAssetCached(asset)),
  ]);
  if (assetResults.some((cached) => !cached)) {
    throw new Error("The application shell could not cache every required asset safely.");
  }

  // A waiting worker is installed while the previous generation still owns
  // the pages. Carry its bounded, data-free route manifest forward so a direct
  // offline goal launch remains possible immediately after activation.
  const carriedRoutes = await readPersistedWorkspaceRouteUnion();
  const carried = await syncWorkspaceGoalRoutes(
    carriedRoutes,
    () => true,
    MAX_WORKSPACE_ROUTE_UNION,
  );
  if (carried.failed || carried.cached !== carried.requested) {
    throw new Error("The next worker could not safely carry every offline goal route forward.");
  }
}

async function navigationStrategy(request) {
  try {
    const response = await fetch(request);
    const requestUrl = urlFor(request);
    if (isShellRoute(requestUrl.pathname)) {
      await cacheNavigation(request, response);
    }
    // Goal HTML is versioned with the worker and is refreshed only through the
    // manifest pipeline, which verifies every discovered build dependency.
    return response;
  } catch {
    const key = navigationCacheKey(request);
    const requestPath = urlFor(request).pathname;
    if (isGoalRoute(requestPath)) {
      const workspaceRoute = await caches.match(key, { cacheName: WORKSPACE_ROUTES_CACHE_NAME });
      if (workspaceRoute && await workspaceGoalResponseIsReady(workspaceRoute, key)) {
        return workspaceRoute;
      }
    } else if (isShellRoute(requestPath)) {
      const visited = await caches.match(key, { cacheName: NAVIGATION_CACHE_NAME });
      if (visited && isCacheableNavigationResponse(visited, key)) return visited;
      const shell = await caches.match(key, { cacheName: PRECACHE_NAME });
      if (shell && isCacheableNavigationResponse(shell, key)) return shell;
    }
    const offline = await caches.match(OFFLINE_FALLBACK_URL, { cacheName: PRECACHE_NAME });
    return offline || new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

async function staticAssetStrategy(request) {
  const isBuildAsset = urlFor(request).pathname.startsWith("/_next/static/");
  const cacheName = isBuildAsset ? BUILD_ASSET_CACHE_NAME : STATIC_CACHE_NAME;
  const cached = await caches.match(request, { cacheName });
  if (cached) {
    if (isCacheableStaticResponse(cached, request)) return cached;
    const cache = await caches.open(cacheName);
    await cache.delete(request);
  }

  try {
    const response = await fetch(request);
    if (!isUsableStaticResponse(response, request)) return assetFailureResponse(request);
    if (isBuildAsset) await cacheBuildAssetResponse(request, response);
    else await cacheStaticAsset(request, response);
    return response;
  } catch {
    return assetFailureResponse(request);
  }
}

async function notifyWindowClients(message) {
  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  windowClients.forEach((client) => client.postMessage(message));
}

let workspaceRouteUpdateQueue = Promise.resolve();

function queueWorkspaceGoalRouteSync(source, paths) {
  const operation = workspaceRouteUpdateQueue.then(() =>
    syncClientWorkspaceGoalRoutes(source, paths));
  workspaceRouteUpdateQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

self.addEventListener("install", (event) => {
  event.waitUntil(installPrecache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(CACHE_PREFIX) && !CURRENT_CACHES.has(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
    await notifyWindowClients({ type: "EVOLVRA_OFFLINE_READY", version: WORKER_VERSION });
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type !== "SYNC_WORKSPACE_GOAL_ROUTES") return;
  event.waitUntil((async () => {
    let result = {
      accepted: false,
      reason: "worker-error",
      clientRequested: 0,
      requested: 0,
      cached: 0,
      failed: 0,
    };
    try {
      result = await queueWorkspaceGoalRouteSync(event.source, event.data.paths);
    } catch {
      // Missing routes remain online-only if they cannot be fetched or safely
      // validated; no unsafe response is substituted into the cache.
    }
    event.ports?.[0]?.postMessage({ type: "WORKSPACE_GOAL_ROUTES_SYNCED", ...result });
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!isSafeSameOriginRequest(request)) return;

  if (isNavigationRequest(request)) {
    event.respondWith(navigationStrategy(request));
    return;
  }

  if (isStaticAssetRequest(request)) event.respondWith(staticAssetStrategy(request));
});
