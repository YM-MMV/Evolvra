import { expect, test } from "@playwright/test";
import { completeOnboarding } from "./helpers";

test("dashboard aggregates link to their source records", async ({ page }) => {
  await completeOnboarding(page, { name: "Trace Tester", starter: true });

  await expect(page.getByRole("link", { name: /Inspect \d+ completed quests/ })).toHaveAttribute("href", "/timeline?type=quest");
  await expect(page.getByRole("link", { name: /Inspect \d+ reached milestones/ })).toHaveAttribute("href", "/timeline?type=milestone");
  await expect(page.getByRole("link", { name: /^Inspect \d+ active days$/ })).toHaveAttribute("href", "/timeline?type=activity");

  const momentum = page.getByRole("link", { name: /recorded moments from the last seven days/ });
  await expect(momentum).toHaveAttribute("href", /type=activity/);
  await expect(momentum).toHaveAttribute("href", /from=\d{4}-\d{2}-\d{2}/);
  await expect(momentum).toHaveAttribute("href", /to=\d{4}-\d{2}-\d{2}/);

  const qualitySource = page.locator(".stats-mini-list .quality-trace").first();
  await expect(qualitySource).toBeVisible();
  await expect(qualitySource).toHaveAttribute("href", /\/timeline\?type=activity&stat=/);

  const calendarSource = page.getByRole("link", { name: "Inspect this year's source records" });
  await calendarSource.click();
  await expect(page).toHaveURL((url) => url.pathname === "/timeline"
    && url.searchParams.get("type") === "activity"
    && url.searchParams.get("from")?.endsWith("-01-01") === true
    && url.searchParams.get("to")?.endsWith("-12-31") === true);
});

test("mobile layouts wrap metadata instead of removing it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await completeOnboarding(page, { name: "Mobile Metadata", starter: true });

  const dashboardWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dashboardWidth.scroll).toBeLessThanOrEqual(dashboardWidth.client);
  await expect(page.locator("#dashboard-review")).toBeVisible();
  await expect(page.locator(".system-footer span").nth(1)).toBeVisible();

  await page.goto("/goals");
  const goalRow = page.locator(".goal-table-row").filter({ hasText: "Build dependable cardiovascular fitness" });
  await expect(goalRow.locator(".pill")).toBeVisible();
  await expect(goalRow.locator(".goal-date")).toBeVisible();

  await page.goto("/quests");
  const questRow = page.locator(".quest-board-row").filter({ hasText: "Complete an easy 30-minute run" });
  await expect(questRow.locator(".quest-tags")).toBeVisible();
  await expect(questRow.locator(".quest-tags")).toContainText("session");

  await page.goto("/timeline");
  await expect(page.locator(".timeline-primary-link").first()).toBeVisible();

  await page.goto("/settings#stats");
  const statRow = page.locator(".custom-list > div").filter({ hasText: "Health" });
  await expect(statRow.locator(".pill")).toBeVisible();
});

test("configured terminology follows every primary route", async ({ page }) => {
  await completeOnboarding(page, { name: "Terms Tester", starter: true });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Terminology" }).click();

  for (const [label, value] of [
    ["Default: Goals", "Missions"],
    ["Default: Quests", "Rituals"],
    ["Default: Areas", "Realms"],
    ["Default: Milestones", "Chapters"],
    ["Default: Stats", "Attributes"],
  ] as const) {
    const input = page.getByLabel(label);
    await input.fill(value);
    await input.press("Tab");
  }
  await expect(page.getByRole("link", { name: "Missions" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Rituals" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Attributes" })).toBeVisible();
  await expect(page.locator(".sync-indicator")).toContainText("Private on this device");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your current missions" })).toBeVisible();
  await expect(page.getByText("Rituals completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connected attributes" })).toBeVisible();
  await expect(page.locator('[role="status"]').filter({
    hasText: "Offline support is ready for 3 current missions.",
  })).toBeAttached();

  await page.goto("/goals");
  await expect(page.getByRole("heading", { name: "Your missions" })).toBeVisible();
  await expect(page.getByPlaceholder("Search missions…")).toBeVisible();
  await page.getByRole("link", { name: /Open mission: Build my personal command centre/ }).click();
  await page.getByRole("button", { name: "More mission actions" }).click();
  await page.getByRole("button", { name: "Edit mission" }).click();
  const editMission = page.getByRole("dialog", { name: "Edit mission" });
  await editMission.getByLabel("Progress model").selectOption("numeric");
  await expect(editMission.getByRole("alert")).toContainText(
    "A numeric or consistency mission needs at least one metric.",
  );
  await editMission.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/goals");
  await page.getByRole("link", { name: /Open mission: Build dependable cardiovascular fitness/ }).click();
  await expect(page.getByRole("heading", { name: "Chapter path" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ritual board" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connected attributes" })).toBeVisible();

  await page.goto("/quests");
  await expect(page.getByRole("heading", { name: "Rituals board" })).toBeVisible();
  await expect(page.getByPlaceholder("Search rituals…")).toBeVisible();

  await page.goto("/stats");
  await expect(page.getByRole("heading", { name: "Your attributes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recorded moments by attribute" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attribute history" })).toBeVisible();

  await page.goto("/timeline");
  await expect(page.getByRole("option", { name: "Completed rituals" })).toBeAttached();
  await expect(page.getByRole("option", { name: "Chapters" })).toBeAttached();
  await expect(page.getByRole("option", { name: "Mission changes" })).toBeAttached();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Realms & Attributes" }).click();
  await expect(page.getByRole("heading", { name: "Realms" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attributes" })).toBeVisible();
  await expect(page.getByText("Use attributes to group the missions and rituals that develop different parts of your life.")).toBeVisible();

  await page.getByRole("link", { name: "Reviews" }).click();
  await expect(page.getByLabel("1. Where did my missions move?")).toBeVisible();
  await expect(page.getByLabel("2. Which attributes did I develop?")).toBeVisible();
  await expect(page.getByText("Rituals completed", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dates and quiet missions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How missions changed this week" })).toBeVisible();
  await page.getByRole("button", { name: "monthly" }).click();
  await expect(page.getByRole("list", { name: "Mission and chapter lifecycle changes this month" })).toBeVisible();
});
