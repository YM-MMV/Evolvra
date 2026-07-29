import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["app", "components", "lib", "public"];
const explicitFiles = ["next.config.ts"];
const sourceExtension = /\.(?:ts|tsx|js|mjs|css|svg|html)$/;
const integrationLanguage = /\b(?:openai|anthropic|chatgpt|claude|gemini|mistral|cohere|ollama|langchain|llamaindex|llm|large language model|generative ai)\b/i;
const findings = [];

async function inspectFile(candidate) {
  if (!sourceExtension.test(candidate) || /\.(?:test|spec)\.[^.]+$/.test(candidate)) return;
  const lines = (await readFile(candidate, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (integrationLanguage.test(line)) findings.push(`${candidate}:${index + 1}: ${line.trim()}`);
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

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const dependency of Object.keys(packageJson[section] ?? {})) {
    if (integrationLanguage.test(dependency)) findings.push(`package.json:${section}: ${dependency}`);
  }
}

const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
for (const packagePath of Object.keys(packageLock.packages ?? {})) {
  const dependency = packagePath.replace(/^node_modules\//, "");
  if (dependency && integrationLanguage.test(dependency)) {
    findings.push(`package-lock.json: ${dependency}`);
  }
}

if (findings.length) {
  console.error("AI integration entered product/static code or the dependency tree:\n");
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log("No AI integration found in product/static code or the dependency tree.");
