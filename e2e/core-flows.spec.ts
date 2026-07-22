import { expect, test } from "@playwright/test";
import { completeOnboarding, readAnonymousWorkspaceState } from "./helpers";

test("clean onboarding persists and an open-ended goal keeps reflective progress", async ({ page }) => {
  await completeOnboarding(page, { name: "Avery", starter: false, birthDate: "" });

  await page.reload();
  await expect(page.getByRole("heading", { name: "What will move your life forward?" })).toBeVisible();
  await expect(page.getByText(/Good (morning|afternoon|evening), Avery/)).toBeVisible();
  await page.getByRole("link", { name: "Goals" }).click();
  await page.getByRole("button", { name: "New goal" }).click();

  const goalDialog = page.getByRole("dialog", { name: "Create a meaningful goal" });
  await expect(goalDialog).toBeVisible();
  await expect(goalDialog.getByLabel("Goal title")).toBeFocused();
  await goalDialog.getByLabel("Goal title").fill("Explore a sustainable career direction");
  await goalDialog.getByLabel("Why this matters").fill("I want evidence and reflection to guide a decision before committing to a numeric target.");
  await goalDialog.getByRole("button", { name: /Continue/ }).click();

  await goalDialog.getByRole("button", { name: /Open-ended/ }).click();
  await expect(goalDialog.getByText(/use dated reflections and evidence/i)).toBeVisible();
  await expect(goalDialog.getByLabel("What are you measuring?")).toHaveCount(0);
  await goalDialog.getByRole("button", { name: /Continue/ }).click();
  await goalDialog.getByRole("button", { name: /Continue/ }).click();
  await goalDialog.getByLabel("First quest").fill("Write the first reflection");
  await goalDialog.getByRole("button", { name: "Create goal" }).click();

  await expect(page.getByRole("link", { name: /Open goal: Explore a sustainable career direction/ })).toBeVisible();
  await page.getByRole("link", { name: /Open goal: Explore a sustainable career direction/ }).click();
  await expect(page.getByRole("heading", { name: "Explore a sustainable career direction" })).toBeVisible();
  await expect(page.getByText("Progress is reflective")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add metric" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record check-in" })).toBeDisabled();
});

