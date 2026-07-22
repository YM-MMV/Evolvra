import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["app", "components", "lib"];
const sourceExtension = /\.(?:ts|tsx)$/;
const integrationLanguage = /\b(?:openai|anthropic|chatgpt|claude|gemini|mistral|cohere|ollama|langchain|llamaindex|llm|large language model|generative ai)\b/i;
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
      if (integrationLanguage.test(line)) findings.push(`${candidate}:${index + 1}: ${line.trim()}`);
    });
  }
}

for (const root of roots) await visit(root);

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const dependency of Object.keys(packageJson[section] ?? {})) {
    if (integrationLanguage.test(dependency)) findings.push(`package.json:${section}: ${dependency}`);
  }
}

if (findings.length) {
  console.error("AI integration entered product runtime code or direct dependencies:\n");
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log("No AI integration found in product runtime code or direct dependencies.");
