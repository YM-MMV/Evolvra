import { expect, test } from "@playwright/test";

test("an all-complete ambiguous tombstone for another account does not block anonymous use", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();

  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("evolvra-persistence");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(
          ["account-scopes", "account-erasure-checkpoints"],
          "readwrite",
        );
        transaction.onerror = () => reject(transaction.error ?? new Error("Recovery fixture failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Recovery fixture aborted."));
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        const updatedAt = new Date(Date.now() - 60_000).toISOString();
        transaction.objectStore("account-scopes").put({
          accountId: "account-a",
          generation: 2,
          tombstoned: true,
          updatedAt,
        });
        transaction.objectStore("account-erasure-checkpoints").put({
          version: 2,
          accountId: "account-a",
          attemptId: "attempt-account-a",
          cloud: "ambiguous",
          local: "complete",
          session: "complete",
          persistenceGeneration: 2,
          owner: null,
          updatedAt,
        });
      };
    });
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();
  await expect(page.getByRole("alertdialog", { name: /account cleanup/i })).toHaveCount(0);
  await page.getByRole("button", { name: /Begin setup/ }).click();
  await expect(page.getByLabel("Display name")).toBeVisible();
});
