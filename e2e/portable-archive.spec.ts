import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";
import {
  createPortableWorkspaceArchive,
  inspectPortableWorkspaceArchive,
} from "../lib/portable-workspace-archive";
import type { AppState } from "../lib/types";
import {
  completeOnboarding,
  readAnonymousWorkspaceState,
} from "./helpers";

async function downloadedBytes(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("The browser did not retain the downloaded archive.");
  return readFile(path);
}

function archiveBlob(bytes: Buffer): Blob {
  const copy = Uint8Array.from(bytes);
  return new Blob([copy.buffer]);
}

async function openDataRecovery(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Data & recovery" }).click();
}

async function exportPortableArchive(page: Page): Promise<Buffer> {
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", {
    name: /Complete portable backup/,
  }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(
    /^evolvra-full-backup-\d{4}-\d{2}-\d{2}\.evolvra$/,
  );
  return downloadedBytes(download);
}

async function selectPortableArchive(page: Page, buffer: Buffer) {
  await page.getByTestId("portable-archive-input").setInputFiles({
    name: "workspace.evolvra",
    mimeType: "application/vnd.evolvra.workspace-archive",
    buffer,
  });
}

async function replacementArchive(
  source: AppState,
  label: "A" | "B",
): Promise<Buffer> {
  const state = structuredClone(source);
  const goal = structuredClone(state.goals[0]);
  if (!goal) throw new Error("The cross-tab archive fixture needs a starter goal.");
  const contents = `proof-${label}`;
  const goalId = `archive-${label.toLowerCase()}-goal`;
  const evidenceId = `archive-${label.toLowerCase()}-proof`;
  state.updatedAt = new Date().toISOString();
  state.profile.displayName = `Archive ${label}`;
  goal.id = goalId;
  goal.title = `Archive ${label} goal`;
  goal.evidence = [{
    id: evidenceId,
    type: "file",
    name: `proof-${label}.txt`,
    mimeType: "text/plain",
    size: Buffer.byteLength(contents),
  }];
  state.goals = [goal];
  state.questCompletions = [];
  state.metricEntries = [];
  state.reviews = [];
  state.timeline = [];
  const artifact = await createPortableWorkspaceArchive({
    state,
    sourceAccountId: "anonymous",
    evidence: [{
      accountId: "anonymous",
      goalId,
      evidenceId,
      blob: new Blob([contents], { type: "text/plain" }),
      savedAt: state.updatedAt,
    }],
    createdAt: state.updatedAt,
  });
  return Buffer.from(await artifact.blob.arrayBuffer());
}

async function readAnonymousPersistence(page: Page) {
  return page.evaluate(async () => new Promise<{
    displayName: string;
    localRevision: number;
    evidence: Array<{ goalId: string; evidenceId: string; text: string }>;
  }>((resolve, reject) => {
    const open = indexedDB.open("evolvra-persistence");
    open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(["workspaces", "evidence"], "readonly");
      const workspaceRequest = transaction.objectStore("workspaces").get("anonymous");
      const evidenceRequest = transaction.objectStore("evidence").index("by-account").getAll("anonymous");
      transaction.onerror = () => reject(transaction.error ?? new Error("Persistence inspection failed."));
      transaction.oncomplete = () => {
        const workspace = workspaceRequest.result;
        const records = evidenceRequest.result as Array<{
          goalId: string;
          evidenceId: string;
          blob?: Blob;
          bytes?: ArrayBuffer;
          mimeType?: string;
        }>;
        Promise.all(records.map(async (record) => ({
          goalId: record.goalId,
          evidenceId: record.evidenceId,
          text: await (record.blob
            ?? new Blob([record.bytes ?? new ArrayBuffer(0)], {
              type: record.mimeType ?? "application/octet-stream",
            })).text(),
        }))).then((evidence) => {
          database.close();
          resolve({
            displayName: workspace.state.profile.displayName as string,
            localRevision: workspace.localRevision as number,
            evidence,
          });
        }, reject);
      };
    };
  }));
}

test("a complete portable backup round-trips exact local evidence through merge", async ({ page }) => {
  await completeOnboarding(page, {
    name: "Portable Archive Owner",
    starter: true,
  });
  await page.goto("/goals");
  await page.getByRole("link", {
    name: "Open goal: Build dependable cardiovascular fitness",
  }).click();
  await page.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
    name: "proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("proof"),
  });
  await expect(page.getByRole("button", { name: "Preview proof.txt" }))
    .toBeVisible();

  await openDataRecovery(page);
  const bytes = await exportPortableArchive(page);
  const inspection = await inspectPortableWorkspaceArchive(archiveBlob(bytes));
  expect(inspection.status).toBe("valid");
  if (inspection.status !== "valid") {
    throw new Error("Expected the downloaded archive to be complete.");
  }
  expect(inspection.content.evidence).toHaveLength(1);
  expect(await inspection.content.evidence[0].blob.text()).toBe("proof");
  await expect(page.locator(".toast-message")).toContainText(
    "Complete portable backup downloaded",
  );

  await selectPortableArchive(page, bytes);
  const choice = page.getByRole("dialog", {
    name: "Merge or replace this workspace?",
  });
  await expect(choice).toContainText("passed its format, schema, metadata");
  await expect(choice).toContainText("1 evidence file");
  await choice.getByRole("button", {
    name: "Merge into this workspace",
  }).click();
  await expect(page.locator(".toast-message")).toContainText(
    "merged into this workspace with 1 evidence file",
  );

  const merged = await readAnonymousWorkspaceState(page) as AppState;
  expect(
    merged.goals.flatMap((goal) =>
      goal.evidence.filter((item) =>
        item.type === "file" && item.name === "proof.txt")),
  ).toHaveLength(2);
  await expect(page.getByRole("button", {
    name: "Undo most recent change",
  })).toHaveCount(0);
});

