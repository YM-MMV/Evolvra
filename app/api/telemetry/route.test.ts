import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/telemetry/route";

const request = (body: string, headers: Record<string, string> = {}) => new Request("https://evolvra.test/api/telemetry", {
  method: "POST",
  body,
  headers: { "Content-Type": "application/json", ...headers },
});

describe("telemetry endpoint", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED", "true"));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("accepts only same-origin, allowlisted operational data", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(request(JSON.stringify({
      kind: "web-vital",
      name: "LCP",
      value: 1200,
      rating: "good",
      privateGoal: "must be discarded",
    }), { "Sec-Fetch-Site": "same-origin" }));

    expect(response.status).toBe(202);
    expect(info).toHaveBeenCalledWith(
      "[Evolvra telemetry]",
      JSON.stringify({ kind: "web-vital", name: "LCP", value: 1200, rating: "good" }),
    );
  });

  it("does no processing or logging when beta telemetry is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED", "false");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await POST(request("not-json"));
    expect(response.status).toBe(204);
    expect(info).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("requires browser provenance and accepts an exact same-origin Origin fallback", async () => {
    expect((await POST(request("{}"))).status).toBe(403);
    expect((await POST(request("{}", { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect((await POST(request(JSON.stringify({
      kind: "client-error",
      name: "ErrorBoundary",
    }), { Origin: "https://evolvra.test" }))).status).toBe(202);
    expect((await POST(request("{}", { Origin: "https://evolvra.test.evil" }))).status).toBe(403);
  });

  it("rejects oversized streams and non-JSON requests before logging", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect((await POST(request("{}", {
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "text/plain",
    }))).status).toBe(415);
    expect((await POST(request("{}", { "Sec-Fetch-Site": "same-origin", "Content-Length": "2049" }))).status).toBe(413);
    expect((await POST(request("x".repeat(2_049), { "Sec-Fetch-Site": "same-origin" }))).status).toBe(413);
    expect(info).not.toHaveBeenCalled();
  });
});
