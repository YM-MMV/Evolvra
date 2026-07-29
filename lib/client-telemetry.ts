"use client";

import {
  sanitizeTelemetry,
  shouldSampleTelemetry,
  telemetryEnabled,
} from "@/lib/telemetry";

export function reportPrivacySafeTelemetry(value: unknown) {
  const safe = sanitizeTelemetry(value);
  if (!safe || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(`evolvra:${safe.kind}`, { detail: safe }));
  if (!telemetryEnabled() || !shouldSampleTelemetry(safe)) return;
  const body = JSON.stringify(safe);
  if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/telemetry", new Blob([body], { type: "application/json" }))) return;
  void fetch("/api/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store",
    keepalive: true,
  }).catch(() => undefined);
}