test("competing cross-tab archive restores commit one exact workspace-and-evidence transaction", async ({ page, context }) => {
  await completeOnboarding(page, {
    name: "Atomic Archive Owner",
    starter: true,
  });
  const source = await readAnonymousWorkspaceState(page) as AppState;
  const archiveA = await replacementArchive(source, "A");
  const archiveB = await replacementArchive(source, "B");
  await openDataRecovery(page);

  const competingPage = await context.newPage();
  await openDataRecovery(competingPage);
  await selectPortableArchive(page, archiveA);
  await selectPortableArchive(competingPage, archiveB);

  await page.getByRole("dialog", {
    name: "Merge or replace this workspace?",
  }).getByRole("button", { name: "Replace this workspace" }).click();
  await expect(page.locator(".toast-message")).toContainText(
    "replaced this workspace",
  );

  await competingPage.getByRole("dialog", {
    name: "Merge or replace this workspace?",
  }).getByRole("button", { name: "Replace this workspace" }).click();
  await expect(competingPage.getByRole("alertdialog", {
    name: "This workspace changed in another tab",
  })).toBeVisible();

  const verificationPage = await context.newPage();
  await verificationPage.goto("/");
  const persisted = await readAnonymousPersistence(verificationPage);
  expect(persisted.displayName).toBe("Archive A");
  expect(persisted.localRevision).toBeGreaterThan(0);
  expect(persisted.evidence).toEqual([{
    goalId: "archive-a-goal",
    evidenceId: "archive-a-proof",
    text: "proof-A",
  }]);
  expect(JSON.stringify(persisted)).not.toContain("proof-B");
});

test("replace is an explicit destructive choice and restores the archived records", async ({ page }) => {
  await completeOnboarding(page, {
    name: "Archived Identity",
    starter: false,
  });
  await openDataRecovery(page);
  const bytes = await exportPortableArchive(page);

  await page.getByRole("button", { name: "Profile" }).click();
  await page.getByLabel("Display name").fill("Edited Identity");
  await page.getByLabel("Display name").press("Tab");
  await expect(page.getByLabel("Display name")).toHaveValue("Edited Identity");
  await page.getByRole("button", { name: "Data & recovery" }).click();

  await selectPortableArchive(page, bytes);
  const choice = page.getByRole("dialog", {
    name: "Merge or replace this workspace?",
  });
  await expect(choice).toContainText("cannot be undone from recent history");
  await choice.getByRole("button", {
    name: "Replace this workspace",
  }).click();
  await expect(page.locator(".toast-message")).toContainText(
    "replaced this workspace",
  );
  await page.getByRole("button", { name: "Profile" }).click();
  await expect(page.getByLabel("Display name")).toHaveValue("Archived Identity");
  await expect(page.getByRole("button", {
    name: "Undo most recent change",
  })).toHaveCount(0);
});

test("tampered and incomplete portable files are rejected before a restore choice", async ({ page }) => {
  await completeOnboarding(page, {
    name: "Integrity Tester",
    starter: true,
  });
  await openDataRecovery(page);
  const complete = await exportPortableArchive(page);
  const tampered = Buffer.from(complete);
  tampered[tampered.length - 1] ^= 1;

  await selectPortableArchive(page, tampered);
  await expect(page.locator(".toast-message")).toContainText(
    "failed its integrity check",
  );
  await expect(page.getByRole("dialog", {
    name: "Merge or replace this workspace?",
  })).toHaveCount(0);

  const state = await readAnonymousWorkspaceState(page) as AppState;
  state.goals[0].evidence.push({
    id: "missing-proof",
    type: "file",
    name: "missing-proof.txt",
    mimeType: "text/plain",
    size: 5,
  });
  const incomplete = await createPortableWorkspaceArchive({
    state,
    sourceAccountId: "anonymous",
    evidence: [],
    createdAt: new Date().toISOString(),
  });
  await selectPortableArchive(
    page,
    Buffer.from(await incomplete.blob.arrayBuffer()),
  );
  await expect(page.locator(".toast-message")).toContainText(
    'does not contain bytes for "missing-proof.txt"',
  );
  await expect(page.getByRole("dialog", {
    name: "Merge or replace this workspace?",
  })).toHaveCount(0);
  expect((await readAnonymousWorkspaceState(page) as AppState).profile.displayName)
    .toBe("Integrity Tester");
});
