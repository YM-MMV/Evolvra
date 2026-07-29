import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
new vm.Script(source, { filename: "public/sw.js" });

const requiredSafetyMarkers = [
  "SENSITIVE_PATH_PREFIXES",
  "SENSITIVE_QUERY_KEYS",
  "response.ok",
  "content-type",
  "MAX_NAVIGATION_ENTRIES",
  "MAX_STATIC_ENTRIES",
  "MAX_WORKSPACE_GOAL_ROUTES",
  "WORKSPACE_ROUTES_CACHE_NAME",
  "BUILD_ASSET_CACHE_NAME",
  "SYNC_WORKSPACE_GOAL_ROUTES",
  "OFFLINE_FALLBACK_URL",
  "expectedAssetKind",
  "requestUrl.search",
];

const missing = requiredSafetyMarkers.filter((marker) => !source.includes(marker));
if (missing.length) {
  console.error(`Service-worker safety checks are missing: ${missing.join(", ")}`);
  process.exitCode = 1;
} else if (/cache\.put\(event\.request/.test(source)) {
  console.error("Service worker must not cache every event request without validation.");
  process.exitCode = 1;
} else {
  console.log("Service-worker syntax and safety markers passed.");
}
