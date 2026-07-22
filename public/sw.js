const WORKER_VERSION = "2026-07-22.1";
const CACHE_PREFIX = "evolvra-";
const PRECACHE_NAME = `${CACHE_PREFIX}precache-${WORKER_VERSION}`;
const NAVIGATION_CACHE_NAME = `${CACHE_PREFIX}navigation-${WORKER_VERSION}`;
const STATIC_CACHE_NAME = `${CACHE_PREFIX}static-${WORKER_VERSION}`;
const CURRENT_CACHES = new Set([PRECACHE_NAME, NAVIGATION_CACHE_NAME, STATIC_CACHE_NAME]);
const MAX_NAVIGATION_ENTRIES = 40;
const MAX_STATIC_ENTRIES = 140;
const OFFLINE_FALLBACK_URL = "/__evolvra_offline__";

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
<body><main><small>Offline mode</small><h1>This page is not available offline yet.</h1><p>Previously visited goals and core workspace pages remain available. Reconnect to open this page, then it will be kept for later.</p><nav><button onclick="location.reload()">Try again</button><a href="/">Open command centre</a></nav></main></body>
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

function isCacheableAppPath(pathname) {
  const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return SHELL_ROUTES.includes(normalized) || /^\/goals\/[^/]+$/.test(normalized);
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
  if (!isCacheableAppPath(urlFor(request).pathname)) return false;
  // These routes render only the client application shell; user workspace data
  // is loaded locally after hydration. Restricting the path allowlist lets
  // visited goal pages work offline without caching arbitrary HTML responses.
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
  return isSafeBaseResponse(response) && hasExpectedStaticContentType(response, request);
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
  if (!isCacheableStaticResponse(response, request)) return;
  const cache = await caches.open(STATIC_CACHE_NAME);
  await cache.put(request, response.clone());
  await trimCache(STATIC_CACHE_NAME, MAX_STATIC_ENTRIES);
}

function discoverBuildAssets(html) {
  const assets = new Set();
  const attributePattern = /(?:src|href)=["']([^"'#]+)["']/gi;
  for (const match of html.matchAll(attributePattern)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin === self.location.origin && url.pathname.startsWith("/_next/static/")) assets.add(url.href);
    } catch {
      // Ignore malformed attributes rather than failing installation.
    }
  }
  return assets;
}

async function precacheShellRoute(pathname) {
  const url = new URL(pathname, self.location.origin);
  const request = new Request(url.href, {
    cache: "reload",
    credentials: "same-origin",
    headers: { accept: "text/html" },
  });
  const response = await fetch(request);
  if (!isCacheableNavigationResponse(response, request)) return [];
  const html = await response.clone().text();
  await cacheNavigation(request, response, PRECACHE_NAME);
  return [...discoverBuildAssets(html)];
}

async function cacheVisitedAppRoute(pathname) {
  const url = new URL(pathname, self.location.origin);
  if (url.origin !== self.location.origin || !isCacheableAppPath(url.pathname)) return false;
  const request = new Request(url.href, {
    cache: "reload",
    credentials: "same-origin",
    headers: { accept: "text/html" },
  });
  const response = await fetch(request);
  if (!isCacheableNavigationResponse(response, request)) return false;
  const html = await response.clone().text();
  await cacheNavigation(request, response);
  await Promise.allSettled([...discoverBuildAssets(html)].map((asset) => precachePublicAsset(asset)));
  return true;
}

async function precachePublicAsset(pathname) {
  const request = new Request(new URL(pathname, self.location.origin).href, { cache: "reload", credentials: "same-origin" });
  const response = await fetch(request);
  await cacheStaticAsset(request, response);
}

async function installPrecache() {
  const precache = await caches.open(PRECACHE_NAME);
  await precache.put(OFFLINE_FALLBACK_URL, new Response(OFFLINE_DOCUMENT, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "x-evolvra-offline": "true" },
  }));

  const routeResults = await Promise.allSettled(SHELL_ROUTES.map(precacheShellRoute));
  const discoveredAssets = new Set();
  for (const result of routeResults) {
    if (result.status === "fulfilled") result.value.forEach((asset) => discoveredAssets.add(asset));
  }

  await Promise.allSettled([
    ...PUBLIC_ASSETS.map(precachePublicAsset),
    ...[...discoveredAssets].map((asset) => precachePublicAsset(asset)),
  ]);
}

async function navigationStrategy(request) {
  try {
    const response = await fetch(request);
    await cacheNavigation(request, response);
    return response;
  } catch {
    const key = navigationCacheKey(request);
    const visited = await caches.match(key, { cacheName: NAVIGATION_CACHE_NAME });
    if (visited && isCacheableNavigationResponse(visited, request)) return visited;
    const shell = await caches.match(key, { cacheName: PRECACHE_NAME });
    if (shell && isCacheableNavigationResponse(shell, request)) return shell;
    const offline = await caches.match(OFFLINE_FALLBACK_URL, { cacheName: PRECACHE_NAME });
    return offline || new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

async function staticAssetStrategy(request) {
  const cached = await caches.match(request, { cacheName: STATIC_CACHE_NAME });
  if (cached) {
    if (isCacheableStaticResponse(cached, request)) return cached;
    const cache = await caches.open(STATIC_CACHE_NAME);
    await cache.delete(request);
  }

  try {
    const response = await fetch(request);
    if (!isUsableStaticResponse(response, request)) return assetFailureResponse(request);
    await cacheStaticAsset(request, response);
    return response;
  } catch {
    return assetFailureResponse(request);
  }
}

async function notifyWindowClients(message) {
  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  windowClients.forEach((client) => client.postMessage(message));
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
  if (event.data?.type !== "CACHE_VISITED_ROUTE" || typeof event.data.pathname !== "string") return;
  event.waitUntil((async () => {
    let cached = false;
    try {
      cached = await cacheVisitedAppRoute(event.data.pathname);
    } catch {
      // The route remains online-only if it cannot be fetched or validated.
    }
    event.ports[0]?.postMessage({ cached });
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
