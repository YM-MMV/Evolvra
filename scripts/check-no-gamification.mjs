import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["app", "components", "lib"];
const sourceExtension = /\.(?:ts|tsx)$/;
const retiredLanguage = /\b(?:xp|levels?|scoring|rewards?|awards?|achievements?|gamification|streaks?)\b|gameIntensity/i;
const permittedCompatibilityLines = new Map([
  [path.normalize("lib/state-schema.ts"), new Set([
    'const migratedKey = key === "achievement" ? "meaning" : key;',
    "value.interfaceIntensity ?? value.gameIntensity,",
    'assertEnumField(settings, "gameIntensity", "workspace.settings", INTERFACE_INTENSITIES);',
    'const legacyRemovedType = version === 1 && event.type === "level";',
  ])],
]);
const findings = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(candidate);
      continue;
    }
    if (!sourceExtension.test(candidate) || candidate.endsWith(".test.ts") || candidate.endsWith(".test.tsx")) continue;
    const lines = (await readFile(candidate, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      const productLanguage = line.replaceAll(/row-level/gi, "row security");
      const trimmed = line.trim();
      const compatibilityAllowed = permittedCompatibilityLines
        .get(path.normalize(candidate))
        ?.has(trimmed) ?? false;
      if (retiredLanguage.test(productLanguage) && !compatibilityAllowed) {
        findings.push(`${candidate}:${index + 1}: ${trimmed}`);
      }
    });
  }
}

for (const root of roots) await visit(root);

if (findings.length) {
  console.error("Retired gamification language or mechanics re-entered product runtime code:\n");
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log("No XP, level, scoring, reward, award, or achievement product runtime found.");
