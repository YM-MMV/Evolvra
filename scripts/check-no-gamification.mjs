import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["app", "components", "lib", "public"];
const explicitFiles = ["next.config.ts"];
const sourceExtension = /\.(?:ts|tsx|js|mjs|css|svg|html)$/;
const retiredLanguage = /(?:^|[^a-z0-9])(?:xp|levels?|scoring|rewards?|awards?|achievements?|gamification|streaks?)(?=$|[^a-z0-9])|game[_-]?intensity/i;
const permittedCompatibilityLines = new Map([
  [path.normalize("lib/state-schema.ts"), new Set([
    'const migratedKey = key === "achievement" ? "meaning" : key;',
    'if (!/\\bxp\\b/i.test(detail)) return detail;',
    "value.interfaceIntensity ?? value.gameIntensity,",
    'assertEnumField(settings, "gameIntensity", "workspace.settings", INTERFACE_INTENSITIES);',
    'const legacyRemovedType = version === 1 && event.type === "level";',
  ])],
]);
const findings = [];

async function inspectFile(candidate) {
  if (!sourceExtension.test(candidate) || /\.(?:test|spec)\.[^.]+$/.test(candidate)) return;
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

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(candidate);
      continue;
    }
    await inspectFile(candidate);
  }
}

for (const root of roots) await visit(root);
for (const file of explicitFiles) await inspectFile(file);

const removalMigration = await readFile(
  "supabase/migrations/202607180001_remove_legacy_gamification_columns.sql",
  "utf8",
);
for (const requiredRemoval of [
  "drop table if exists public.xp_transactions",
  "drop column if exists overall_xp",
  "drop column if exists xp_awarded",
  "drop column if exists scoring",
]) {
  if (!removalMigration.includes(requiredRemoval)) {
    findings.push(`retirement migration is missing: ${requiredRemoval}`);
  }
}

const namingMigration = await readFile(
  "supabase/migrations/202607270010_rename_interface_intensity.sql",
  "utf8",
);
if (!namingMigration.includes("rename column game_intensity to interface_intensity")) {
  findings.push("interface-intensity migration does not retire the legacy database name");
}

const migrationNames = (await readdir("supabase/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const namingMigrationName = "202607270010_rename_interface_intensity.sql";
for (const migrationName of migrationNames) {
  if (migrationName <= namingMigrationName) continue;
  const migration = await readFile(path.join("supabase/migrations", migrationName), "utf8");
  migration.split(/\r?\n/).forEach((line, index) => {
    if (retiredLanguage.test(line.replaceAll(/row-level/gi, "row security"))) {
      findings.push(`supabase/migrations/${migrationName}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (findings.length) {
  console.error("Retired gamification language or mechanics re-entered product/static/database surfaces:\n");
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log("No XP, level, scoring, reward, award, or achievement product/static/database surface found.");
