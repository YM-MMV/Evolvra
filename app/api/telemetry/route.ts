import { NextResponse } from "next/server";
import {
  createTelemetryRateLimiter,
  sanitizeTelemetry,
  telemetryEnabled,
} from "@/lib/telemetry";

const MAX_BODY_BYTES = 2_048;
const acceptTelemetryRequest = createTelemetryRateLimiter();
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function reject(status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(
    { accepted: false },
    { status, headers: { ...NO_STORE_HEADERS, ...headers } },
  );
}

function hasSameOriginProvenance(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readBoundedBody(request: Request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function POST(request: Request) {
  if (!telemetryEnabled()) return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
  if (!hasSameOriginProvenance(request)) return reject(403);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return reject(415);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return reject(413);
  if (!acceptTelemetryRequest()) return reject(429, { "Retry-After": "60" });

  let body: unknown;
  try {
    const text = await readBoundedBody(request);
    if (text === null) return reject(413);
    body = JSON.parse(text) as unknown;
  } catch {
    return reject(400);
  }

  const safe = sanitizeTelemetry(body);
  if (!safe) return reject(400);

  // Hosting log drains become the operational sink. `safe` cannot contain a
  // URL, user identifier, error message, stack trace, or workspace value.
  console.info("[Evolvra telemetry]", JSON.stringify(safe));
  return new NextResponse(null, { status: 202, headers: NO_STORE_HEADERS });
}
