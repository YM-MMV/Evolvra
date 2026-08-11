#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const sourceRoots = ["app", "components"];
const allowedCompatibilityFile = "components/app-context.tsx";
const violations = [];

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(path);
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry.name))) continue;
    const file = relative(root, path);
    if (file === allowedCompatibilityFile) continue;
    const source = readFileSync(path, "utf8");
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\buseApp\s*\(/.test(line) || /\buseApp\b/.test(line) && /import|export/.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

for (const sourceRoot of sourceRoots) visit(join(root, sourceRoot));

if (violations.length) {
  console.error(
    "The compatibility useApp context re-entered a consumer. Subscribe to "
      + "useWorkspaceData, useProviderStatus, and/or useAppActions instead:\n",
  );
  for (const violation of violations) console.error(violation);
  process.exit(1);
}

console.log("All application consumers use narrow provider contexts.");
