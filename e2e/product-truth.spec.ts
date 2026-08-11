import { expect, test } from "@playwright/test";
import { completeOnboarding, readAnonymousWorkspaceState } from "./helpers";

test("a reusable action saves and applies multiple finite default metric changes", async ({ page }) => {
  await completeOnboarding(page, { name: "Multi Metric Tester", starter: true });
  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();

  await page.getByRole("button", { name: "Add metric" }).click();
  const metricDialog = page.getByRole("dialog", { name: "Add a metric" });
  await metricDialog.getByRole("textbox", { name: "Metric", exact: true }).fill("Distance this month");
  await metricDialog.getByLabel("Target").fill("50");
  await metricDialog.getByLabel("Unit").fill("km");
  await metricDialog.getByLabel("Relative weight").fill("50");
  await metricDialog.getByRole("button", { name: "Save metric" }).click();

  await page.getByRole("button", { name: "Add quest" }).click();
  const actionDialog = page.getByRole("dialog", { name: "Create a quest" });
  await actionDialog.getByLabel("Quest title").fill("Run a measured route");
  await actionDialog.getByRole("checkbox", { name: /Sessions this month/ }).check();
  await actionDialog.getByRole("checkbox", { name: /Distance this month/ }).check();
  await actionDialog.getByLabel("Default change to Sessions this month").fill("1");
  const distanceDefault = actionDialog.getByLabel("Default change to Distance this month");
  await distanceDefault.fill("");
  await expect(actionDialog.getByRole("button", { name: "Add quest" })).toBeDisabled();
  await expect(actionDialog.getByRole("alert")).toContainText("finite value");
  await distanceDefault.fill("4.5");
  await actionDialog.getByRole("button", { name: "Add quest" }).click();

  await page.getByRole("button", { name: "Edit Run a measured route" }).click();
  const editAction = page.getByRole("dialog", { name: "Edit quest" });
  await expect(editAction.getByRole("checkbox", { name: /Sessions this month/ })).toBeChecked();
  await expect(editAction.getByRole("checkbox", { name: /Distance this month/ })).toBeChecked();
  await expect(editAction.getByLabel("Default change to Sessions this month")).toHaveValue("1");
  await expect(editAction.getByLabel("Default change to Distance this month")).toHaveValue("4.5");
  await editAction.getByRole("button", { name: "Save quest" }).click();

  await page.getByRole("button", { name: "Record completion for Run a measured route" }).click();
  const completionDialog = page.getByRole("dialog", { name: "Complete Run a measured route" });
  await expect(completionDialog.getByLabel("Change to Sessions this month")).toHaveValue("1");
  await expect(completionDialog.getByLabel("Change to Distance this month")).toHaveValue("4.5");
  await completionDialog.getByRole("button", { name: "Record completion" }).click();

  await expect.poll(async () => {
    const state = await readAnonymousWorkspaceState(page) as {
      goals?: Array<{
        title?: string;
        metrics?: Array<{ label?: string; current?: number }>;
        quests?: Array<{ title?: string; metricDeltas?: Array<{ metricId: string; amount: number }> }>;
      }>;
      questCompletions?: Array<{ title?: string; metricDeltas?: Array<{ amount: number }> }>;
    };
    const goal = state.goals?.find((item) => item.title === "Build dependable cardiovascular fitness");
    return {
      values: goal?.metrics?.map((metric) => [metric.label, metric.current]),
      defaults: goal?.quests?.find((quest) => quest.title === "Run a measured route")?.metricDeltas?.map((delta) => delta.amount),
      applied: state.questCompletions?.find((completion) => completion.title === "Run a measured route")?.metricDeltas?.map((delta) => delta.amount),
    };
  }).toEqual({
    values: [["Sessions this month", 4], ["Distance this month", 4.5]],
    defaults: [1, 4.5],
    applied: [1, 4.5],
  });
});

