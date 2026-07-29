import { expect, test } from "@playwright/test";
import { completeOnboarding, readAnonymousWorkspaceState } from "./helpers";

test("multiple measurements can be created, edited, reordered, undone, and restored after reload", async ({ page }) => {
  await completeOnboarding(page, { name: "Measurement Tester", starter: false });
  await page.goto("/goals");
  await page.getByRole("button", { name: "New goal" }).click();

  const createDialog = page.getByRole("dialog", { name: "Create a meaningful goal" });
  await createDialog.getByLabel("Goal title").fill("Prepare for a long-distance hike");
  await createDialog.getByLabel("Why this matters").fill("I want both endurance and practical preparation to reflect the real outcome.");
  await createDialog.getByRole("button", { name: /Continue/ }).click();

  await createDialog.getByLabel("What are you measuring?").fill("Training hours");
  await createDialog.getByLabel("Current").fill("4");
  await createDialog.getByLabel("Target").fill("40");
  await createDialog.getByLabel("Unit").fill("hours");
  await createDialog.getByLabel("Relative weight").fill("40");
  await createDialog.getByRole("button", { name: "Add measurement" }).click();

  await createDialog.getByLabel("What are you measuring?").nth(1).fill("Loaded walks");
  await createDialog.getByLabel("Current").nth(1).fill("1");
  await createDialog.getByLabel("Target").nth(1).fill("20");
  await createDialog.getByLabel("Unit").nth(1).fill("walks");
  await createDialog.getByLabel("Relative weight").nth(1).fill("60");
  await createDialog.getByRole("button", { name: "Move Loaded walks up" }).click();
  await createDialog.getByRole("button", { name: /Continue/ }).click();
  await createDialog.getByRole("button", { name: /Continue/ }).click();
  await createDialog.getByRole("button", { name: "Create goal" }).click();

  await page.getByRole("link", { name: "Open goal: Prepare for a long-distance hike" }).click();
  let metricRows = page.locator(".metric-list > .metric-row");
  await expect(metricRows).toHaveCount(2);
  await expect(metricRows.nth(0)).toContainText("Loaded walks");
  await expect(metricRows.nth(1)).toContainText("Training hours");

  await page.getByRole("button", { name: "Edit Loaded walks" }).click();
  const editMetric = page.getByRole("dialog", { name: "Edit metric" });
  await editMetric.getByRole("textbox", { name: "Metric", exact: true }).fill("Deliberate loaded walks");
  await editMetric.getByRole("button", { name: "Save metric" }).click();
  await page.getByRole("button", { name: "Move Deliberate loaded walks down" }).click();
  metricRows = page.locator(".metric-list > .metric-row");
  await expect(metricRows.nth(0)).toContainText("Training hours");
  await expect(metricRows.nth(1)).toContainText("Deliberate loaded walks");

  await page.getByRole("button", { name: "Undo most recent change" }).click();
  await expect(metricRows.nth(0)).toContainText("Deliberate loaded walks");

  await expect.poll(async () => {
    const state = await readAnonymousWorkspaceState(page) as {
      goals?: Array<{ title?: string; metrics?: Array<{ label?: string }> }>;
    };
    return state.goals
      ?.find((goal) => goal.title === "Prepare for a long-distance hike")
      ?.metrics?.map((metric) => metric.label);
  }, { message: "the reordered measurements should be durable before reload" }).toEqual([
    "Deliberate loaded walks",
    "Training hours",
  ]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Prepare for a long-distance hike" })).toBeVisible();
  await expect(page.locator(".metric-list > .metric-row").nth(0)).toContainText("Deliberate loaded walks");

  const persisted = await readAnonymousWorkspaceState(page) as {
    goals: Array<{ title: string; metrics: Array<{ label: string; current: number; target: number; unit: string; weight: number }> }>;
  };
  expect(persisted.goals.find((goal) => goal.title === "Prepare for a long-distance hike")?.metrics).toEqual([
    expect.objectContaining({ label: "Deliberate loaded walks", current: 1, target: 20, unit: "walks", weight: 60 }),
    expect.objectContaining({ label: "Training hours", current: 4, target: 40, unit: "hours", weight: 40 }),
  ]);
});

test("a shared action appears in both goals and retains linked completion history", async ({ page }) => {
  await completeOnboarding(page, { name: "Shared Action Tester", starter: true });
  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build my personal command centre" }).click();
  await page.getByRole("button", { name: "Add quest" }).click();

  const actionDialog = page.getByRole("dialog", { name: "Create a quest" });
  await actionDialog.getByLabel("Quest title").fill("Reflect while walking");
  await actionDialog.getByLabel("Quest type").selectOption("session");
  await actionDialog.getByLabel("Expected minutes").fill("25");
  await actionDialog.getByRole("button", { name: "Build dependable cardiovascular fitness", exact: true }).click();
  await actionDialog.getByRole("button", { name: "Add quest" }).click();

  const primaryRow = page.locator(".quest-row").filter({ hasText: "Reflect while walking" });
  await expect(primaryRow).toContainText("session");
  await primaryRow.getByRole("link", { name: "Also: Build dependable cardiovascular fitness" }).click();
  await expect(page.getByRole("heading", { name: "Quests housed in other goals" })).toBeVisible();
  const sharedRow = page.locator(".quest-row").filter({ hasText: "Reflect while walking" });
  await expect(sharedRow).toContainText("Primary home: Build my personal command centre");
  await sharedRow.getByRole("link", { name: "Open primary" }).click();

  await page.getByRole("button", { name: "Record completion for Reflect while walking" }).click();
  const completionDialog = page.getByRole("dialog", { name: "Complete Reflect while walking" });
  await completionDialog.getByLabel("Actual minutes").fill("28");
  await completionDialog.getByLabel("Completion note").fill("The walk clarified the next release decision.");
  await completionDialog.getByLabel("Evidence notes or links").fill("Shared with both goals");
  await completionDialog.getByRole("button", { name: "Record completion" }).click();

  await primaryRow.getByRole("link", { name: "Also: Build dependable cardiovascular fitness" }).click();
  await expect(page.getByText("Reflect while walking", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Primary home: Build my personal command centre", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const state = await readAnonymousWorkspaceState(page) as {
      goals?: Array<{ id?: string; title?: string }>;
      questCompletions?: Array<{ title?: string; linkedGoalIds?: string[] }>;
    };
    const linkedGoalId = state.goals
      ?.find((goal) => goal.title === "Build dependable cardiovascular fitness")?.id;
    const completion = state.questCompletions
      ?.find((item) => item.title === "Reflect while walking");
    return Boolean(linkedGoalId && completion?.linkedGoalIds?.includes(linkedGoalId));
  }, { message: "the shared completion should be durable before reload" }).toBe(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build dependable cardiovascular fitness" })).toBeVisible();
  await expect(page.getByText("Reflect while walking", { exact: true }).first()).toBeVisible();

  await page.getByRole("link", { name: "Timeline" }).click();
  const timelineRecord = page.locator(".timeline-event").filter({ hasText: "also supports Build dependable cardiovascular fitness" });
  await expect(timelineRecord).toContainText("Reflect while walking");
  await expect(timelineRecord).toContainText("also supports Build dependable cardiovascular fitness");
  await expect(timelineRecord.getByRole("link", { name: "Build dependable cardiovascular fitness" })).toBeVisible();

  await page.getByRole("link", { name: "Quests" }).click();
  await page.getByRole("button", { name: "Completed" }).click();
  const completionRecord = page.locator(".quest-board-row.completed").filter({ hasText: "Reflect while walking" });
  await expect(completionRecord).toContainText("28 actual min");
  await expect(completionRecord.getByRole("link", { name: "Open connected goal Build my personal command centre" })).toBeVisible();
  await expect(completionRecord.getByRole("link", { name: "Open connected goal Build dependable cardiovascular fitness" })).toBeVisible();
});
