#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const DEFAULT_PRODUCTION_URL = "https://evolvra-seven.vercel.app";
const ROUTES = ["/", "/goals", "/quests", "/stats", "/reviews", "/timeline", "/settings"];
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ],
  "x-content-type-options": ["nosniff"],
  "x-frame-options": ["DENY"],
  "referrer-policy": ["strict-origin-when-cross-origin"],
  "permissions-policy": ["camera=()", "microphone=()", "geolocation=()"],
  "strict-transport-security": ["max-age="],
};

function productionOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Production synthetic URL must not contain credentials, a query, or a fragment.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && process.env.EVOLVRA_ALLOW_INSECURE_LOCAL === "true")) {
    throw new Error("Production synthetic checks require HTTPS.");
  }
  return url.origin;
}

async function request(origin, path, init) {
  const response = await fetch(new URL(path, origin), {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
  return response;
}

function requireStatus(response, expected, label) {
  if (!expected.includes(response.status)) {
    throw new Error(`${label} returned ${response.status}; expected ${expected.join(" or ")}.`);
  }
}

function requireContentType(response, expected, label) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!expected.some((value) => contentType.includes(value))) {
    throw new Error(`${label} returned unexpected Content-Type ${contentType || "(missing)"}.`);
  }
}

function verifySecurityHeaders(response, label) {
  for (const [header, fragments] of Object.entries(SECURITY_HEADERS)) {
    const value = response.headers.get(header) ?? "";
    for (const fragment of fragments) {
      if (!value.toLowerCase().includes(fragment.toLowerCase())) {
        throw new Error(`${label} is missing ${header} fragment ${fragment}.`);
      }
    }
  }
  if (response.headers.has("x-powered-by")) {
    throw new Error(`${label} exposes X-Powered-By.`);
  }
  const robots = response.headers.get("x-robots-tag") ?? "";
  if (robots && !robots.toLowerCase().includes("noindex")) {
    throw new Error(`${label} returned an unexpected X-Robots-Tag.`);
  }
}

async function checkRoutes(origin) {
  for (const path of ROUTES) {
    const response = await request(origin, path);
    requireStatus(response, [200], path);
    requireContentType(response, ["text/html"], path);
    verifySecurityHeaders(response, path);
    const html = await response.text();
    if (!html.includes("Evolvra")) throw new Error(`${path} did not contain the application identity.`);
  }
}

async function checkManifest(origin) {
  const response = await request(origin, "/manifest.webmanifest");
  requireStatus(response, [200], "manifest");
  requireContentType(response, ["application/manifest+json", "application/json"], "manifest");
  const manifest = await response.json();
  if (manifest.name !== "Evolvra · Personal Command Centre") {
    throw new Error("Production manifest has an unexpected application name.");
  }
  if (manifest.start_url !== "/" || manifest.scope !== "/" || manifest.display !== "standalone") {
    throw new Error("Production manifest has unsafe install navigation settings.");
  }
  const expectedIcons = new Map([
    ["/icon-192.png", "any"],
    ["/icon-512.png", "any"],
    ["/icon-maskable-512.png", "maskable"],
  ]);
  for (const [src, purpose] of expectedIcons) {
    const icon = manifest.icons?.find((item) => item.src === src);
    if (!icon || icon.purpose !== purpose) {
      throw new Error(`Production manifest is missing ${purpose} icon ${src}.`);
    }
    const iconResponse = await request(origin, src);
    requireStatus(iconResponse, [200], src);
    requireContentType(iconResponse, ["image/png"], src);
    if (Number(iconResponse.headers.get("content-length") ?? "0") === 0) {
      const bytes = await iconResponse.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error(`${src} is empty.`);
    }
  }
}

function workerVersion(source, label) {
  const version = /WORKER_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1];
  if (!version) throw new Error(`${label} does not expose a readable version.`);
  return version;
}

async function expectedWorkerVersion() {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  return workerVersion(source, "Committed service worker");
}

async function checkWorker(origin, expectedVersion) {
  const response = await request(origin, "/sw.js", { cache: "no-store" });
  requireStatus(response, [200], "service worker");
  requireContentType(response, ["javascript"], "service worker");
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (!cacheControl.includes("no-cache") && !cacheControl.includes("max-age=0")) {
    throw new Error("Service worker is not served with an update-safe cache policy.");
  }
  const source = await response.text();
  const requiredSafetyMarkers = [
    "WORKER_VERSION",
    "\"/callback\"",
    "\"/api\"",
    "access_token",
    "OFFLINE_FALLBACK_URL",
  ];
  for (const marker of requiredSafetyMarkers) {
    if (!source.includes(marker)) throw new Error(`Service worker is missing safety marker ${marker}.`);
  }
  const version = workerVersion(source, "Production service worker");
  if (version !== expectedVersion) {
    throw new Error(
      `Production service worker ${version} does not match committed version ${expectedVersion}.`,
    );
  }
  return version;
}

async function checkTelemetryRejection(origin) {
  const response = await request(origin, "/api/telemetry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://evolvra-synthetic.invalid",
      "sec-fetch-site": "cross-site",
    },
    body: JSON.stringify({
      kind: "web-vital",
      name: "LCP",
      value: 1,
      rating: "good",
    }),
  });
  // Telemetry disabled: 204. Telemetry enabled: cross-origin provenance is
  // rejected before parsing or logging: 403.
  requireStatus(response, [204, 403], "telemetry privacy probe");
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (!cacheControl.includes("no-store")) {
    throw new Error("Telemetry response is missing Cache-Control: no-store.");
  }
}

export async function runProductionSynthetic(
  value = process.env.EVOLVRA_PRODUCTION_URL ?? DEFAULT_PRODUCTION_URL,
) {
  const origin = productionOrigin(value);
  const expectedVersion = await expectedWorkerVersion();
  await checkRoutes(origin);
  await checkManifest(origin);
  const deployedWorkerVersion = await checkWorker(origin, expectedVersion);
  await checkTelemetryRejection(origin);
  return {
    origin,
    routeCount: ROUTES.length,
    workerVersion: deployedWorkerVersion,
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  runProductionSynthetic()
    .then(({ origin, routeCount, workerVersion }) => {
      console.log(`Production synthetic passed: ${origin}`);
      console.log(`Routes: ${routeCount}; service worker: ${workerVersion}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
