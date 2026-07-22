import { expect, test } from "@playwright/test";
import {
  completeOnboarding,
  formatAxeViolations,
  seriousAxeViolations,
} from "./helpers";

test("onboarding and primary workspace routes have no serious or critical axe violations", async ({ page }) => {
  await page.goto("/");
  let violations = await seriousAxeViolations(page);
  expect(violations, JSON.stringify(formatAxeViolations(violations), null, 2)).toEqual([]);

  await completeOnboarding(page, { name: "Accessibility Tester", starter: true });
  await page.goto("/goals");
  const goalDetailRoute = await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).getAttribute("href");
  expect(goalDetailRoute).toBeTruthy();

  for (const route of ["/", "/goals", "/quests", "/stats", "/reviews", "/timeline", "/settings", goalDetailRoute!]) {
    await page.goto(route);
    await expect(page.locator("#main-content")).toBeVisible();
    violations = await seriousAxeViolations(page);
    expect(
      violations,
      `${route}\n${JSON.stringify(formatAxeViolations(violations), null, 2)}`,
    ).toEqual([]);
  }

  await page.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
    name: "accessible-preview.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("This evidence preview remains readable without leaving the app."),
  });
  await page.getByRole("button", { name: "Preview accessible-preview.txt" }).click();
  await expect(page.getByRole("dialog", { name: "accessible-preview.txt" })).toBeVisible();
  violations = await seriousAxeViolations(page);
  expect(
    violations,
    `evidence preview\n${JSON.stringify(formatAxeViolations(violations), null, 2)}`,
  ).toEqual([]);
});

test("mobile navigation isolates the page, traps focus, and restores the menu trigger", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await completeOnboarding(page, { name: "Mobile Tester", starter: false });

  const menuButton = page.getByRole("button", { name: "Open menu" });
  await menuButton.click();

  const drawer = page.getByRole("dialog", { name: "Primary navigation" });
  const closeButton = drawer.getByRole("button", { name: "Close menu" });
  await expect(drawer).toBeVisible();
  await expect(closeButton).toBeFocused();
  await expect(page.locator(".app-main")).toHaveAttribute("inert", "");
  await expect(page.locator(".app-main")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

  await drawer.getByRole("link", { name: "Evolvra Personal OS" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(drawer.getByRole("link", { name: "Customise" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".app-main")).not.toHaveAttribute("aria-hidden", "true");
});
