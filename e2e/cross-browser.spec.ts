import { expect, test } from "@playwright/test";
import { completeOnboarding, waitForAnonymousWorkspace } from "./helpers";

test("IndexedDB, evidence preview, and records export work across supported engines", async ({ page }) => {
  await completeOnboarding(page, { name: "Cross Browser", starter: true });
  await page.goto("/goals");
  await page.getByRole("link", {
    name: "Open goal: Build dependable cardiovascular fitness",
  }).click();

  const fileInput = page.locator('input[type="file"][accept*="text/plain"]');
  await fileInput.setInputFiles({
    name: "cross-browser-proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("IndexedDB evidence survives a real browser-engine reload."),
  });
  const previewButton = page.getByRole("button", {
    name: "Preview cross-browser-proof.txt",
  });
  await expect(previewButton).toBeVisible();
  // Metadata renders from the in-memory mutation before the coordinated file
  // operation is durable. Evidence controls stay disabled until the provider
  // has observed the IndexedDB transaction's `complete` event; reload only
  // after that explicit completion signal.
  await expect(previewButton).toBeEnabled();

  await page.reload();
  await waitForAnonymousWorkspace(page);
  await page.getByRole("button", {
    name: "Preview cross-browser-proof.txt",
  }).click();
  const preview = page.getByRole("dialog", { name: "cross-browser-proof.txt" });
  await expect(preview.getByText(
    "IndexedDB evidence survives a real browser-engine reload.",
  )).toBeVisible();
  await preview.getByRole("button", { name: "Close" }).click();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Data & recovery" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Records-only JSON backup/ }).click();
  const backup = await download;
  expect(backup.suggestedFilename()).toMatch(/^evolvra-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await backup.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    profile?: { displayName?: string };
    goals?: Array<{ evidence?: Array<{ name?: string; remotePath?: string }> }>;
  };
  expect(exported.profile?.displayName).toBe("Cross Browser");
  expect(exported.goals?.some((goal) =>
    goal.evidence?.some((item) =>
      item.name === "cross-browser-proof.txt" && !item.remotePath
    )
  )).toBe(true);
});

test("the safe application shell remains usable offline across supported engines", async ({ browserName, context, page }) => {
  await completeOnboarding(page, { name: "Offline Engine", starter: false });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Customise Evolvra" })).toBeVisible();

  await expect.poll(() => page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return true;
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 3_000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    return Boolean(navigator.serviceWorker.controller);
  }), {
    message: "the production service worker should control the browser before offline reload",
    timeout: 15_000,
  }).toBe(true);

  if (browserName === "webkit") {
    // Playwright's WebKit transport rejects every request before the service
    // worker when its synthetic offline switch is enabled. Verify the exact
    // cached document and every discovered build dependency here; real offline
    // reload remains a manual Safari/device release check.
    const cachedShellIsComplete = await page.evaluate(async () => {
      const response = await caches.match("/goals");
      if (!response?.ok) return false;
      const html = await response.clone().text();
      const assets = [...html.matchAll(/(?:src|href)=["']([^"'#]+)["']/gi)]
        .map((match) => new URL(match[1], location.origin))
        .filter((url) => url.origin === location.origin
          && url.pathname.startsWith("/_next/static/"));
      if (!assets.length) return false;
      return (await Promise.all(assets.map((url) => caches.match(url.href))))
        .every(Boolean);
    });
    expect(cachedShellIsComplete).toBe(true);
    await page.getByRole("button", { name: "Appearance" }).click();
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    return;
  }

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Customise Evolvra" })).toBeVisible();
    await page.getByRole("button", { name: "Appearance" }).click();
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
