import { readFile, stat } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { inspectPortableWorkspaceArchive } from "../lib/portable-workspace-archive";
import type { AppState } from "../lib/types";
import {
  completeOnboarding,
  readAnonymousWorkspaceState,
  seriousAxeViolations,
} from "./helpers";

async function readAnonymousResetStores(page: Page) {
  return page.evaluate(async () => new Promise<{
    hasWorkspace: boolean;
    displayName: string | null;
    localRevision: number;
    scopeGeneration: number;
    evidence: Array<{ evidenceId: string; text: string }>;
    reminderDate: string | null;
  }>((resolve, reject) => {
    const open = indexedDB.open("evolvra-persistence");
    open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction(
        ["workspaces", "evidence", "account-scopes", "account-reminders"],
        "readonly",
      );
      const workspace = transaction.objectStore("workspaces").get("anonymous");
      const evidence = transaction.objectStore("evidence").index("by-account").getAll("anonymous");
      const scope = transaction.objectStore("account-scopes").get("anonymous");
      const reminder = transaction.objectStore("account-reminders").get("anonymous");
      transaction.onerror = () => reject(transaction.error ?? new Error("Reset stores could not be inspected."));
      transaction.oncomplete = () => {
        const records = evidence.result as Array<{
          evidenceId: string;
          blob?: Blob;
          bytes?: ArrayBuffer;
          mimeType?: string;
        }>;
        Promise.all(records.map(async (record) => ({
          evidenceId: record.evidenceId,
          text: await (record.blob
            ?? new Blob([record.bytes ?? new ArrayBuffer(0)], {
              type: record.mimeType ?? "application/octet-stream",
            })).text(),
        }))).then((evidenceRecords) => {
          database.close();
          resolve({
            hasWorkspace: workspace.result !== undefined,
            displayName: workspace.result?.state?.profile?.displayName ?? null,
            localRevision: workspace.result?.localRevision ?? 0,
            scopeGeneration: scope.result?.generation ?? 0,
            evidence: evidenceRecords,
            reminderDate: reminder.result?.dateKey ?? null,
          });
        }, reject);
      };
    };
  }));
}

async function seedAnonymousReminder(page: Page, dateKey: string) {
  await page.evaluate(async (date) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("evolvra-persistence");
    open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("account-reminders", "readwrite");
      transaction.objectStore("account-reminders").put({
        accountId: "anonymous",
        dateKey: date,
        updatedAt: new Date().toISOString(),
      });
      transaction.onerror = () => reject(transaction.error ?? new Error("Reminder fixture failed."));
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
    };
  }), dateKey);
}

test("a projected capacity warning offers an explicit backup-and-reset recovery", async ({ page }) => {
  await completeOnboarding(page, {
    name: "Capacity Recovery Tester",
    starter: false,
  });
  const backup = await readAnonymousWorkspaceState(page) as AppState;
  const now = new Date().toISOString();
  backup.updatedAt = now;
  backup.timeline = Array.from({ length: 700 }, (_, index) => ({
    id: `capacity-recovery-event-${String(index).padStart(4, "0")}`,
    type: "note" as const,
    title: "Capacity recovery fixture",
    detail: "x".repeat(5_000),
    at: now,
  }));

  await page.goto("/settings");
  await page.getByRole("button", { name: "Data & recovery" }).click();
  await page.locator('input[type="file"][accept*="json"]').setInputFiles({
    name: "near-capacity-evolvra-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator(".toast-message")).toContainText(
    "Workspace restored successfully.",
  );
  await page.getByRole("button", { name: "Data & recovery" }).click();

  const capacity = page.getByRole("alert", { name: "Workspace capacity" });
  await expect(capacity).toBeVisible();
  await expect(capacity).toContainText("Action needed");
  await expect(capacity).toContainText("Archive now");
  await expect(capacity.getByRole("progressbar")).toHaveAttribute(
    "aria-label",
    /\d+% of workspace capacity used/,
  );
  expect(await seriousAxeViolations(page)).toEqual([]);

  await capacity.getByRole("button", {
    name: "Archive and start fresh",
  }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Archive this workspace and start fresh?",
  });
  await expect(confirmation).toContainText(
    "complete, checksummed .evolvra backup",
  );
  const downloadPromise = page.waitForEvent("download");
  await confirmation.getByRole("button", {
    name: "Download full backup",
  }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^evolvra-full-backup-\d{4}-\d{2}-\d{2}\.evolvra$/,
  );
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect((await stat(downloadPath!)).size).toBeGreaterThan(0);
  const inspection = await inspectPortableWorkspaceArchive(
    new Blob([await readFile(downloadPath!)]),
  );
  expect(inspection.status).toBe("valid");
  if (inspection.status !== "valid") {
    throw new Error("Expected the capacity archive to pass inspection.");
  }
  expect(inspection.content.state.profile.displayName).toBe(
    "Capacity Recovery Tester",
  );
  expect(inspection.content.state.timeline).toHaveLength(700);

  await expect(confirmation).toContainText(
    "Confirm the downloaded backup before resetting",
  );
  expect((await readAnonymousWorkspaceState(page) as AppState).profile.displayName)
    .toBe("Capacity Recovery Tester");
  const beforeReset = await readAnonymousResetStores(page);
  await confirmation.getByRole("button", {
    name: "I have the backup — reset workspace",
  }).click();
  await expect(page.getByRole("heading", {
    name: "Build a life you can see evolving.",
  })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", {
    name: "Build a life you can see evolving.",
  })).toBeVisible();
  const afterReset = await readAnonymousResetStores(page);
  expect(afterReset).toMatchObject({
    hasWorkspace: false,
    evidence: [],
    reminderDate: null,
    scopeGeneration: beforeReset.scopeGeneration + 1,
  });
});

