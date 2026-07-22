const LOCAL_SUPABASE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Destructive cloud integration tests are only allowed to address loopback.
 * Exact parsed host matching rejects lookalike domains and URL credentials.
 */
export function requireLocalSupabaseUrl(value: string | undefined) {
  if (!value) throw new Error("Cloud E2E requires a local Supabase API URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cloud E2E requires a valid local Supabase API URL.");
  }
  if (
    url.protocol !== "http:"
    || Boolean(url.username || url.password)
    || !LOCAL_SUPABASE_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("Refusing to run destructive cloud E2E against a non-loopback Supabase URL.");
  }
  return url.toString();
}
