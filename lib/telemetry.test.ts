import { describe, expect, it } from "vitest";
import {
  createTelemetryRateLimiter,
  sanitizeTelemetry,
  shouldSampleTelemetry,
  telemetryEnabled,
  WEB_VITAL_SAMPLE_RATE,
} from "@/lib/telemetry";

describe("privacy-safe telemetry boundary", () => {
  it("retains only allowlisted web-vital fields", () => {
    expect(sanitizeTelemetry({
      kind: "web-vital",
      name: "LCP",
      value: 1234.5,
      rating: "good",
      path: "/goals/private-id",
      userId: "private-user",
    })).toEqual({ kind: "web-vital", name: "LCP", value: 1234.5, rating: "good" });
  });

  it("never accepts error messages, stacks, or malformed identifiers", () => {
    expect(sanitizeTelemetry({
      kind: "client-error",
      name: "TypeError",
      digest: "safe_digest-123",
      message: "Private goal title",
      stack: "secret stack",
    })).toEqual({ kind: "client-error", name: "TypeError", digest: "safe_digest-123" });
    expect(sanitizeTelemetry({ kind: "client-error", name: "Error with private text" })).toBeNull();
    expect(sanitizeTelemetry({ kind: "web-vital", name: "UNKNOWN", value: 1, rating: "good" })).toBeNull();
  });

  it("is disabled unless explicitly opted in and samples only high-frequency vitals", () => {
    expect(telemetryEnabled(undefined)).toBe(false);
    expect(telemetryEnabled("false")).toBe(false);
    expect(telemetryEnabled("TRUE")).toBe(false);
    expect(telemetryEnabled("true")).toBe(true);

    const vital = { kind: "web-vital", name: "LCP", value: 10, rating: "good" } as const;
    expect(shouldSampleTelemetry(vital, () => WEB_VITAL_SAMPLE_RATE - 0.001)).toBe(true);
    expect(shouldSampleTelemetry(vital, () => WEB_VITAL_SAMPLE_RATE)).toBe(false);
    expect(shouldSampleTelemetry({ kind: "client-error", name: "Error" }, () => 1)).toBe(true);
  });

  it("rate limits without accepting or retaining a user identifier", () => {
    const accept = createTelemetryRateLimiter(2, 1_000);
    expect(accept(10_000)).toBe(true);
    expect(accept(10_001)).toBe(true);
    expect(accept(10_002)).toBe(false);
    expect(accept(11_000)).toBe(true);
    expect(() => createTelemetryRateLimiter(0)).toThrow(/positive/i);
  });
});
