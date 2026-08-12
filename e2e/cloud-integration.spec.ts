import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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

async function readLocalAccountErasureFence(page: Page, accountId: string) {
  return page.evaluate(async (targetAccountId) => {
    return await new Promise<{
      checkpoint: unknown;
      scope: unknown;
    }>((resolve, reject) => {
      const open = indexedDB.open("evolvra-persistence");
      open.onerror = () => reject(open.error ?? new Error("IndexedDB could not be opened."));
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction(
          ["account-scopes", "account-erasure-checkpoints"],
          "readonly",
        );
        const scopeRequest = transaction.objectStore("account-scopes").get(targetAccountId);
        const checkpointRequest = transaction
          .objectStore("account-erasure-checkpoints")
          .get(targetAccountId);
        transaction.onerror = () => reject(
          transaction.error ?? new Error("Local account-erasure state could not be read."),
        );
        transaction.onabort = () => reject(
          transaction.error ?? new Error("Local account-erasure state read was aborted."),
        );
        transaction.oncomplete = () => {
          database.close();
          resolve({
            checkpoint: checkpointRequest.result ?? null,
            scope: scopeRequest.result ?? null,
          });
        };
      };
    });
  }, accountId);
}

async function accountCloudClient(page: Page, accountId: string) {
  const session = await page.evaluate((targetAccountId) => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
      const rawValue = localStorage.getItem(key);
      if (!rawValue) continue;
      try {
        const candidate = JSON.parse(rawValue) as {
          access_token?: unknown;
          refresh_token?: unknown;
          user?: { id?: unknown };
        };
        if (
          candidate.user?.id === targetAccountId
          && typeof candidate.access_token === "string"
          && typeof candidate.refresh_token === "string"
        ) {
          return {
            accessToken: candidate.access_token,
            refreshToken: candidate.refresh_token,
          };
        }
      } catch {
        // Ignore unrelated localStorage values and keep looking for the session.
      }
    }
    return null;
  }, accountId);
  if (!session) throw new Error("The exact browser account session was not available.");

  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!apiUrl || !anonKey) throw new Error("Cloud E2E credentials are unavailable.");
  const client = createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await client.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });
  if (error) throw error;
  return client;
}

