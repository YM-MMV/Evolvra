import { expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireLocalSupabaseUrl } from "../lib/local-supabase-url";

const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anyCloudCredential = Boolean(apiUrl || anonKey || serviceRoleKey);
const allCloudCredentials = Boolean(apiUrl && anonKey && serviceRoleKey);

if (anyCloudCredential && !allCloudCredentials) {
  throw new Error("Cloud E2E URL, anon key, and service-role key must be provided together.");
}

const guardedApiUrl = allCloudCredentials ? requireLocalSupabaseUrl(apiUrl) : undefined;
export const cloudE2eEnabled = Boolean(guardedApiUrl);

let admin: SupabaseClient | null = null;

export function cloudAdmin() {
  if (!guardedApiUrl || !serviceRoleKey) throw new Error("Cloud E2E requires a local Supabase URL and service-role key.");
  admin ??= createClient(guardedApiUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return admin;
}

export interface CloudTestAccount {
  id: string;
  email: string;
}

export async function createCloudTestAccount(prefix: string): Promise<CloudTestAccount> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@evolvra.test`;
  const { data, error } = await cloudAdmin().auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("The cloud test account was not created.");
  return { id: data.user.id, email };
}

export async function signInCloudTestAccount(page: Page, account: CloudTestAccount, baseURL: string) {
  const { data, error } = await cloudAdmin().auth.admin.generateLink({
    type: "magiclink",
    email: account.email,
    options: { redirectTo: `${baseURL}/` },
  });
  const actionLink = data.properties?.action_link;
  if (error || !actionLink) throw error ?? new Error("A local magic link was not generated.");
  const workspaceReady = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === new URL(guardedApiUrl!).origin
      && url.pathname === "/rest/v1/workspace_snapshots"
      && url.searchParams.get("user_id") === `eq.${account.id}`
      && response.request().method() === "GET";
  }, { timeout: 20_000 }).then((response) => {
    if (!response.ok()) {
      throw new Error(`The signed-in workspace request failed with HTTP ${response.status()}.`);
    }
  });
  const handoffReady = page
    .getByRole("dialog", { name: "Choose which private workspace to open" })
    .waitFor({ state: "visible", timeout: 20_000 });
  const accountWorkspaceReady = Promise.race([workspaceReady, handoffReady]);
  await page.goto(actionLink);
  await page.waitForURL((url) => url.origin === new URL(baseURL).origin, { timeout: 20_000 });
  await accountWorkspaceReady;
}

export async function waitForCloudProfile(accountId: string, displayName: string) {
  await expect.poll(async () => {
    const { data, error } = await cloudAdmin()
      .from("workspace_snapshots")
      .select("state")
      .eq("user_id", accountId)
      .maybeSingle();
    if (error) return `Cloud profile query failed: ${error.message}`;
    return data?.state?.profile?.displayName;
  }, { message: `cloud workspace ${accountId} should contain the expected profile`, timeout: 20_000 }).toBe(displayName);
}

export async function cloudWorkspaceState(accountId: string) {
  const { data, error } = await cloudAdmin()
    .from("workspace_snapshots")
    .select("state,revision")
    .eq("user_id", accountId)
    .single();
  if (error) throw error;
  return data as { state: Record<string, unknown>; revision: number };
}

export async function deleteCloudTestAccount(accountId: string) {
  const { error } = await cloudAdmin().auth.admin.deleteUser(accountId);
  if (error && !/not found/i.test(error.message)) throw error;
}

export async function listCloudEvidencePaths(accountId: string) {
  const bucket = cloudAdmin().storage.from("evidence");
  const folders = [accountId];
  const paths: string[] = [];
  while (folders.length) {
    const folder = folders.pop()!;
    let offset = 0;
    while (true) {
      const { data, error } = await bucket.list(folder, { limit: 100, offset });
      if (error) throw error;
      const entries = data ?? [];
      entries.forEach((entry) => {
        const path = `${folder}/${entry.name}`;
        if (entry.id === null) folders.push(path);
        else paths.push(path);
      });
      if (entries.length < 100) break;
      offset += entries.length;
    }
  }
  return paths;
}

export function requireCloudBaseURL(baseURL: string | undefined) {
  if (!baseURL) throw new Error("Playwright baseURL is required for cloud E2E.");
  return baseURL;
}

export function cloudClientConfigured() {
  return Boolean(guardedApiUrl && anonKey);
}
