import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  completeOnboarding,
  readAnonymousWorkspaceState,
} from "./helpers";

async function addBackgroundSentinel(page: Page) {
  await page.evaluate(() => {
    const sentinel = document.createElement("button");
    sentinel.id = "recovery-background-sentinel";
    sentinel.setAttribute("aria-hidden", "false");
    sentinel.textContent = "Underlying application control";
    document.body.append(sentinel);
  });
  const sentinel = page.locator("#recovery-background-sentinel");
  await expect(sentinel).toHaveAttribute("inert", "");
  await expect(sentinel).toHaveAttribute("aria-hidden", "true");
  return sentinel;
}

async function expectMandatoryDialog(dialog: Locator) {
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toBeFocused();
  await dialog.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
}

async function insertPendingAccountErasure(page: Page) {
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
          cloud: "pending",
          local: "pending",
          session: "pending",
          persistenceGeneration: 2,
          owner: null,
          updatedAt,
        });
      };
    });
  });
}

async function clearPendingAccountErasure(page: Page) {
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
        transaction.objectStore("account-erasure-checkpoints").delete("account-a");
        transaction.objectStore("account-scopes").delete("account-a");
        transaction.onerror = () => reject(transaction.error ?? new Error("Recovery fixture cleanup failed."));
        transaction.oncomplete = () => {
          database.close();
          window.dispatchEvent(new CustomEvent("evolvra:account-erasure-change"));
          resolve();
        };
      };
    });
  });
}

async function quarantineAnonymousWorkspace(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("evolvra-persistence");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction("workspaces", "readwrite");
        const store = transaction.objectStore("workspaces");
        const read = store.get("anonymous");
        read.onerror = () => reject(read.error ?? new Error("Workspace fixture could not be read."));
        read.onsuccess = () => {
          const raw = structuredClone(read.result);
          raw.history = [structuredClone(raw.state)];
          raw.state.version = 99;
          store.put(raw);
        };
        transaction.onerror = () => reject(transaction.error ?? new Error("Quarantine fixture failed."));
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
      };
    });
  });
}

test("bootstrap recovery owns focus, traps it, and restores exact background attributes", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("evolvra:account-erasure-checkpoints:v1", "{");
  });
  await page.goto("/");

  const dialog = page.getByRole("alertdialog", {
    name: "Account cleanup must be resolved first",
  });
  await expectMandatoryDialog(dialog);
  await expect(dialog).toContainText(/legacy account-cleanup record is damaged/i);

  const sentinel = await addBackgroundSentinel(page);
  const repair = dialog.getByRole("button", {
    name: "Discard damaged record and restart fenced cleanup",
  });
  await page.keyboard.press("Shift+Tab");
  await expect(repair).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(repair).toBeFocused();

  await repair.click();
  await expect(page.getByRole("heading", {
    name: "Build a life you can see evolving.",
  })).toBeVisible();
  await expect(sentinel).not.toHaveAttribute("inert", "");
  await expect(sentinel).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

test("terminal erasure recovery isolates the live app and cannot be dismissed", async ({ page }) => {
  await completeOnboarding(page, { name: "Terminal Recovery", starter: false });
  await insertPendingAccountErasure(page);
  await page.reload();

  const dialog = page.getByRole("alertdialog", {
    name: "Account cleanup needs attention",
  });
  await expectMandatoryDialog(dialog);
  await expect(dialog).toContainText(/cloud step did not finish/i);
  await expect(page.locator(".app-layout")).toHaveAttribute("inert", "");
  await expect(page.locator(".app-layout")).toHaveAttribute("aria-hidden", "true");

  const retry = dialog.getByRole("button", { name: "Retry exact account deletion" });
  const email = dialog.getByLabel("Email for the exact fenced account");
  await page.keyboard.press("Shift+Tab");
  await expect(retry).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(email).toBeFocused();

  await clearPendingAccountErasure(page);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".app-layout")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".app-layout")).not.toHaveAttribute("aria-hidden", "true");
});