async function accountErasureBoundary(client: SupabaseClient, accountId: string) {
  const { data, error } = await client.rpc("read_account_erasure_backup_boundary", {
    p_expected_account_id: accountId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (
    !row
    || typeof row.workspace_revision !== "number"
    || typeof row.evidence_revision !== "number"
  ) {
    throw new Error("The cloud returned an invalid account-erasure boundary.");
  }
  return {
    workspaceRevision: row.workspace_revision,
    evidenceRevision: row.evidence_revision,
  };
}

async function claimEvidenceCleanup(
  client: SupabaseClient,
  accountId: string,
  remotePaths: string[],
) {
  const { data, error } = await client.rpc("claim_evidence_cleanup", {
    p_expected_account_id: accountId,
    p_remote_paths: remotePaths,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (
    !row
    || typeof row.claimed !== "boolean"
    || typeof row.workspace_revision !== "number"
  ) {
    throw new Error("The cloud returned an invalid evidence-cleanup claim.");
  }
  return {
    claimed: row.claimed,
    workspaceRevision: row.workspace_revision,
  };
}

test.describe("Supabase browser integration", () => {
  test.setTimeout(90_000);
  test.skip(!cloudE2eEnabled, "Set a guarded Supabase URL, anon key, and service-role key to run cloud integration E2E.");

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
    await expect(page.getByText("Private sync up to date", { exact: true })).toBeVisible();
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
    }, { timeout: 25_000 }).toBe(mergedAccount.goals.length);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Sync & privacy" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("Private on this device", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Display name")).toHaveValue("Device Original");
    await page.goto("/");
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
      await expect(conflictPage.getByText("Offline — saved on this device", { exact: true })).toBeVisible();
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

  test("a same-path Storage overwrite advances only the evidence backup boundary", async ({ page }, testInfo) => {
    const baseURL = requireCloudBaseURL(testInfo.project.use.baseURL);
    const account = await createCloudTestAccount("evidence-overwrite-boundary");
    accountIds.add(account.id);
    await signInCloudTestAccount(page, account, baseURL);

    const client = await accountCloudClient(page, account.id);
    const bucket = client.storage.from("evidence");
    const path = `${account.id}/overwrite-goal/overwrite-${globalThis.crypto.randomUUID()}/proof.txt`;
    const original = Buffer.alloc(64, "A");
    const replacement = Buffer.alloc(64, "B");
    try {
      const before = await accountErasureBoundary(client, account.id);
      const { error: uploadError } = await bucket.upload(path, original, {
        contentType: "text/plain",
        upsert: false,
      });
      if (uploadError) throw uploadError;

      const afterUpload = await accountErasureBoundary(client, account.id);
      expect(afterUpload.workspaceRevision).toBe(before.workspaceRevision);
      expect(afterUpload.evidenceRevision).toBeGreaterThan(before.evidenceRevision);

      const { error: overwriteError } = await bucket.upload(path, replacement, {
        contentType: "text/plain",
        upsert: true,
      });
      if (overwriteError) throw overwriteError;

      const afterOverwrite = await accountErasureBoundary(client, account.id);
      expect(afterOverwrite.workspaceRevision).toBe(before.workspaceRevision);
      expect(afterOverwrite.evidenceRevision).toBeGreaterThan(afterUpload.evidenceRevision);

      const { data: downloaded, error: downloadError } = await bucket.download(path);
      if (downloadError || !downloaded) throw downloadError ?? new Error("Overwritten evidence could not be downloaded.");
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(replacement);
    } finally {
      const { error } = await bucket.remove([path]);
      if (error) {
        const { error: adminError } = await cloudAdmin().storage.from("evidence").remove([path]);
        if (adminError) throw adminError;
      }
    }
  });

  test("cleanup claims prevent evidence resurrection and authorize only the claimed delete", async ({ page }, testInfo) => {
    const baseURL = requireCloudBaseURL(testInfo.project.use.baseURL);
    const account = await createCloudTestAccount("evidence-cleanup-claim");
    accountIds.add(account.id);
    await signInCloudTestAccount(page, account, baseURL);

    const client = await accountCloudClient(page, account.id);
    const bucket = client.storage.from("evidence");
    const goalId = globalThis.crypto.randomUUID();
    const evidenceId = globalThis.crypto.randomUUID();
    const path = `${account.id}/${goalId}/${evidenceId}/proof.txt`;
    const referencedState = {
      version: 3,
      goals: [{
        evidence: [{ id: evidenceId, type: "file", remotePath: path }],
      }],
    };
    const unreferencedState = { version: 3, goals: [] };

    try {
      const before = await accountErasureBoundary(client, account.id);
      const { error: uploadError } = await bucket.upload(
        path,
        Buffer.from("Claim these private evidence bytes"),
        { contentType: "text/plain", upsert: false },
      );
      if (uploadError) throw uploadError;

      const { data: referencedSave, error: referencedSaveError } = await client.rpc(
        "save_workspace_snapshot",
        {
          p_expected_account_id: account.id,
          p_state: referencedState,
          p_expected_revision: before.workspaceRevision,
        },
      );
      if (referencedSaveError) throw referencedSaveError;
      const referencedRow = Array.isArray(referencedSave) ? referencedSave[0] : referencedSave;
      expect(referencedRow?.revision).toBe(before.workspaceRevision + 1);

      const referencedClaim = await claimEvidenceCleanup(client, account.id, [path]);
      expect(referencedClaim).toEqual({
        claimed: false,
        workspaceRevision: before.workspaceRevision + 1,
      });

      const { data: unreferencedSave, error: unreferencedSaveError } = await client.rpc(
        "save_workspace_snapshot",
        {
          p_expected_account_id: account.id,
          p_state: unreferencedState,
          p_expected_revision: before.workspaceRevision + 1,
        },
      );
      if (unreferencedSaveError) throw unreferencedSaveError;
      const unreferencedRow = Array.isArray(unreferencedSave) ? unreferencedSave[0] : unreferencedSave;
      expect(unreferencedRow?.revision).toBe(before.workspaceRevision + 2);

      const wrongOwnerPath = `00000000-0000-0000-0000-000000000001/${goalId}/${evidenceId}/proof.txt`;
      const { error: wrongOwnerError } = await client.rpc("claim_evidence_cleanup", {
        p_expected_account_id: account.id,
        p_remote_paths: [wrongOwnerPath],
      });
      expect(wrongOwnerError?.code).toBe("22023");

      const claim = await claimEvidenceCleanup(client, account.id, [path]);
      expect(claim).toEqual({
        claimed: true,
        workspaceRevision: before.workspaceRevision + 2,
      });
      await expect(claimEvidenceCleanup(client, account.id, [path])).resolves.toEqual(claim);

      const { error: resurrectionError } = await client.rpc("save_workspace_snapshot", {
        p_expected_account_id: account.id,
        p_state: referencedState,
        p_expected_revision: before.workspaceRevision + 2,
      });
      expect(resurrectionError?.code).toBe("PT409");

      const { error: overwriteError } = await bucket.upload(
        path,
        Buffer.from("A claimed path cannot be overwritten"),
        { contentType: "text/plain", upsert: true },
      );
      expect(overwriteError).toBeTruthy();

      const { error: removeError } = await bucket.remove([path]);
      if (removeError) throw removeError;
      await expect.poll(() => listCloudEvidencePaths(account.id)).toEqual([]);

      const { error: resurrectionUploadError } = await bucket.upload(
        path,
        Buffer.from("A claimed path cannot be uploaded again"),
        { contentType: "text/plain", upsert: false },
      );
      expect(resurrectionUploadError).toBeTruthy();
    } finally {
      const { error } = await cloudAdmin().storage.from("evidence").remove([path]);
      if (error) throw error;
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
    const originalRemotePaths = await listCloudEvidencePaths(account.id);

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
      await expect(secondPage.getByRole("button", {
        name: "Rename renamed-proof.txt",
      })).toBeEnabled();
      // Remote paths are immutable object identities. A user-facing rename
      // changes only workspace metadata and must not copy or move cloud bytes.
      await expect.poll(() => listCloudEvidencePaths(account.id)).toEqual(
        originalRemotePaths,
      );

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
      await expect(secondPage.getByText("Private sync up to date", { exact: true })).toBeVisible();
      await secondPage.getByRole("button", { name: "Erase everything" }).click();
      const archive = secondPage.getByRole("dialog", {
        name: "Archive this workspace and start fresh?",
      });
      await expect(archive).toBeVisible();
      const [backup] = await Promise.all([
        secondPage.waitForEvent("download"),
        archive.getByRole("button", {
          name: "Download full backup, then review erasure",
        }).click(),
      ]);
      expect(backup.suggestedFilename()).toMatch(
        /^evolvra-full-backup-\d{4}-\d{2}-\d{2}\.evolvra$/,
      );
      const confirmation = secondPage.getByRole("dialog", { name: "Erase your Evolvra workspace?" });
      await expect(confirmation).toContainText("complete portable backup download was requested");
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

  test("a cross-device change after backup keeps the account, cloud state, evidence, and local scope active", async ({ browser, page }, testInfo) => {
    const baseURL = requireCloudBaseURL(testInfo.project.use.baseURL);
    const account = await createCloudTestAccount("stale-erasure-backup");
    accountIds.add(account.id);
    await signInCloudTestAccount(page, account, baseURL);
    await completeOnboarding(page, {
      name: "Stale Backup Owner",
      starter: true,
      accountId: account.id,
    });
    await waitForCloudProfile(account.id, "Stale Backup Owner");

    await page.goto("/goals");
    await page.getByRole("link", {
      name: "Open goal: Build dependable cardiovascular fitness",
    }).click();
    await page.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
      name: "before-backup.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("This evidence is present in the complete backup"),
    });
    await expect(page.getByText("before-backup.txt")).toBeVisible();
    await expect.poll(() => listCloudEvidencePaths(account.id), { timeout: 20_000 }).toHaveLength(1);

    const secondContext = await browser.newContext({ serviceWorkers: "allow" });
    const secondPage = await secondContext.newPage();
    try {
      await signInCloudTestAccount(secondPage, account, baseURL);
      await secondPage.goto("/goals");
      await secondPage.getByRole("link", {
        name: "Open goal: Build dependable cardiovascular fitness",
      }).click();
      await expect(secondPage.getByText("before-backup.txt")).toBeVisible({ timeout: 20_000 });

      await page.goto("/settings");
      await page.getByRole("button", { name: "Data & recovery" }).click();
      await expect(page.getByText("Private sync up to date", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Erase everything" }).click();
      const archive = page.getByRole("dialog", {
        name: "Archive this workspace and start fresh?",
      });
      const [backup] = await Promise.all([
        page.waitForEvent("download"),
        archive.getByRole("button", {
          name: "Download full backup, then review erasure",
        }).click(),
      ]);
      expect(backup.suggestedFilename()).toMatch(
        /^evolvra-full-backup-\d{4}-\d{2}-\d{2}\.evolvra$/,
      );
      const confirmation = page.getByRole("dialog", {
        name: "Erase your Evolvra workspace?",
      });
      await expect(confirmation).toBeVisible();

      await secondPage.locator('input[type="file"][accept*="text/plain"]').setInputFiles({
        name: "after-backup.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("This newer evidence must survive a stale erasure request"),
      });
      await expect(secondPage.getByText("after-backup.txt")).toBeVisible();
      await expect.poll(() => listCloudEvidencePaths(account.id), { timeout: 20_000 }).toEqual(
        expect.arrayContaining([expect.stringMatching(/-after-backup\.txt$/)]),
      );
      await expect.poll(async () => {
        const cloud = await cloudWorkspaceState(account.id);
        const goals = cloud.state.goals as Array<{
          evidence?: Array<{ name?: string }>;
        }>;
        return goals.some((goal) => goal.evidence?.some(
          (item) => item.name === "after-backup.txt",
        ));
      }, { timeout: 20_000 }).toBe(true);

      await confirmation.getByRole("button", { name: "Erase everything" }).click();
      await expect(page.getByText(/fresh (complete |full )?backup/i)).toBeVisible({ timeout: 20_000 });

      await expect.poll(async () => {
        const { data, error } = await cloudAdmin().auth.admin.getUserById(account.id);
        return error ? null : data.user?.id;
      }, { timeout: 20_000 }).toBe(account.id);
      await expect.poll(async () => {
        const { data, error } = await cloudAdmin()
          .from("account_lifecycle")
          .select("status")
          .eq("user_id", account.id)
          .single();
        if (error) return `error:${error.message}`;
        return data.status;
      }, { timeout: 20_000 }).toBe("active");
      await expect.poll(() => listCloudEvidencePaths(account.id)).toEqual(
        expect.arrayContaining([expect.stringMatching(/-after-backup\.txt$/)]),
      );
      await expect.poll(async () => {
        const cloud = await cloudWorkspaceState(account.id);
        return JSON.stringify(cloud.state).includes("after-backup.txt");
      }).toBe(true);

      const localFence = await readLocalAccountErasureFence(page, account.id);
      expect(localFence.checkpoint).toBeNull();
      expect(localFence.scope).toEqual(expect.objectContaining({
        accountId: account.id,
        tombstoned: false,
      }));
    } finally {
      await secondContext.close();
    }
  });
});
