import { afterEach, describe, expect, it, vi } from "vitest";
import { reportPrivacySafeTelemetry } from "@/lib/client-telemetry";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client telemetry privacy controls", () => {
  it("keeps the local operational event but sends nothing while disabled", () => {
    vi.stubEnv("NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED", "false");
    const eventTarget = new EventTarget();
    const received: unknown[] = [];
    eventTarget.addEventListener("evolvra:client-error", (event) => {
      received.push((event as CustomEvent).detail);
    });
    const sendBeacon = vi.fn((url: string, body?: BodyInit | null) => {
      void url;
      void body;
      return true;
    });
    const fetch = vi.fn();
    vi.stubGlobal("window", eventTarget);
    vi.stubGlobal("navigator", { sendBeacon });
    vi.stubGlobal("fetch", fetch);

    reportPrivacySafeTelemetry({
      kind: "client-error",
      name: "ErrorBoundary",
      message: "private workspace text",
    });

    expect(received).toEqual([{ kind: "client-error", name: "ErrorBoundary" }]);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only sanitized fields when explicitly enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED", "true");
    const sendBeacon = vi.fn((url: string, body?: BodyInit | null) => {
      void url;
      void body;
      return true;
    });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { sendBeacon });

    reportPrivacySafeTelemetry({
      kind: "client-error",
      name: "ErrorBoundary",
      digest: "safe_digest",
      path: "/goals/private-goal",
      userId: "private-account",
    });

    expect(sendBeacon).toHaveBeenCalledOnce();
    const body = sendBeacon.mock.calls[0]?.[1];
    expect(body).toBeInstanceOf(Blob);
    expect(JSON.parse(await (body as Blob).text())).toEqual({
      kind: "client-error",
      name: "ErrorBoundary",
      digest: "safe_digest",
    });
  });
});
