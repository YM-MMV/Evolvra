import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { MAX_WORKSPACE_SERIALIZED_BYTES } from "../lib/state-schema";
import { completeOnboarding, readAnonymousWorkspaceState } from "./helpers";

async function quarantineAnonymousWorkspace(
  page: Page,
  kind: "future" | "corrupt",
  includeEvidence = false,
) {
  await page.evaluate(async ({ kind, includeEvidence }) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("evolvra-persistence");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onsuccess = () => {
        const database = open.result;
        const stores = includeEvidence ? ["workspaces", "evidence"] : ["workspaces"];
        const transaction = database.transaction(stores, "readwrite");
        transaction.onerror = () => reject(transaction.error ?? new Error("Quarantine fixture failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Quarantine fixture aborted."));
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        const workspaceStore = transaction.objectStore("workspaces");
        const read = workspaceStore.get("anonymous");
        read.onerror = () => reject(read.error ?? new Error("Workspace fixture could not be read."));
        read.onsuccess = () => {
          const raw = structuredClone(read.result);
          if (kind === "future") {
            raw.history = [structuredClone(raw.state)];
            raw.state.version = 99;
          } else {
            raw.state.profile = null;
            raw.history = [{ broken: true }];
          }
          workspaceStore.put(raw);
          if (includeEvidence) {
            transaction.objectStore("evidence").put({
              accountId: "anonymous",
              goalId: "fixture-goal",
              evidenceId: "fixture-evidence",
              blob: new Blob(["device-only proof"], { type: "text/plain" }),
              savedAt: new Date().toISOString(),
            });
          }
        };
      };
    });
  }, { kind, includeEvidence });
}

async function readAnonymousPersistenceCounts(page: Page) {
  return page.evaluate(async () => {
    return await new Promise<{ workspace: number; evidence: number }>((resolve, reject) => {
      const open = indexedDB.open("evolvra-persistence");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(["workspaces", "evidence"], "readonly");
        const workspace = transaction.objectStore("workspaces").count("anonymous");
        const evidence = transaction.objectStore("evidence").index("by-account").count("anonymous");
        transaction.onerror = () => reject(transaction.error ?? new Error("Persistence counts failed."));
        transaction.oncomplete = () => {
          database.close();
          resolve({ workspace: workspace.result, evidence: evidence.result });
        };
      };
    });
  });
}

async function readAnonymousLegacyImportState(page: Page) {
  return page.evaluate(async () => {
    return await new Promise<{
      journal: Record<string, unknown> | null;
      workspace: Record<string, unknown> | null;
      legacyRaw: string | null;
    }>((resolve, reject) => {
      const open = indexedDB.open("evolvra-persistence");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(
          ["legacy-import-claims", "workspaces"],
          "readonly",
        );
        const journal = transaction.objectStore("legacy-import-claims").get("anonymous");
        const workspace = transaction.objectStore("workspaces").get("anonymous");
        transaction.onerror = () => reject(transaction.error ?? new Error("Legacy import state could not be read."));
        transaction.oncomplete = () => {
          database.close();
          resolve({
            journal: (journal.result as Record<string, unknown> | undefined) ?? null,
            workspace: (workspace.result as Record<string, unknown> | undefined) ?? null,
            legacyRaw: localStorage.getItem("evolvra:workspace:v1"),
          });
        };
      };
    });
  });
}

async function rotateAnonymousPersistenceScope(page: Page, tombstoned: boolean) {
  return page.evaluate(async (fenced) => {
    return await new Promise<number>((resolve, reject) => {
      const open = indexedDB.open("evolvra-persistence");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction("account-scopes", "readwrite");
        const store = transaction.objectStore("account-scopes");
        const read = store.get("anonymous");
        let generation = 0;
        read.onerror = () => reject(read.error ?? new Error("The account scope could not be read."));
        read.onsuccess = () => {
          generation = Number(read.result?.generation ?? 0) + 1;
          store.put({
            accountId: "anonymous",
            generation,
            tombstoned: fenced,
            updatedAt: new Date().toISOString(),
          });
        };
        transaction.onerror = () => reject(transaction.error ?? new Error("The account scope could not be rotated."));
        transaction.oncomplete = () => {
          database.close();
          resolve(generation);
        };
      };
    });
  }, tombstoned);
}

async function openStarterGoalWithEvidence(page: Page, filename: string) {
  await completeOnboarding(page, { name: "Evidence Fence", starter: true });
  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
  await page.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from("Generation-fenced evidence must never leak into a stale workspace."),
  });
  await expect(page.getByRole("button", { name: `Preview ${filename}` })).toBeVisible();
  expect((await readAnonymousPersistenceCounts(page)).evidence).toBe(1);
}

