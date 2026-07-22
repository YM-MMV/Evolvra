import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const testsDirectory = path.join(process.cwd(), "supabase", "tests");
const sqlFiles = (await readdir(testsDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();

const violations = [];
let snapshotFixtureCount = 0;

for (const fileName of sqlFiles) {
  const source = await readFile(path.join(testsDirectory, fileName), "utf8");
  for (const match of source.matchAll(/"version"\s*:\s*(\d+)/g)) {
    snapshotFixtureCount += 1;
    if (Number(match[1]) !== 3) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${fileName}:${line} uses workspace state version ${match[1]}`);
    }
  }
}

if (snapshotFixtureCount === 0) {
  violations.push("no versioned workspace snapshot fixture was found");
}

if (violations.length) {
  console.error("Supabase SQL fixtures must use current workspace state version 3:");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exit(1);
}

console.log(`Validated ${snapshotFixtureCount} state-v3 SQL snapshot fixtures.`);
