import { expect, test } from "@playwright/test";
import { completeOnboarding, seriousAxeViolations } from "./helpers";

const routes = [
  ["/", "What will move your life forward?"],
  ["/goals", "Your goals"],
  ["/quests", "Quests board"],
  ["/stats", "Your stats"],
  ["/reviews", "Reviews"],
  ["/timeline", "Timeline"],
  ["/settings", "Customise Evolvra"],
] as const;

const viewports = [
  { label: "320px phone", width: 320, height: 640 },
  { label: "390px phone", width: 390, height: 844 },
  { label: "tablet portrait", width: 768, height: 1024 },
  { label: "phone landscape", width: 844, height: 390 },
] as const;

for (const viewport of viewports) {
  test.describe(viewport.label, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("primary routes reflow without horizontal clipping", async ({ page }) => {
      await completeOnboarding(page, {
        name: `${viewport.width} Layout`,
        starter: true,
      });

      for (const [path, heading] of routes) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: heading })).toBeVisible();
        const layout = await page.evaluate(() => ({
          viewport: document.documentElement.clientWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }));
        expect(
          Math.max(layout.document, layout.body),
          `${path} should not force horizontal page scrolling at ${viewport.width}px`,
        ).toBeLessThanOrEqual(layout.viewport + 1);
      }
    });
  });
}

test("forced colours, reduced motion, keyboard focus, and enlarged text remain usable", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await completeOnboarding(page, { name: "Accessible Media", starter: true });
  const accessiblePage = await page.context().newPage();
  await accessiblePage.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await accessiblePage.goto("/goals");
  await expect(accessiblePage.getByRole("heading", { name: "Your goals" })).toBeVisible();
  const skipLink = accessiblePage.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).not.toHaveAttribute("inert", "");
  await expect(skipLink).not.toHaveAttribute("aria-hidden", "true");
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();
  await skipLink.press("Enter");
  await expect(accessiblePage.locator("#main-content")).toBeFocused();
  expect(await seriousAxeViolations(accessiblePage)).toEqual([]);

  await accessiblePage.addStyleTag({
    content: `
      body { font-size: 26px !important; }
      input, textarea, select, button { font-size: max(16px, 1em) !important; }
    `,
  });
  await expect(accessiblePage.getByRole("heading", { name: "Your goals" })).toBeVisible();
  const layout = await accessiblePage.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(Math.max(layout.document, layout.body)).toBeLessThanOrEqual(layout.viewport + 1);
  await accessiblePage.close();
});
