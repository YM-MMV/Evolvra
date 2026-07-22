import { expect, test } from "@playwright/test";
import { completeOnboarding, readAnonymousWorkspaceState } from "./helpers";

test("a production service worker serves a visited goal route offline and keeps an unvisited route safe", async ({ context, page }) => {
  await completeOnboarding(page, { name: "Offline Tester", starter: true });

  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), {
    message: "the production service worker should control the application",
    timeout: 30_000,
  }).toBe(true);

  await page.goto("/goals");
  const visitedPath = await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).getAttribute("href");
  expect(visitedPath).toMatch(/^\/goals\/[0-9a-f-]+$/i);
  if (!visitedPath) throw new Error("Starter goal route was not available.");
  await page.goto(visitedPath);
  await expect(page.getByRole("heading", { name: "Build dependable cardiovascular fitness" })).toBeVisible();

  await context.setOffline(true);
  await page.goto(`${visitedPath}?offline-check=1`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Build dependable cardiovascular fitness" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${visitedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?offline-check=1$`));

  await page.goto("/goals/not-visited-offline", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "This page is not available offline yet." })).toBeVisible();
});

test("an offline goal edit survives reload and remains after reconnect", async ({ context, page }) => {
  await completeOnboarding(page, { name: "Offline Editor", starter: true });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)), { timeout: 30_000 }).toBe(true);

  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
  await expect(page.getByRole("heading", { name: "Build dependable cardiovascular fitness" })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const navigationCache = (await caches.keys()).find((name) => name.startsWith("evolvra-navigation-"));
    if (!navigationCache) return false;
    const cache = await caches.open(navigationCache);
    const request = new Request(`${location.origin}${location.pathname}`, { headers: { accept: "text/html" } });
    return Boolean(await cache.match(request));
  }), { message: "the client-visited goal route should be cached before going offline" }).toBe(true);

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
