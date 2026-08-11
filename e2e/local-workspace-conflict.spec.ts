import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { completeOnboarding } from "./helpers";

test("a stale tab cannot overwrite a newer IndexedDB workspace", async ({ context, page }) => {
  await completeOnboarding(page, { name: "Shared start", starter: false, birthDate: "" });

  const staleTab = await context.newPage();
  await staleTab.goto("/settings");
  await expect(staleTab.getByRole("heading", { name: "Profile & chapter" })).toBeVisible();
  await expect(staleTab.getByLabel("Display name")).toHaveValue("Shared start");

  await page.goto("/settings");
  await page.getByLabel("Display name").fill("Saved by the first tab");
  await page.getByLabel("Display name").press("Tab");
  await expect.poll(() => page.evaluate(async () => await new Promise<string | undefined>((resolve) => {
    const request = indexedDB.open("evolvra-persistence");
    request.onerror = () => resolve(undefined);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("workspaces", "readonly");
      const read = transaction.objectStore("workspaces").get("anonymous");
      read.onerror = () => {
        database.close();
        resolve(undefined);
      };
      read.onsuccess = () => {
        const displayName = read.result?.state?.profile?.displayName as string | undefined;
        database.close();
        resolve(displayName);
      };
    };
  })), { message: "the first tab should win the atomic local save" }).toBe("Saved by the first tab");

  await staleTab.getByLabel("Display name").fill("Unsaved in the stale tab");
  await staleTab.getByLabel("Display name").press("Tab");

  const conflict = staleTab.getByRole("alertdialog", { name: "This workspace changed in another tab" });
  await expect(conflict).toBeVisible();
  const exportButton = conflict.getByRole("button", { name: "Download unsaved memory copy" });
  const reloadButton = conflict.getByRole("button", { name: "Reload latest device copy" });
  await expect(conflict).toBeFocused();
  await staleTab.keyboard.press("Tab");
  await expect(exportButton).toBeFocused();
  await staleTab.keyboard.press("Shift+Tab");
  await expect(reloadButton).toBeFocused();

  const downloadEvent = staleTab.waitForEvent("download");
  await exportButton.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^evolvra-unsaved-memory-\d{4}-\d{2}-\d{2}\.json$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exportedText = await readFile(downloadPath!, "utf8");
  const exported = JSON.parse(exportedText) as { profile?: { displayName?: string } };
  expect(exported.profile?.displayName).toBe("Unsaved in the stale tab");
  expect(exportedText).not.toContain("localRevision");
  expect(exportedText).not.toContain("accountId");

  await reloadButton.click();
  await expect(staleTab.getByRole("heading", { name: "Profile & chapter" })).toBeVisible();
  await expect(staleTab.getByLabel("Display name")).toHaveValue("Saved by the first tab");
});
