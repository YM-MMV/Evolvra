export const WEB_VITAL_NAMES = ["CLS", "FCP", "INP", "LCP", "TTFB"] as const;
export const WEB_VITAL_RATINGS = ["good", "needs-improvement", "poor"] as const;

export type PrivacySafeTelemetry =
  | {
      kind: "web-vital";
      name: (typeof WEB_VITAL_NAMES)[number];
      value: number;
      rating: (typeof WEB_VITAL_RATINGS)[number];
    }
  | {
      kind: "client-error";
      name: string;
      digest?: string;
    };

export const WEB_VITAL_SAMPLE_RATE = 0.1;

/** Telemetry remains entirely off for beta builds unless explicitly enabled. */
export function telemetryEnabled(
  value = process.env.NEXT_PUBLIC_EVOLVRA_TELEMETRY_ENABLED,
) {
  return value === "true";
}

/** Client errors are rare and allowlisted; high-frequency web vitals are sampled. */
export function shouldSampleTelemetry(
  value: PrivacySafeTelemetry,
  random: () => number = Math.random,
) {
  return value.kind === "client-error" || random() < WEB_VITAL_SAMPLE_RATE;
}

/**
 * Per-process fixed-window protection with no IP address, cookie, account, or
 * other identifier retained. Infrastructure controls can add broader limits.
 */
export function createTelemetryRateLimiter(limit = 120, windowMs = 60_000) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
    throw new Error("Telemetry rate-limit bounds must be positive.");
  }
  let windowStartedAt: number | null = null;
  let count = 0;
  return (now = Date.now()) => {
    if (windowStartedAt === null || now - windowStartedAt >= windowMs || now < windowStartedAt) {
      windowStartedAt = now;
      count = 0;
    }
    if (count >= limit) return false;
    count += 1;
    return true;
  };
}

const boundedToken = (value: unknown, maximum: number) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum && /^[a-z0-9._-]+$/i.test(value)
    ? value
    : undefined;

/**
 * Strictly allowlists operational fields. URLs, user/account identifiers,
 * error messages, stack traces, and workspace content never cross this boundary.
 */
export function sanitizeTelemetry(value: unknown): PrivacySafeTelemetry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind === "web-vital") {
    if (!WEB_VITAL_NAMES.includes(input.name as (typeof WEB_VITAL_NAMES)[number])) return null;
    if (!WEB_VITAL_RATINGS.includes(input.rating as (typeof WEB_VITAL_RATINGS)[number])) return null;
    if (typeof input.value !== "number" || !Number.isFinite(input.value) || input.value < 0 || input.value > 10_000_000) return null;
    return {
      kind: "web-vital",
      name: input.name as (typeof WEB_VITAL_NAMES)[number],
      value: input.value,
      rating: input.rating as (typeof WEB_VITAL_RATINGS)[number],
    };
  }
  if (input.kind === "client-error") {
    const name = boundedToken(input.name, 64);
    if (!name) return null;
    const digest = boundedToken(input.digest, 128);
    return { kind: "client-error", name, ...(digest ? { digest } : {}) };
  }
  return null;
}
