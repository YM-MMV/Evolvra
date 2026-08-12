#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const PROJECT_REF = "gmityvwkrhrraubhmyez";
const PRODUCTION_URL = "https://evolvra-seven.vercel.app";
const CONFIRMATION = "RUN_DISPOSABLE_PRODUCTION_CLOUD_E2E";
const SYNTHETIC_DOMAIN = "@evolvra.test";

function environmentFrom(source) {
  return Object.fromEntries(source
    .split(/\r?\n/)
    .filter((line) => line && !line.trimStart().startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) value = value.slice(1, -1);
      return [key, value];
    }));
}

async function collect(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}.`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`${command} exited with ${exitCode}.`);
  return stdout;
}

async function serviceRoleKey() {
  const stdout = await collect("npx", [
    "--yes",
    "supabase@2.109.1",
    "projects",
    "api-keys",
    "--project-ref",
    PROJECT_REF,
    "--output",
    "json",
  ]);
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : parsed.api_keys ?? parsed.keys ?? [];
  const entry = entries.find((candidate) => (
    (candidate.name ?? candidate.type ?? candidate.role) === "service_role"
  ));
  const key = entry?.api_key ?? entry?.key ?? entry?.value;
  if (typeof key !== "string" || !key) {
    throw new Error("The production service-role key was not available.");
  }
  return key;
}

async function evidencePaths(admin, accountId) {
  const folders = [accountId];
  const paths = [];
  while (folders.length) {
    const folder = folders.pop();
    let offset = 0;
    while (true) {
      const { data, error } = await admin.storage
        .from("evidence")
        .list(folder, { limit: 100, offset });
      if (error) throw error;
      const entries = data ?? [];
      for (const entry of entries) {
        const path = `${folder}/${entry.name}`;
        if (entry.id === null) folders.push(path);
        else paths.push(path);
      }
      if (entries.length < 100) break;
      offset += entries.length;
    }
  }
  return paths;
}

async function cleanupSyntheticAccounts(admin) {
  let page = 1;
  let removedUsers = 0;
  let removedObjects = 0;
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;
    const users = data.users ?? [];
    for (const user of users) {
      if (!user.email?.endsWith(SYNTHETIC_DOMAIN)) continue;
      const paths = await evidencePaths(admin, user.id);
      if (paths.length) {
        const { error: removeError } = await admin.storage.from("evidence").remove(paths);
        if (removeError) throw removeError;
        removedObjects += paths.length;
      }
      const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
      if (deleteError && !/not found/i.test(deleteError.message)) throw deleteError;
      removedUsers += 1;
    }
    if (users.length < 100) break;
    page += 1;
  }
  return { removedUsers, removedObjects };
}

async function main() {
  if (process.env.EVOLVRA_ALLOW_PRODUCTION_CLOUD_E2E !== CONFIRMATION) {
    throw new Error(
      `Set EVOLVRA_ALLOW_PRODUCTION_CLOUD_E2E=${CONFIRMATION} to run this production mutation smoke.`,
    );
  }
  const localEnvironment = environmentFrom(await readFile(".env.local", "utf8"));
  const apiUrl = localEnvironment.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = localEnvironment.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (
    !apiUrl
    || !anonKey
    || new URL(apiUrl).origin !== `https://${PROJECT_REF}.supabase.co`
  ) {
    throw new Error("The local public Supabase settings do not match production.");
  }

  const serviceKey = await serviceRoleKey();
  const admin = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const before = await cleanupSyntheticAccounts(admin);
  console.log(
    `Production cloud preflight cleanup: ${before.removedUsers} disposable users, ${before.removedObjects} objects.`,
  );

  let exitCode = 1;
  try {
    const child = spawn("npm", [
      "run",
      "test:e2e:production",
      "--",
      "e2e/cloud-integration.spec.ts",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: apiUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        EVOLVRA_ALLOW_PRODUCTION_CLOUD_E2E: CONFIRMATION,
        EVOLVRA_PRODUCTION_SUPABASE_PROJECT_REF: PROJECT_REF,
        EVOLVRA_PRODUCTION_URL: PRODUCTION_URL,
      },
      stdio: "inherit",
    });
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) reject(new Error(`Production cloud smoke stopped by ${signal}.`));
        else resolve(code ?? 1);
      });
    });
  } finally {
    const after = await cleanupSyntheticAccounts(admin);
    console.log(
      `Production cloud final cleanup: ${after.removedUsers} disposable users, ${after.removedObjects} objects.`,
    );
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