test("a pending legacy v1 import journal resumes after a crash without localStorage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();

  const legacyWorkspace = {
    version: 1,
    updatedAt: "2026-07-20T09:00:00.000Z",
    profile: {
      displayName: "Crash-safe legacy",
      chapter: "Keep the durable copy",
      onboarded: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    settings: {
      theme: "light",
      gameIntensity: "immersive",
      notifications: false,
      terminology: {
        goals: "Goals",
        quests: "Actions",
        areas: "Areas",
        milestones: "Milestones",
        stats: "Qualities",
      },
      scoring: { questCap: 70 },
    },
    areas: [{ id: "legacy-area", name: "Health", color: "#38D69B", icon: "Heart", order: 0 }],
    stats: [],
    goals: [],
    reviews: [],
    timeline: [],
    overallXp: 420,
  };
  const raw = JSON.stringify(legacyWorkspace);
  await page.evaluate(async (pendingRaw) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("evolvra-persistence");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(
          ["legacy-import-claims", "workspaces"],
          "readwrite",
        );
        transaction.objectStore("workspaces").delete("anonymous");
        transaction.objectStore("legacy-import-claims").put({
          accountId: "anonymous",
          status: "pending",
          raw: pendingRaw,
          capturedAt: "2026-07-20T09:01:00.000Z",
        });
        transaction.onerror = () => reject(transaction.error ?? new Error("The pending import fixture failed."));
        transaction.oncomplete = () => {
          database.close();
          localStorage.removeItem("evolvra:workspace:v1");
          resolve();
        };
      };
    });
  }, raw);

  await page.reload();
  await expect(page.getByText(/Good (morning|afternoon|evening), Crash-safe legacy/)).toBeVisible();

  const recovered = await readAnonymousLegacyImportState(page);
  expect(recovered.journal).toMatchObject({ accountId: "anonymous", status: "committed" });
  expect(recovered.journal).not.toHaveProperty("raw");
  expect(recovered.workspace?.state).toMatchObject({
    version: 3,
    profile: { displayName: "Crash-safe legacy" },
    settings: { interfaceIntensity: "immersive" },
  });
  expect(JSON.stringify(recovered.workspace)).not.toContain("overallXp");
  expect(recovered.legacyRaw).toBeNull();
});

test("explicitly discarding a corrupt legacy import prevents stale localStorage resurrection", async ({ page }) => {
  const corruptRaw = '{"version":1,"profile":';
  await page.addInitScript((raw) => {
    localStorage.setItem("evolvra:workspace:v1", raw);
  }, corruptRaw);
  await page.goto("/");

  const recovery = page.getByRole("alertdialog", { name: "This device copy needs recovery" });
  await expect(recovery).toBeVisible();
  const pending = await readAnonymousLegacyImportState(page);
  expect(pending.journal).toMatchObject({ accountId: "anonymous", status: "pending", raw: corruptRaw });

  page.once("dialog", (dialog) => dialog.accept());
  await recovery.getByRole("button", { name: "Erase device copy" }).click();
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();

  const discarded = await readAnonymousLegacyImportState(page);
  expect(discarded.journal).toMatchObject({ accountId: "anonymous", status: "disabled" });
  expect(discarded.journal).not.toHaveProperty("raw");
  expect(discarded.workspace).toBeNull();
  expect(discarded.legacyRaw).toBeNull();

  // The init script represents an old tab restoring the obsolete key before
  // the next bootstrap. The terminal journal must still win.
  await page.reload();
  await expect(recovery).toBeHidden();
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();
  const reopened = await readAnonymousLegacyImportState(page);
  expect(reopened.journal).toMatchObject({ accountId: "anonymous", status: "disabled" });
  expect(reopened.workspace).toBeNull();
  expect(reopened.legacyRaw).toBeNull();
});

