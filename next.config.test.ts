import { afterEach, describe, expect, it, vi } from "vitest";

async function loadContentSecurityPolicy({
  ci = "true",
  cloudE2e = "true",
  vercel = "1",
  supabaseUrl,
}: {
  ci?: string;
  cloudE2e?: string;
  vercel?: string;
  supabaseUrl: string;
}) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CI", ci);
  vi.stubEnv("EVOLVRA_CLOUD_E2E", cloudE2e);
  vi.stubEnv("VERCEL", vercel);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", supabaseUrl);
  vi.resetModules();

  const { default: config } = await import("./next.config");
  if (!config.headers) throw new Error("Next config must define security headers.");
  const rules = await config.headers();
  const policy = rules
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === "Content-Security-Policy")
    ?.value;

  if (!policy) throw new Error("Next config must define a Content-Security-Policy header.");
  return policy;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("production Supabase CSP", () => {
  it("allows HTTP and WebSocket loopback only for the explicit cloud E2E build", async () => {
    const policy = await loadContentSecurityPolicy({
      supabaseUrl: "http://127.0.0.1:54321",
    });

    expect(policy).toContain("http://127.0.0.1:54321");
    expect(policy).toContain("ws://127.0.0.1:54321");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });

  it.each([
    { ci: "false", cloudE2e: "true", supabaseUrl: "http://127.0.0.1:54321" },
    { ci: "true", cloudE2e: "false", supabaseUrl: "http://127.0.0.1:54321" },
    { ci: "true", cloudE2e: "true", supabaseUrl: "http://localhost.evil.test:54321" },
    { ci: "true", cloudE2e: "true", supabaseUrl: "http://user:password@localhost:54321" },
  ])("rejects insecure production source outside the bounded loopback contract: $supabaseUrl", async (environment) => {
    const policy = await loadContentSecurityPolicy(environment);

    expect(policy).not.toContain(environment.supabaseUrl);
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("keeps HTTPS Supabase enabled and upgrade enforcement intact", async () => {
    const policy = await loadContentSecurityPolicy({
      supabaseUrl: "https://project.supabase.co",
    });

    expect(policy).toContain("https://project.supabase.co");
    expect(policy).toContain("wss://project.supabase.co");
    expect(policy).toContain("upgrade-insecure-requests");
  });

  it("does not rewrite assets to HTTPS under a local production server", async () => {
    const policy = await loadContentSecurityPolicy({
      vercel: "",
      supabaseUrl: "https://project.supabase.co",
    });

    expect(policy).toContain("https://project.supabase.co");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
});
