import { expect, test, type Page } from "@playwright/test";
import { completeOnboarding, readAnonymousWorkspaceState } from "./helpers";

async function syncGoalRoutesFromPage(page: Page, paths: string[]) {
  return page.evaluate((nextPaths) => new Promise<{
    accepted: boolean;
    clientRequested: number;
    requested: number;
    cached: number;
    failed: number;
  }>((resolve, reject) => {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) {
      reject(new Error("No controlling service worker."));
      return;
    }
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => reject(new Error("Route synchronization timed out.")), 30_000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      resolve(event.data);
    };
    worker.postMessage({ type: "SYNC_WORKSPACE_GOAL_ROUTES", paths: nextPaths }, [channel.port2]);
  }), paths);
}

test("a production service worker prepares known goals offline without retaining arbitrary goal routes", async ({ context, page }) => {
  await completeOnboarding(page, { name: "Offline Tester", starter: true });

  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), {
    message: "the production service worker should control the application",
    timeout: 30_000,
  }).toBe(true);
  await expect(page.locator('[role="status"]').filter({
    hasText: "Offline support is ready for 3 current goals.",
  })).toBeAttached();

  await page.goto("/goals");
  const knownButUnvisitedPath = await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).getAttribute("href");
  expect(knownButUnvisitedPath).toMatch(/^\/goals\/[0-9a-f-]+$/i);
  if (!knownButUnvisitedPath) throw new Error("Starter goal route was not available.");
  const unknownPath = "/goals/not-in-current-workspace";

  await expect.poll(() => page.evaluate(async (path) => {
    const workspaceCache = (await caches.keys()).find((name) => name.startsWith("evolvra-workspace-routes-"));
    if (!workspaceCache) return false;
    const cache = await caches.open(workspaceCache);
    return Boolean(await cache.match(new Request(`${location.origin}${path}`)));
  }, knownButUnvisitedPath), {
    message: "the worker should proactively prepare a current goal that was never opened",
    timeout: 30_000,
  }).toBe(true);

  // Even an online visit must not promote an arbitrary dynamic route into the
  // workspace manifest.
  await page.goto(unknownPath);
  await expect(page.getByRole("heading", { name: "Goal not found" })).toBeVisible();
  await expect.poll(() => page.evaluate(async (path) => {
    const matchingCaches = (await caches.keys()).filter((name) =>
      name.startsWith("evolvra-workspace-routes-")
      || name.startsWith("evolvra-navigation-")
      || name.startsWith("evolvra-precache-"));
    for (const cacheName of matchingCaches) {
      const cache = await caches.open(cacheName);
      if (await cache.match(new Request(`${location.origin}${path}`))) return true;
    }
    return false;
  }, unknownPath)).toBe(false);

  await context.setOffline(true);
  await page.goto(`${knownButUnvisitedPath}?offline-check=1`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Build dependable cardiovascular fitness" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${knownButUnvisitedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?offline-check=1$`));
  expect(await page.evaluate(async () => {
    const workspaceCache = (await caches.keys()).find((name) => name.startsWith("evolvra-workspace-routes-"));
    if (!workspaceCache) return false;
    const cache = await caches.open(workspaceCache);
    return Boolean(await cache.match(new Request(location.href)));
  })).toBe(false);

  await page.goto(unknownPath, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "This page is not available offline yet." })).toBeVisible();
});

test("one live tab cannot erase another tab's prepared goal routes", async ({ context, page }) => {
  await completeOnboarding(page, { name: "Multi-tab Offline", starter: true });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), {
    timeout: 30_000,
  }).toBe(true);
  await expect(page.locator('[role="status"]').filter({
    hasText: /Offline support is ready/,
  })).toBeAttached();

  const secondPage = await context.newPage();
  await secondPage.goto("/");
  await expect.poll(() => secondPage.evaluate(() => Boolean(navigator.serviceWorker?.controller)), {
    timeout: 30_000,
  }).toBe(true);
  await expect(secondPage.locator('[role="status"]').filter({
    hasText: /Offline support is ready/,
  })).toBeAttached();

  await expect(syncGoalRoutesFromPage(page, ["/goals/tab-a-only"]))
    .resolves.toMatchObject({ accepted: true, clientRequested: 1 });
  await expect(syncGoalRoutesFromPage(secondPage, ["/goals/tab-b-only"]))
    .resolves.toMatchObject({ accepted: true, clientRequested: 1, requested: 2, cached: 2 });
  await expect(syncGoalRoutesFromPage(page, []))
    .resolves.toMatchObject({ accepted: true, clientRequested: 0, requested: 1, cached: 1 });

  expect(await secondPage.evaluate(async () => {
    const cacheName = (await caches.keys()).find((name) => name.startsWith("evolvra-workspace-routes-"));
    if (!cacheName) return { tabA: false, tabB: false };
    const cache = await caches.open(cacheName);
    return {
      tabA: Boolean(await cache.match(new Request(`${location.origin}/goals/tab-a-only`))),
      tabB: Boolean(await cache.match(new Request(`${location.origin}/goals/tab-b-only`))),
    };
  })).toEqual({ tabA: false, tabB: true });
});

test("an offline goal edit survives reload and remains after reconnect", async ({ context, page }) => {
  await completeOnboarding(page, { name: "Offline Editor", starter: true });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 30_000 }).toBe(true);

  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
  await expect(page.getByRole("heading", { name: "Build dependable cardiovascular fitness" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const workspaceCache = (await caches.keys()).find((name) => name.startsWith("evolvra-workspace-routes-"));
    if (!workspaceCache) return false;
    const cache = await caches.open(workspaceCache);
    const request = new Request(`${location.origin}${location.pathname}`, { headers: { accept: "text/html" } });
    return Boolean(await cache.match(request));
  }), { message: "the current workspace goal route should be cached before going offline" }).toBe(true);

  await context.setOffline(true);
  await page.getByRole("button", { name: "More goal actions" }).click();
  await page.getByRole("button", { name: "Edit goal" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit goal" });
  await dialog.getByLabel("Goal title").fill("Build calm cardiovascular fitness");
  await dialog.getByRole("button", { name: "Save goal" }).click();
  await expect(page.getByRole("heading", { name: "Build calm cardiovascular fitness" })).toBeVisible();
  await expect.poll(async () => {
    const state = await readAnonymousWorkspaceState(page) as { goals?: Array<{ title?: string }> };
    return state.goals?.some((goal) => goal.title === "Build calm cardiovascular fitness") ?? false;
  }, { message: "the offline edit should be durable before reload" }).toBe(true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Build calm cardiovascular fitness" })).toBeVisible();

  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build calm cardiovascular fitness" })).toBeVisible();
});
