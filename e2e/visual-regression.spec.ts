import { expect, test } from "@playwright/test";
import {
  completeOnboarding,
  readAnonymousWorkspaceState,
} from "./helpers";

const FIXED_NOW = new Date("2026-07-29T09:30:00.000Z");

const routes = [
  ["/", "What will move your life forward?", "dashboard"],
  ["/goals", "Your goals", "goals"],
  ["/quests", "Quests board", "actions"],
  ["/stats", "Your stats", "qualities"],
  ["/reviews", "Reviews", "reviews"],
  ["/timeline", "Timeline", "timeline"],
  ["/settings", "Customise Evolvra", "settings"],
] as const;

const visualMatrix = [
  {
    label: "dark desktop",
    slug: "dark-desktop",
    theme: "dark",
    viewport: { width: 1440, height: 1000 },
  },
  {
    label: "light desktop",
    slug: "light-desktop",
    theme: "light",
    viewport: { width: 1440, height: 1000 },
  },
  {
    label: "dark mobile",
    slug: "dark-mobile",
    theme: "dark",
    viewport: { width: 390, height: 844 },
  },
  {
    label: "light mobile",
    slug: "light-mobile",
    theme: "light",
    viewport: { width: 390, height: 844 },
  },
] as const;

for (const variant of visualMatrix) {
  test.describe(variant.label, () => {
    test.use({ viewport: variant.viewport });

    test("primary routes match the reviewed release surfaces", async ({ context, page }) => {
      // Seven full-page captures can exceed the default test timeout when the
      // complete browser matrix is sharing CI resources.
      test.slow();
      // This matrix reviews the normal online shell. Offline and partial PWA
      // banners have dedicated coverage, and inherited browser connectivity
      // must not decide whether a transient banner enters every baseline.
      await context.setOffline(false);
      await page.clock.setFixedTime(FIXED_NOW);
      await page.goto("/");
      await completeOnboarding(page, {
        name: "Visual Release",
        starter: true,
        birthDate: "1990-01-01",
      });

      await page.goto("/settings");
      await page.getByRole("button", { name: "Appearance" }).click();
      await page.getByRole("button", {
        name: variant.theme === "light" ? "Light" : "Dark",
        exact: true,
      }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", variant.theme);
      await expect.poll(async () => {
        const saved = await readAnonymousWorkspaceState(page) as {
          settings?: { theme?: string };
        };
        return saved.settings?.theme;
      }).toBe(variant.theme);
      await expect(page.getByRole("status").filter({
        hasText: "Offline support is ready for 3 current goals.",
      })).toHaveCount(1);
      await expect(page.locator(".system-alert")).toHaveCount(0);

      for (const [path, heading, routeSlug] of routes) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: heading })).toBeVisible();
        await page.evaluate(async () => {
          await document.fonts.ready;
          document.documentElement.scrollTop = 0;
        });
        // Full-page text wrapping and font rasterisation vary slightly between
        // Linux CI and macOS development, even with the same local web fonts.
        // Keep each reviewed release surface deterministic per platform.
        const snapshotName = `${variant.slug}-${routeSlug}-${process.platform}.png`;
        await expect(page).toHaveScreenshot(
          snapshotName,
          {
            animations: "disabled",
            caret: "hide",
            fullPage: true,
            maxDiffPixelRatio: 0.08,
            scale: "css",
            threshold: 0.35,
          },
        );
      }
    });
  });
}