test("a repeating action records one occurrence and cannot be completed twice in its period", async ({ page }) => {
  await completeOnboarding(page, { name: "Morgan", starter: true });
  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();

  const completionTrigger = page.getByRole("button", { name: "Record completion for Complete an easy 30-minute run" });
  await expect(completionTrigger).toBeEnabled();
  await completionTrigger.click();

  const completionDialog = page.getByRole("dialog", { name: "Complete Complete an easy 30-minute run" });
  await expect(completionDialog).toBeVisible();
  await expect(completionDialog.getByLabel("Actual minutes")).toBeFocused();

  await completionDialog.getByRole("button", { name: "Record completion" }).focus();
  await page.keyboard.press("Tab");
  await expect(completionDialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(completionDialog).toBeHidden();
  await expect(completionTrigger).toBeFocused();

  await completionTrigger.click();
  await completionDialog.getByLabel("Actual minutes").fill("32");
  await completionDialog.getByLabel("Completion note").fill("Comfortable effort throughout.");
  await completionDialog.getByRole("button", { name: "Record completion" }).click();

  const unavailableTrigger = page.getByRole("button", { name: "Complete an easy 30-minute run is not available yet" });
  await expect(unavailableTrigger).toBeDisabled();
  await page.getByRole("link", { name: "Quests" }).click();
  await page.getByRole("button", { name: "Completed" }).click();
  await expect(page.getByText("Comfortable effort throughout.")).toBeVisible();
  await expect(page.getByText("32 actual min")).toBeVisible();
  await expect(page.getByRole("region", { name: "Recorded actions" }).locator(".quest-board-list"))
    .toContainText("Complete an easy 30-minute run");
  await expect(page.locator(".quest-board-row.completed")).toHaveCount(1);
});

test("a strict JSON restore is undoable and preserves visible recovery feedback", async ({ page }) => {
  await completeOnboarding(page, { name: "Original Name", starter: false });
  const backup = await readAnonymousWorkspaceState(page);

  await page.goto("/settings");
  const displayName = page.getByLabel("Display name");
  await displayName.fill("Edited Name");
  await displayName.press("Tab");
  await expect(displayName).toHaveValue("Edited Name");

  await page.getByRole("button", { name: "Data & recovery" }).click();
  await page.locator('input[type="file"][accept*="json"]').setInputFiles({
    name: "evolvra-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  await expect(page.locator(".toast-message")).toContainText("Workspace restored successfully.");
  await page.getByRole("button", { name: "Profile" }).click();
  await expect(page.getByLabel("Display name")).toHaveValue("Original Name");
  await page.getByRole("button", { name: "Undo most recent change" }).click();
  await expect(page.getByLabel("Display name")).toHaveValue("Edited Name");
});

test("erase everything removes only the active workspace, history, evidence, and reminder metadata", async ({ page }) => {
  await completeOnboarding(page, { name: "Erase Tester", starter: true });
  await page.evaluate(async () => {
    localStorage.setItem("evolvra:reminder:last-delivered", "2026-01-01");
    localStorage.setItem("evolvra:reminder:last-delivered:anonymous", "2026-01-02");
    localStorage.setItem("evolvra:reminder:last-delivered:account-b", "2026-01-03");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("evolvra-persistence");
      request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(["workspaces", "evidence"], "readwrite");
        transaction.onerror = () => reject(transaction.error ?? new Error("Account fixture could not be saved."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Account fixture was aborted."));
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        const workspaceStore = transaction.objectStore("workspaces");
        const read = workspaceStore.get("anonymous");
        read.onerror = () => reject(read.error ?? new Error("Anonymous fixture could not be read."));
        read.onsuccess = () => {
          const preserved = structuredClone(read.result);
          preserved.accountId = "account-b";
          preserved.localRevision = 7;
          preserved.state.profile.displayName = "Preserved account current";
          const prior = structuredClone(preserved.state);
          prior.profile.displayName = "Preserved account history";
          preserved.history = [prior];
          workspaceStore.put(preserved);
          transaction.objectStore("evidence").put({
            accountId: "account-b",
            goalId: "preserved-goal",
            evidenceId: "preserved-evidence",
            blob: new Blob(["other account proof"], { type: "text/plain" }),
            savedAt: new Date().toISOString(),
          });
        };
      };
    });
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Data & recovery" }).click();
  await page.getByRole("button", { name: "Erase everything" }).click();

  const confirmation = page.getByRole("dialog", { name: "Erase your Evolvra workspace?" });
  await expect(confirmation.getByRole("button", { name: "Close" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Erase everything" }).click();
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();
  const erased = await page.evaluate(async () => {
    return await new Promise<{
      anonymousExists: boolean;
      preservedName?: string;
      preservedHistory: string[];
      anonymousEvidence: number;
      preservedEvidence: number;
      legacyReminder: string | null;
      anonymousReminder: string | null;
      preservedReminder: string | null;
    }>((resolve, reject) => {
      const request = indexedDB.open("evolvra-persistence");
      request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(["workspaces", "evidence"], "readonly");
        const workspaces = transaction.objectStore("workspaces");
        const anonymous = workspaces.get("anonymous");
        const preserved = workspaces.get("account-b");
        const evidence = transaction.objectStore("evidence").index("by-account");
        const anonymousEvidence = evidence.count("anonymous");
        const preservedEvidence = evidence.count("account-b");
        transaction.oncomplete = () => {
          database.close();
          resolve({
            anonymousExists: Boolean(anonymous.result),
            preservedName: preserved.result?.state?.profile?.displayName as string | undefined,
            preservedHistory: Array.isArray(preserved.result?.history)
              ? preserved.result.history.map((item: { profile?: { displayName?: string } }) => item.profile?.displayName ?? "")
              : [],
            anonymousEvidence: anonymousEvidence.result,
            preservedEvidence: preservedEvidence.result,
            legacyReminder: localStorage.getItem("evolvra:reminder:last-delivered"),
            anonymousReminder: localStorage.getItem("evolvra:reminder:last-delivered:anonymous"),
            preservedReminder: localStorage.getItem("evolvra:reminder:last-delivered:account-b"),
          });
        };
        transaction.onerror = () => reject(transaction.error ?? new Error("Erased stores could not be verified."));
      };
    });
  });
  expect(erased).toEqual({
    anonymousExists: false,
    preservedName: "Preserved account current",
    preservedHistory: ["Preserved account history"],
    anonymousEvidence: 0,
    preservedEvidence: 1,
    legacyReminder: null,
    anonymousReminder: null,
    preservedReminder: "2026-01-03",
  });
});

test("keyboard-only goal editing, completion, review, export, and deletion remain operable", async ({ page }) => {
  await completeOnboarding(page, { name: "Keyboard Tester", starter: true });
  await page.goto("/goals");

  const goalLink = page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" });
  await goalLink.focus();
  await page.keyboard.press("Enter");

  const moreActions = page.getByRole("button", { name: "More goal actions" });
  await moreActions.focus();
  await page.keyboard.press("Enter");
  const editGoal = page.getByRole("button", { name: "Edit goal" });
  await editGoal.focus();
  await page.keyboard.press("Enter");

  const editDialog = page.getByRole("dialog", { name: "Edit goal" });
  const title = editDialog.getByLabel("Goal title");
  await expect(title).toBeFocused();
  await title.press("ControlOrMeta+A");
  await page.keyboard.type("Build calm cardiovascular fitness");
  const saveGoal = editDialog.getByRole("button", { name: "Save goal" });
  await saveGoal.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Build calm cardiovascular fitness" })).toBeVisible();

  const completionTrigger = page.getByRole("button", { name: "Record completion for Complete an easy 30-minute run" });
  await completionTrigger.focus();
  await page.keyboard.press("Enter");
  const completionDialog = page.getByRole("dialog", { name: "Complete Complete an easy 30-minute run" });
  await completionDialog.getByLabel("Actual minutes").press("ControlOrMeta+A");
  await page.keyboard.type("31");
  await completionDialog.getByLabel("Completion note").focus();
  await page.keyboard.type("Recorded without a pointer.");
  const recordCompletion = completionDialog.getByRole("button", { name: "Record completion" });
  await recordCompletion.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Complete an easy 30-minute run is not available yet" })).toBeDisabled();

  const reviewsLink = page.getByRole("link", { name: "Reviews" });
  await reviewsLink.focus();
  await page.keyboard.press("Enter");
  const reviewAnswer = page.getByLabel("1. Where did my goals move?");
  await reviewAnswer.focus();
  await page.keyboard.type("The session happened with a sustainable effort.");
  const saveReflection = page.getByRole("button", { name: "Save reflection" });
  await saveReflection.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  const settingsLink = page.getByRole("link", { name: "Customise settings" });
  await settingsLink.focus();
  await page.keyboard.press("Enter");
  const dataSection = page.getByRole("button", { name: "Data & recovery" });
  await dataSection.focus();
  await page.keyboard.press("Enter");
  const backupDownload = page.waitForEvent("download");
  const backupButton = page.getByRole("button", { name: /Workspace JSON backup/ });
  await backupButton.focus();
  await page.keyboard.press("Enter");
  await expect((await backupDownload).suggestedFilename()).toMatch(/^evolvra-backup-\d{4}-\d{2}-\d{2}\.json$/);

  const goalsLink = page.getByRole("link", { name: "Goals" });
  await goalsLink.focus();
  await page.keyboard.press("Enter");
  const renamedGoalLink = page.getByRole("link", { name: "Open goal: Build calm cardiovascular fitness" });
  await renamedGoalLink.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "More goal actions" }).focus();
  await page.keyboard.press("Enter");
  const deleteGoal = page.getByRole("button", { name: "Permanently delete" });
  await deleteGoal.focus();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole("link", { name: "Open goal: Build calm cardiovascular fitness" })).toHaveCount(0);
});

test("review context links measured movement to its timeline source and prepares a monthly comparison", async ({ page }) => {
  await completeOnboarding(page, { name: "Review Source Tester", starter: true });
  await page.goto("/goals");
  const goalLink = page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" });
  await goalLink.focus();
  await page.keyboard.press("Enter");

  const metricValue = page.getByLabel("Current value for this month");
  await metricValue.fill("2");
  await metricValue.press("Tab");
  await expect(metricValue).toHaveValue("2");

  const reviewsLink = page.getByRole("link", { name: "Reviews" });
  await reviewsLink.focus();
  await page.keyboard.press("Enter");
  const movementList = page.getByRole("list", { name: "Measured goal movement this week" });
  await expect(movementList).toContainText("3 runs → 2 runs");
  const sourceLink = movementList.getByRole("link", { name: "Sessions this month · Build dependable cardiovascular fitness" });
  await sourceLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL((url) => (
    url.pathname === "/timeline"
      && url.searchParams.get("type") === "metric"
      && url.searchParams.get("goal") !== null
      && url.searchParams.get("from") !== null
      && url.searchParams.get("to") !== null
      && url.hash.startsWith("#event-record-metric-")
  ));
  const sourceEvent = page.locator(".timeline-event").filter({ hasText: "Sessions this month updated" }).first();
  await expect(sourceEvent).toBeVisible();
  await expect(sourceEvent).toContainText("Sessions this month updated");
  await expect(sourceEvent).toBeFocused();

  await page.getByRole("link", { name: "Reviews" }).focus();
  await page.keyboard.press("Enter");
  const monthlyCadence = page.getByRole("button", { name: "monthly" });
  await monthlyCadence.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Month-to-date context" })).toBeVisible();
  await expect(page.getByRole("img", { name: /compared with/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What started or changed state" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Goal and milestone lifecycle changes this month" })).toContainText("Build dependable cardiovascular fitness");
});

test("mobile layouts retain goal, quest, review, settings, import, export, and delete parity", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await completeOnboarding(page, { name: "Mobile Parity", starter: true });
  const backup = await readAnonymousWorkspaceState(page);

  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
  const questRow = page.locator(".quest-row").filter({ hasText: "Complete an easy 30-minute run" });
  await expect(questRow.locator(".quest-row-meta")).toBeVisible();
  await expect(questRow.locator(".quest-row-meta")).toContainText("session");
  await expect(questRow.getByRole("button", { name: "Move Complete an easy 30-minute run up" })).toBeVisible();
  await expect(questRow.getByRole("button", { name: "Move Complete an easy 30-minute run down" })).toBeVisible();

  await page.getByRole("button", { name: "More goal actions" }).click();
  await page.getByRole("button", { name: "Edit goal" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit goal" });
  await editDialog.getByLabel("Why this matters").fill("A sustainable running practice that fits real mobile life.");
  const editBounds = await editDialog.boundingBox();
  expect(editBounds).not.toBeNull();
  expect(editBounds!.y).toBeGreaterThanOrEqual(0);
  expect(editBounds!.y + editBounds!.height).toBeLessThanOrEqual(845);
  await editDialog.getByRole("button", { name: "Save goal" }).click();
  await expect(page.getByText("A sustainable running practice that fits real mobile life.")).toBeVisible();

  await page.getByRole("button", { name: "Record completion for Complete an easy 30-minute run" }).click();
  const completionDialog = page.getByRole("dialog", { name: "Complete Complete an easy 30-minute run" });
  await completionDialog.getByLabel("Completion note").fill("Completed from the mobile layout.");
  await completionDialog.getByRole("button", { name: "Record completion" }).click();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" }).getByRole("link", { name: "Reviews" }).click();
  await page.getByLabel("1. Where did my goals move?").fill("The mobile session was recorded clearly.");
  await page.getByRole("button", { name: "Save reflection" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" }).getByRole("link", { name: "Customise settings" }).click();
  await page.getByRole("button", { name: "Data & recovery" }).click();
  const mobileDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Workspace JSON backup/ }).click();
  await expect((await mobileDownload).suggestedFilename()).toMatch(/^evolvra-backup-/);
  await page.locator('input[type="file"][accept*="json"]').setInputFiles({
    name: "mobile-evolvra-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator(".toast-message")).toContainText("Workspace restored successfully.");

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog", { name: "Primary navigation" }).getByRole("link", { name: "Goals" }).click();
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
  await page.getByRole("button", { name: "More goal actions" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Permanently delete" }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" })).toHaveCount(0);
});

test("local evidence has explicit previews, downloads, and revoked object URLs", async ({ page }) => {
  await completeOnboarding(page, { name: "Evidence Tester", starter: true });
  await page.goto("/goals");
  await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
  const fileInput = page.locator('input[type="file"][accept*="text/plain"]');

  await fileInput.setInputFiles({
    name: "session-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A calm 31-minute session with steady breathing."),
  });
  const textPreview = page.getByRole("button", { name: "Preview session-notes.txt" });
  const textDownload = page.getByRole("button", { name: "Download session-notes.txt" });
  await expect(textPreview).toBeVisible();
  await expect(textDownload).toBeVisible();
  await textPreview.focus();
  await page.keyboard.press("Enter");
  const textDialog = page.getByRole("dialog", { name: "session-notes.txt" });
  await expect(textDialog.getByText("A calm 31-minute session with steady breathing.")).toBeVisible();
  const download = page.waitForEvent("download");
  await textDialog.getByRole("button", { name: "Download file" }).click();
  expect((await download).suggestedFilename()).toBe("session-notes.txt");
  await page.keyboard.press("Escape");
  await expect(textPreview).toBeFocused();

  await fileInput.setInputFiles({
    name: "finish.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  });
  await page.evaluate(() => {
    const scopedWindow = window as typeof window & { __evidenceRevocations?: string[] };
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    scopedWindow.__evidenceRevocations = [];
    URL.revokeObjectURL = (url: string) => {
      scopedWindow.__evidenceRevocations?.push(url);
      originalRevoke(url);
    };
  });
  const imagePreview = page.getByRole("button", { name: "Preview finish.png" });
  await imagePreview.click();
  const imageDialog = page.getByRole("dialog", { name: "finish.png" });
  await expect(imageDialog.getByRole("img", { name: "Preview of finish.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __evidenceRevocations?: string[] }).__evidenceRevocations?.length ?? 0)).toBeGreaterThan(0);

  await fileInput.setInputFiles({
    name: "training-record.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF"),
  });
  await page.getByRole("button", { name: "Preview training-record.pdf" }).click();
  const pdfDialog = page.getByRole("dialog", { name: "training-record.pdf" });
  await expect(pdfDialog.locator('iframe[title="Preview of training-record.pdf"]')).toBeVisible();
  await pdfDialog.getByRole("button", { name: "Close" }).click();
});