for (const fence of [
  {
    label: "tombstoned",
    tombstoned: true,
    message: /permanently fenced after erasure/i,
  },
  {
    label: "rotated",
    tombstoned: false,
    message: /account scope changed in another tab/i,
  },
] as const) {
  test(`stale evidence reads and lists are rejected after the persistence generation is ${fence.label}`, async ({ page }) => {
    const filename = `${fence.label}-proof.txt`;
    await openStarterGoalWithEvidence(page, filename);
    await rotateAnonymousPersistenceScope(page, fence.tombstoned);

    await page.getByRole("button", { name: `Preview ${filename}` }).click();
    await expect(page.locator(".evidence-message")).toContainText(fence.message);
    await expect(page.getByRole("dialog", { name: filename })).toHaveCount(0);

    await page.getByRole("button", { name: /More goal actions/i }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Permanently delete" }).click();
    await expect(page.locator(".evidence-message")).toContainText(fence.message);
    await expect(page.getByRole("heading", { name: "Build dependable cardiovascular fitness" })).toBeVisible();
    expect((await readAnonymousPersistenceCounts(page)).evidence).toBe(1);

    const persisted = await readAnonymousWorkspaceState(page) as {
      goals: Array<{ title: string; evidence: Array<{ name?: string }> }>;
    };
    expect(persisted.goals.find((goal) => goal.title === "Build dependable cardiovascular fitness")?.evidence)
      .toEqual([expect.objectContaining({ name: filename })]);
  });
}

test("future device data stays quarantined across reload, exports raw, and only a durable valid restore clears it", async ({ page }) => {
  await completeOnboarding(page, { name: "Recovery Tester", starter: false });
  const validBackup = await readAnonymousWorkspaceState(page);
  await quarantineAnonymousWorkspace(page, "future");

  await page.reload();
  const recovery = page.getByRole("alertdialog", { name: "This device copy needs recovery" });
  await expect(recovery).toBeVisible();
  await expect(recovery).toContainText(/version 99.*newer/i);

  const downloadPromise = page.waitForEvent("download");
  await recovery.getByRole("button", { name: "Download damaged copy" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^evolvra-quarantined-\d{4}-\d{2}-\d{2}\.json$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const rawExport = JSON.parse(await readFile(downloadPath!, "utf8")) as { state: { version: number } };
  expect(rawExport.state.version).toBe(99);

  await page.reload();
  await expect(recovery).toBeVisible();
  const recoveryFile = recovery.locator("input[type=file]");
  await recoveryFile.setInputFiles({
    name: "oversized.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(MAX_WORKSPACE_SERIALIZED_BYTES + 1, 0x20),
  });
  await expect(recovery.getByRole("alert")).toContainText(/too large to import safely/i);
  await expect(recovery).toBeVisible();

  await recoveryFile.setInputFiles({
    name: "valid-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(validBackup)),
  });
  await expect(recovery).toBeHidden();
  await expect(page.getByText(/Good (morning|afternoon|evening), Recovery Tester/)).toBeVisible();

  await page.reload();
  await expect(recovery).toBeHidden();
  await expect(page.getByText(/Good (morning|afternoon|evening), Recovery Tester/)).toBeVisible();
  expect((await readAnonymousWorkspaceState(page) as { version: number }).version).toBe(3);
});

test("corrupt device data is never autosaved over and explicit erase removes its evidence atomically", async ({ page }) => {
  await completeOnboarding(page, { name: "Erase Recovery", starter: false });
  await quarantineAnonymousWorkspace(page, "corrupt", true);

  await page.reload();
  const recovery = page.getByRole("alertdialog", { name: "This device copy needs recovery" });
  await expect(recovery).toBeVisible();
  expect(await readAnonymousPersistenceCounts(page)).toEqual({ workspace: 1, evidence: 1 });

  page.once("dialog", (dialog) => dialog.accept());
  await recovery.getByRole("button", { name: "Erase device copy" }).click();
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();
  expect(await readAnonymousPersistenceCounts(page)).toEqual({ workspace: 0, evidence: 0 });

  await page.reload();
  await expect(recovery).toBeHidden();
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();
});

test("file metadata is durable before evidence operations report completion", async ({ page }) => {
  await completeOnboarding(page, { name: "Durability Tester", starter: true });
  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
  const addFile = page.getByRole("button", { name: "Add file" });
  const fileInput = page.locator('input[type="file"][accept*="text/plain"]');

  await fileInput.setInputFiles({
    name: "durable-proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Metadata must reach IndexedDB before this operation completes."),
  });
  await expect(addFile).toBeEnabled();
  await expect(page.getByRole("button", { name: "Preview durable-proof.txt" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Preview durable-proof.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Remove durable-proof.txt" }).click();
  await expect(page.getByRole("button", { name: "Preview durable-proof.txt" })).toHaveCount(0);
  await expect(addFile).toBeEnabled();

  await page.reload();
  await expect(page.getByRole("button", { name: "Preview durable-proof.txt" })).toHaveCount(0);
  const state = await readAnonymousWorkspaceState(page) as {
    goals: Array<{ title: string; evidence: Array<{ name?: string }> }>;
  };
  expect(state.goals.find((goal) =>
    goal.title === "Build dependable cardiovascular fitness")?.evidence).toEqual([]);
  expect((await readAnonymousPersistenceCounts(page)).evidence).toBe(0);
});
