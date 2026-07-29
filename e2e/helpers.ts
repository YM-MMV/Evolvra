import { expect, type Page } from "@playwright/test";
import axe from "axe-core";

export async function completeOnboarding(
  page: Page,
  {
    name = "Release Tester",
    starter = false,
    birthDate = "1990-01-01",
    accountId = "anonymous",
  }: { name?: string; starter?: boolean; birthDate?: string; accountId?: string } = {},
) {
  if (new URL(page.url()).pathname !== "/") await page.goto("/");
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();
  await page.getByRole("button", { name: /Begin setup/ }).click();
  await page.getByLabel("Display name").fill(name);
  if (birthDate) await page.getByLabel("Birth date").fill(birthDate);
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: starter ? /Starter workspace/ : /Clean workspace/ }).click();
  await page.getByRole("button", { name: /Enter command centre/ }).click();
  await expect(page.getByRole("heading", { name: "What will move your life forward?" })).toBeVisible();
  await expect(page.getByText(new RegExp(`Good (morning|afternoon|evening), ${escapeRegExp(name)}`))).toBeVisible();
  await waitForWorkspace(page, accountId);
}

export async function waitForAnonymousWorkspace(page: Page) {
  await waitForWorkspace(page, "anonymous");
}

export async function waitForWorkspace(page: Page, accountId: string) {
  await expect.poll(() => page.evaluate(async (expectedAccountId) => {
    return await new Promise<boolean>((resolve) => {
      const request = indexedDB.open("evolvra-persistence");
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("workspaces")) {
          database.close();
          resolve(false);
          return;
        }
        const transaction = database.transaction("workspaces", "readonly");
        const read = transaction.objectStore("workspaces").get(expectedAccountId);
        read.onerror = () => {
          database.close();
          resolve(false);
        };
        read.onsuccess = () => {
          const onboarded = read.result?.state?.profile?.onboarded === true;
          database.close();
          resolve(onboarded);
        };
      };
    });
  }, accountId), {
    message: `the ${accountId === "anonymous" ? "anonymous" : "account"} workspace should be persisted before navigation or reload`,
  }).toBe(true);
}

export async function readAnonymousWorkspaceState(page: Page) {
  return page.evaluate(async () => {
    return await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open("evolvra-persistence");
      request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("workspaces", "readonly");
        const read = transaction.objectStore("workspaces").get("anonymous");
        read.onerror = () => {
          database.close();
          reject(read.error ?? new Error("The anonymous workspace could not be read."));
        };
        read.onsuccess = () => {
          const state: unknown = read.result?.state;
          database.close();
          resolve(state);
        };
      };
    });
  });
}

export async function seriousAxeViolations(page: Page) {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    type AxeViolation = {
      id: string;
      impact: string | null;
      help: string;
      nodes: Array<{ target: string[]; failureSummary?: string }>;
    };
    const axeApi = (window as typeof window & {
      axe: {
        run: (
          context: Document,
          options: Record<string, unknown>,
        ) => Promise<{ violations: AxeViolation[] }>;
      };
    }).axe;
    const results = await axeApi.run(document, {
      resultTypes: ["violations"],
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });
    return results.violations.filter((violation) =>
      violation.impact === "serious" || violation.impact === "critical");
  });
}

export function formatAxeViolations(
  violations: Awaited<ReturnType<typeof seriousAxeViolations>>,
) {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target.join(" ")),
  }));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