test("partial milestone weights normalize honestly and first completion remains visible after edits", async ({ page }) => {
  await completeOnboarding(page, { name: "Outcome Truth Tester", starter: true });
  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build my personal command centre" }).click();

  await page.getByRole("button", { name: "Edit Set up my life areas and stats" }).click();
  const milestoneDialog = page.getByRole("dialog", { name: "Edit milestone" });
  await milestoneDialog.getByLabel("Goal weight").fill("100");
  await milestoneDialog.getByRole("button", { name: "Save milestone" }).click();
  await expect(milestoneDialog.getByRole("alert")).toContainText("cannot exceed 100%");
  await milestoneDialog.getByLabel("Goal weight").fill("10");
  await milestoneDialog.getByRole("button", { name: "Save milestone" }).click();

  await expect(page.locator(".weight-notice")).toContainText("85%");
  await expect(page.locator(".weight-notice")).toContainText("completing all reaches 100%");
  for (const title of [
    "Define my first three meaningful goals",
    "Complete my first weekly review",
    "Use Evolvra for one full month",
  ]) {
    await page.getByRole("button", { name: `Complete ${title}` }).click();
  }
  await expect(page.locator(".goal-hero-progress")).toContainText("100%");

  await page.getByRole("button", { name: "Complete goal" }).click();
  const snapshot = page.getByRole("region", { name: "First-completion record" });
  await expect(snapshot).toContainText("Build my personal command centre");
  await expect(snapshot).toContainText("Create a reliable system for seeing what matters");

  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.getByRole("button", { name: "More goal actions" }).click();
  await page.getByRole("button", { name: "Edit goal" }).click();
  const editGoal = page.getByRole("dialog", { name: "Edit goal" });
  await editGoal.getByLabel("Goal title").fill("Operate my evolving command centre");
  await editGoal.getByLabel("Why this matters").fill("The live outcome has changed after its first completion.");
  await editGoal.getByRole("button", { name: "Save goal" }).click();

  await expect(page.getByRole("heading", { name: "Operate my evolving command centre", level: 1 })).toBeVisible();
  await expect(snapshot).toContainText("Build my personal command centre");
  await expect(snapshot).toContainText("Create a reliable system for seeing what matters");
  await expect(snapshot).not.toContainText("The live outcome has changed after its first completion.");
});

test("every major dashboard region can be hidden, restored, reordered, and reloaded", async ({ page }) => {
  await completeOnboarding(page, { name: "Dashboard Editor", starter: true });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Appearance" }).click();

  for (const label of [
    "Welcome and quick actions",
    "KPI overview",
    "Due now rail",
    "Recent momentum",
    "Year life map",
    "Current goals",
    "Connected stats",
    "Review prompt",
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: "Move KPI overview down" }).click();
  await page.getByRole("button", { name: "Move KPI overview down" }).click();
  await page.getByRole("button", { name: "Hide Welcome and quick actions" }).click();
  await expect(page.getByRole("button", { name: "Show Welcome and quick actions" })).toBeVisible();
  await page.getByRole("button", { name: "Hide KPI overview" }).click();
  await expect(page.getByRole("button", { name: "Show KPI overview" })).toBeVisible();
  await page.getByRole("button", { name: "Hide Due now rail" }).click();
  await expect(page.getByRole("button", { name: "Show Due now rail" })).toBeVisible();
  await expect.poll(async () => {
    const state = await readAnonymousWorkspaceState(page) as {
      settings?: { hiddenDashboardSections?: string[] };
    };
    return state.settings?.hiddenDashboardSections;
  }).toEqual(["hero", "overview", "due-now"]);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeAttached();
  await expect(page.getByRole("heading", { name: "What will move your life forward?" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Progress overview" })).toHaveCount(0);
  await expect(page.locator("#dashboard-due-now")).toHaveCount(0);

  await page.goto("/settings");
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("button", { name: "Show KPI overview" }).click();
  await expect(page.getByRole("button", { name: "Hide KPI overview" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Progress overview" })).toBeVisible();
  await expect(page.locator("[data-dashboard-section]").evaluateAll((sections) => (
    sections.map((section) => section.getAttribute("data-dashboard-section"))
  ))).resolves.toEqual([
    "life-map",
    "overview",
    "momentum",
    "goals",
    "qualities",
    "review",
  ]);

  await page.reload();
  await expect(page.getByRole("region", { name: "Progress overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What will move your life forward?" })).toHaveCount(0);
  await expect(page.locator("#dashboard-due-now")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("region", { name: "Progress overview" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