test("quarantined recovery traps focus and restores dynamic background state", async ({ page }) => {
  await completeOnboarding(page, { name: "Quarantine Recovery", starter: false });
  const validBackup = await readAnonymousWorkspaceState(page);
  await quarantineAnonymousWorkspace(page);
  await page.reload();

  const dialog = page.getByRole("alertdialog", {
    name: "This device copy needs recovery",
  });
  await expectMandatoryDialog(dialog);
  await expect(dialog).toContainText(/version 99.*newer/i);

  const sentinel = await addBackgroundSentinel(page);
  const erase = dialog.getByRole("button", { name: "Erase device copy" });
  const download = dialog.getByRole("button", { name: "Download damaged copy" });
  await page.keyboard.press("Shift+Tab");
  await expect(erase).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(download).toBeFocused();

  await dialog.locator("input[type=file]").setInputFiles({
    name: "valid-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(validBackup)),
  });
  await expect(dialog).toHaveCount(0);
  await expect(sentinel).not.toHaveAttribute("inert", "");
  await expect(sentinel).toHaveAttribute("aria-hidden", "false");
});

test("terminal recovery stays above a simultaneous quarantined recovery", async ({ page }) => {
  await completeOnboarding(page, { name: "Layered Recovery", starter: false });
  await insertPendingAccountErasure(page);
  await quarantineAnonymousWorkspace(page);
  await page.reload();

  const terminal = page.locator("[role=alertdialog]").filter({
    hasText: "Account cleanup needs attention",
  });
  const quarantine = page.locator("[role=alertdialog]").filter({
    hasText: "This device copy needs recovery",
  });
  await expect(terminal).toBeVisible();
  await expect(quarantine).toBeAttached();
  await expect(terminal).toBeFocused();
  await expect(terminal).not.toHaveAttribute("inert", "");
  await expect(quarantine).toHaveAttribute("inert", "");
  await expect(quarantine).toHaveAttribute("aria-hidden", "true");

  const layers = await page.evaluate(() => {
    const terminalDialog = document.querySelector<HTMLElement>(
      "[data-recovery-layer='terminal']",
    );
    const quarantineDialog = document.querySelector<HTMLElement>(
      "[data-recovery-layer='quarantine']",
    );
    return {
      terminal: Number(getComputedStyle(terminalDialog!).zIndex),
      quarantine: Number(getComputedStyle(quarantineDialog!).zIndex),
    };
  });
  expect(layers.terminal).toBeGreaterThan(layers.quarantine);

  await clearPendingAccountErasure(page);
  await expect(terminal).toHaveCount(0);
  await expect(quarantine).not.toHaveAttribute("inert", "");
  await expect(quarantine).toBeFocused();
});

test("modal cleanup cannot release an active recovery barrier", async ({ page }) => {
  await completeOnboarding(page, { name: "Owned Recovery", starter: false });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Data & recovery" }).click();
  await page.getByRole("button", { name: "Erase everything" }).click();
  const modal = page.getByRole("dialog", {
    name: "Erase your Evolvra workspace?",
  });
  await expect(modal).toBeVisible();
  await expect(page.locator(".skip-link")).toHaveAttribute("inert", "");
  await expect(page.locator(".skip-link")).toHaveAttribute("aria-hidden", "true");
  await page.locator(".skip-link").evaluate((link: HTMLElement) => link.focus());
  await expect.poll(() => modal.evaluate((dialog) =>
    dialog.contains(document.activeElement))).toBe(true);

  await insertPendingAccountErasure(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("evolvra:account-erasure-change"));
  });
  const recovery = page.getByRole("alertdialog", {
    name: "Account cleanup needs attention",
  });
  await expect(recovery).toBeVisible();
  await expect(recovery).toBeFocused();

  await page.locator(".modal button").filter({
    hasText: "Keep my data",
  }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator(".app-layout")).toHaveAttribute("inert", "");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(recovery).toBeFocused();

  await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>(".app-layout")!;
    app.removeAttribute("inert");
    app.querySelector<HTMLElement>("button, a")?.focus();
  });
  await expect(page.locator(".app-layout")).toHaveAttribute("inert", "");
  await expect(recovery).toBeFocused();

  const browserKeptAdvancing = await page.evaluate(async () => {
    let timerFired = false;
    window.setTimeout(() => {
      timerFired = true;
    }, 20);
    const mutation = document.createElement("div");
    document.body.append(mutation);
    mutation.style.opacity = "0.99";
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    mutation.remove();
    return timerFired;
  });
  expect(browserKeptAdvancing).toBe(true);

  await clearPendingAccountErasure(page);
  await expect(recovery).toHaveCount(0);
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});
