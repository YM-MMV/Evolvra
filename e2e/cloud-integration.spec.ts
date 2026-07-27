import { expect, test } from "@playwright/test";
import { completeOnboarding, readAnonymousWorkspaceState } from "./helpers";
import {
  cloudAdmin,
  cloudE2eEnabled,
  cloudWorkspaceState,
  createCloudTestAccount,
  deleteCloudTestAccount,
  listCloudEvidencePaths,
  requireCloudBaseURL,
  signInCloudTestAccount,
  waitForCloudProfile,
} from "./cloud-helpers";

test.describe("local Supabase browser integration", () => {
  test.setTimeout(90_000);
  test.skip(!cloudE2eEnabled, "Set local Supabase URL, anon key, and service-role key to run cloud integration E2E.");

  const accountIds = new Set<string>();
  test.afterEach(async () => {
    for (const accountId of accountIds) await deleteCloudTestAccount(accountId);
    accountIds.clear();
  });

  test("account A and B remain isolated in the same browser", async ({ page }, testInfo) => {
    const baseURL = requireCloudBaseURL(testInfo.project.use.baseURL);
    const accountA = await createCloudTestAccount("isolation-a");
    const accountB = await createCloudTestAccount("isolation-b");
    accountIds.add(accountA.id);
    accountIds.add(accountB.id);

    await signInCloudTestAccount(page, accountA, baseURL);
    await completeOnboarding(page, { name: "Account Alpha", starter: true, accountId: accountA.id });
    await waitForCloudProfile(accountA.id, "Account Alpha");

    await page.goto("/settings");
    await page.getByRole("button", { name: "Sync & privacy" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();

    await signInCloudTestAccount(page, accountB, baseURL);
    await completeOnboarding(page, { name: "Account Beta", starter: false, accountId: accountB.id });
    await expect(page.getByText("Build dependable cardiovascular fitness")).toHaveCount(0);
    await waitForCloudProfile(accountB.id, "Account Beta");

    await page.goto("/settings");
    await page.getByRole("button", { name: "Sync & privacy" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await signInCloudTestAccount(page, accountA, baseURL);
    await expect(page.getByText(/Good (morning|afternoon|evening), Account Alpha/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" })).toBeVisible();
    await expect(page.getByText("Account Beta")).toHaveCount(0);
  });

  test("anonymous-to-account merge is explicit, remaps evidence, and preserves both originals", async ({ page }, testInfo) => {
    const baseURL = requireCloudBaseURL(testInfo.project.use.baseURL);
    const account = await createCloudTestAccount("handoff");
    accountIds.add(account.id);

    await signInCloudTestAccount(page, account, baseURL);
    await completeOnboarding(page, { name: "Cloud Original", starter: true, accountId: account.id });
    await waitForCloudProfile(account.id, "Cloud Original");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Appearance" }).click();
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await page.getByRole("button", { name: "Sync & privacy" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();

    await completeOnboarding(page, { name: "Device Original", starter: true });
    await page.goto("/goals");
    await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
    await page.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
      name: "anonymous-proof.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Anonymous evidence survives a remapped merge"),
    });
    await expect(page.getByText("anonymous-proof.txt")).toBeVisible();
    const anonymousBefore = await readAnonymousWorkspaceState(page) as {
      profile: { displayName: string };
      goals: Array<{
        id: string;
        title: string;
        evidence: Array<{ id: string; name?: string }>;
      }>;
    };
    const anonymousGoal = anonymousBefore.goals.find((goal) => (
      goal.evidence.some((item) => item.name === "anonymous-proof.txt")
    ));
    expect(anonymousGoal).toBeTruthy();
    if (!anonymousGoal) throw new Error("The anonymous evidence goal was not persisted.");

    await signInCloudTestAccount(page, account, baseURL);
    const handoff = page.getByRole("dialog", { name: "Choose which private workspace to open" });
    await expect(handoff).toBeVisible();
    await expect(handoff).toContainText("Nothing is copied automatically");
    await waitForCloudProfile(account.id, "Cloud Original");
    expect((await readAnonymousWorkspaceState(page) as { profile: { displayName: string } }).profile.displayName)
      .toBe("Device Original");
    await handoff.getByRole("button", { name: "Cancel and sign out" }).click();
    await expect(page.getByText(/Good (morning|afternoon|evening), Device Original/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" })).toBeVisible();

    await signInCloudTestAccount(page, account, baseURL);
    const secondHandoff = page.getByRole("dialog", { name: "Choose which private workspace to open" });
    await expect(secondHandoff.getByRole("button", { name: "Merge device data into account" })).toBeVisible();
    await secondHandoff.getByRole("button", { name: "Merge device data into account" }).click();
    await expect(page.getByText(/Good (morning|afternoon|evening), Cloud Original/)).toBeVisible();
    await page.goto("/goals");
    await expect(page.getByRole("dialog", { name: "Choose which private workspace to open" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" })).toHaveCount(2);

    const mergedAccount = await page.evaluate(async (accountId) => {
      return await new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open("evolvra-persistence");
        request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("workspaces", "readonly");
          const read = transaction.objectStore("workspaces").get(accountId);
          read.onerror = () => reject(read.error ?? new Error("The merged account workspace could not be read."));
          read.onsuccess = () => {
            database.close();
            resolve(read.result?.state);
          };
        };
      });
    }, account.id) as {
      profile: { displayName: string };
      settings: { theme: string };
      goals: Array<{
        id: string;
        title: string;
        evidence: Array<{ id: string; name?: string; remotePath?: string }>;
      }>;
    };
    const mergedEvidenceGoal = mergedAccount.goals.find((goal) => (
      goal.evidence.some((item) => item.name === "anonymous-proof.txt")
    ));
    expect(mergedAccount.profile.displayName).toBe("Cloud Original");
    expect(mergedAccount.settings.theme).toBe("light");
    expect(mergedEvidenceGoal).toBeTruthy();
    if (!mergedEvidenceGoal) throw new Error("The merged evidence goal was not persisted.");
    expect(mergedEvidenceGoal.id).not.toBe(anonymousGoal.id);
    expect(mergedEvidenceGoal.evidence.find((item) => item.name === "anonymous-proof.txt")?.id)
      .not.toBe(anonymousGoal.evidence.find((item) => item.name === "anonymous-proof.txt")?.id);
    expect(mergedEvidenceGoal.evidence.find((item) => item.name === "anonymous-proof.txt"))
      .not.toHaveProperty("remotePath");

    await page.goto(`/goals/${mergedEvidenceGoal.id}`);
    await page.getByRole("button", { name: "Preview anonymous-proof.txt" }).click();
    await expect(page.getByRole("dialog", { name: "anonymous-proof.txt" }))
      .toContainText("Anonymous evidence survives a remapped merge");
    await expect.poll(async () => {
      const cloud = await cloudWorkspaceState(account.id);
      return (cloud.state.goals as unknown[]).length;
    }, { timeout: 25_000 }).toBe(2);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Sync & privacy" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText(/Good (morning|afternoon|evening), Device Original/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" })).toBeVisible();
    const anonymousAfter = await readAnonymousWorkspaceState(page) as typeof anonymousBefore;
    expect(anonymousAfter.profile.displayName).toBe("Device Original");
    expect(anonymousAfter.goals).toEqual(anonymousBefore.goals);
  });

  test("server revision conflicts are explicit and offline account edits retry after reconnect", async ({ browser, page }, testInfo) => {
    const baseURL = requireCloudBaseURL(testInfo.project.use.baseURL);
    const account = await createCloudTestAccount("revision");
    accountIds.add(account.id);
    await signInCloudTestAccount(page, account, baseURL);
    await completeOnboarding(page, { name: "Revision Base", starter: false, accountId: account.id });
    await waitForCloudProfile(account.id, "Revision Base");

    const secondContext = await browser.newContext({ serviceWorkers: "allow" });
    const secondPage = await secondContext.newPage();
    try {
      await signInCloudTestAccount(secondPage, account, baseURL);
      await expect(secondPage.getByText(/Good (morning|afternoon|evening), Revision Base/)).toBeVisible();

      await Promise.all([page.goto("/settings"), secondPage.goto("/settings")]);
      const firstName = page.getByLabel("Display name");
      const secondName = secondPage.getByLabel("Display name");
      await Promise.all([
        firstName.fill("Revision Device One").then(() => firstName.press("Tab")),
        secondName.fill("Revision Device Two").then(() => secondName.press("Tab")),
      ]);

      await page.waitForTimeout(1_500);
      await Promise.all([page, secondPage].map(async (candidate) => {
        if (await candidate.getByText("Choose the source of truth").isVisible().catch(() => false)) return;
        const syncPanel = candidate.getByRole("button", { name: "Sync & privacy" });
        if (await syncPanel.isVisible().catch(() => false)) await syncPanel.click();
      }));

      await expect.poll(async () => {
        const first = await page.getByText("Choose the source of truth").isVisible().catch(() => false);
        const second = await secondPage.getByText("Choose the source of truth").isVisible().catch(() => false);
        return first || second;
      }, { timeout: 25_000 }).toBe(true);

      const conflictPage = await page.getByText("Choose the source of truth").isVisible().catch(() => false) ? page : secondPage;
      await conflictPage.getByRole("button", { name: "Use cloud copy" }).click();
      await expect(conflictPage.getByText("Choose the source of truth")).toBeHidden();

      const profilePanel = conflictPage.getByRole("button", { name: "Profile" });
      if (await profilePanel.isVisible().catch(() => false)) await profilePanel.click();

      await conflictPage.context().setOffline(true);
      const chapter = conflictPage.getByLabel("Current chapter");
      await chapter.fill("Edited safely while offline");
      await chapter.press("Tab");
      await expect(conflictPage.getByText("Offline — changes stay on this device", { exact: true })).toBeVisible();
      await conflictPage.reload({ waitUntil: "domcontentloaded" });
      await expect(conflictPage.getByLabel("Current chapter")).toHaveValue("Edited safely while offline");
      await conflictPage.context().setOffline(false);
      await conflictPage.reload();
      await expect(conflictPage.getByLabel("Current chapter")).toHaveValue("Edited safely while offline");
      await expect.poll(async () => {
        const { data } = await cloudAdmin().from("workspace_snapshots").select("state").eq("user_id", account.id).single();
        return data?.state?.profile?.chapter;
      }, { timeout: 25_000 }).toBe("Edited safely while offline");
      await expect(conflictPage.getByText("Private sync up to date", { exact: true })).toBeVisible();
    } finally {
      await secondContext.close();
    }
  });

  test("private evidence survives a second device, supports lifecycle operations, and is erased with the account", async ({ browser, page }, testInfo) => {
    const baseURL = requireCloudBaseURL(testInfo.project.use.baseURL);
    const account = await createCloudTestAccount("evidence");
    accountIds.add(account.id);
    await signInCloudTestAccount(page, account, baseURL);
    await completeOnboarding(page, { name: "Evidence Owner", starter: true, accountId: account.id });
    await waitForCloudProfile(account.id, "Evidence Owner");

    await page.goto("/goals");
    await page.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
    await page.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
      name: "proof.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Private evidence round-trip"),
    });
    await expect(page.getByText("proof.txt")).toBeVisible();
    await expect.poll(() => listCloudEvidencePaths(account.id), { timeout: 20_000 }).toHaveLength(1);

    const secondContext = await browser.newContext({ serviceWorkers: "allow" });
    const secondPage = await secondContext.newPage();
    try {
      await signInCloudTestAccount(secondPage, account, baseURL);
      await secondPage.goto("/goals");
      await secondPage.getByRole("link", { name: "Open goal: Build dependable cardiovascular fitness" }).click();
      await expect(secondPage.getByText("proof.txt")).toBeVisible({ timeout: 20_000 });
      await secondPage.getByRole("button", { name: "Preview proof.txt" }).click();
      const preview = secondPage.getByRole("dialog", { name: "proof.txt" });
      await expect(preview.getByText("Private evidence round-trip")).toBeVisible();
      await preview.getByRole("button", { name: "Close" }).click();

      secondPage.once("dialog", (dialog) => void dialog.accept("renamed-proof.txt"));
      await secondPage.getByRole("button", { name: "Rename proof.txt" }).click();
      await expect(secondPage.getByText("renamed-proof.txt")).toBeVisible();
      await expect.poll(() => listCloudEvidencePaths(account.id)).toEqual([
        expect.stringMatching(/\/renamed-proof\.txt$/),
      ]);

      await secondPage.getByRole("button", { name: "Remove renamed-proof.txt" }).click();
      await expect(secondPage.getByText("renamed-proof.txt")).toBeHidden();
      await expect.poll(() => listCloudEvidencePaths(account.id)).toEqual([]);

      await secondPage.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
        name: "erase-me.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Erase these bytes through the Storage API"),
      });
      await expect.poll(() => listCloudEvidencePaths(account.id)).toHaveLength(1);
      await secondPage.goto("/settings");
      await secondPage.getByRole("button", { name: "Data & recovery" }).click();
      await secondPage.getByRole("button", { name: "Erase everything" }).click();
      const confirmation = secondPage.getByRole("dialog", { name: "Erase your Evolvra workspace?" });
      await confirmation.getByRole("button", { name: "Erase everything" }).click();
      await expect(secondPage.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();

      await expect.poll(async () => {
        const { data, error } = await cloudAdmin().auth.admin.getUserById(account.id);
        return Boolean(error || !data.user);
      }, { timeout: 20_000 }).toBe(true);
      await expect.poll(() => listCloudEvidencePaths(account.id)).toEqual([]);
      accountIds.delete(account.id);
    } finally {
      await secondContext.close();
    }
  });
});