test("a backup-bound reset refuses a newer cross-tab revision without deleting any store", async ({ page, context }) => {
  await completeOnboarding(page, {
    name: "Reset Receipt Owner",
    starter: true,
  });
  await page.goto("/goals");
  await page.getByRole("link", {
    name: "Open goal: Build dependable cardiovascular fitness",
  }).click();
  await page.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
    name: "reset-proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("keep-this-proof"),
  });
  await expect(page.getByRole("button", { name: "Preview reset-proof.txt" }))
    .toBeVisible();
  await expect.poll(async () => {
    const snapshot = await readAnonymousResetStores(page);
    return snapshot.evidence.length;
  }).toBe(1);
  await seedAnonymousReminder(page, "2026-07-29");

  await page.goto("/settings");
  await page.getByRole("button", { name: "Data & recovery" }).click();
  await page.getByRole("button", { name: "Archive and start fresh" }).click();
  const resetDialog = page.getByRole("dialog", {
    name: "Archive this workspace and start fresh?",
  });
  const downloadPromise = page.waitForEvent("download");
  await resetDialog.getByRole("button", { name: "Download full backup" }).click();
  await downloadPromise;
  await expect(resetDialog).toContainText("Confirm the downloaded backup");
  const backedUp = await readAnonymousResetStores(page);

  const competingPage = await context.newPage();
  await competingPage.goto("/settings");
  await competingPage.getByRole("button", { name: "Profile" }).click();
  await competingPage.getByLabel("Display name").fill("Newer Cross Tab Copy");
  await competingPage.getByLabel("Display name").press("Tab");
  await expect.poll(async () => {
    const snapshot = await readAnonymousResetStores(competingPage);
    return snapshot.displayName === "Newer Cross Tab Copy"
      && snapshot.localRevision > backedUp.localRevision;
  }).toBe(true);

  await resetDialog.getByRole("button", {
    name: "I have the backup — reset workspace",
  }).click();
  await expect(page.getByRole("alertdialog", {
    name: "This workspace changed in another tab",
  })).toBeVisible();

  const preserved = await readAnonymousResetStores(competingPage);
  expect(preserved).toMatchObject({
    hasWorkspace: true,
    displayName: "Newer Cross Tab Copy",
    scopeGeneration: backedUp.scopeGeneration,
    reminderDate: "2026-07-29",
  });
  expect(preserved.evidence).toEqual([{
    evidenceId: expect.any(String),
    text: "keep-this-proof",
  }]);

  await page.getByRole("button", { name: "Reload latest device copy" }).click();
  await page.goto("/settings");
  await page.getByRole("button", { name: "Data & recovery" }).click();
  await page.getByRole("button", { name: "Archive and start fresh" }).click();
  await expect(page.getByRole("dialog", {
    name: "Archive this workspace and start fresh?",
  }).getByRole("button", { name: "Download full backup" })).toBeVisible();
});
