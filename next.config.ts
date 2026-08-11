import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";
// A local `next start` is a production build served over HTTP. Upgrade only
// on the HTTPS deployment target (or an explicitly equivalent host), otherwise
// WebKit correctly upgrades local asset URLs to an unavailable TLS endpoint.
const isHttpsDeployment = isProduction
  && (
    process.env.VERCEL === "1"
    || process.env.EVOLVRA_FORCE_HTTPS === "true"
  );
// This server-only flag is set solely by the bounded local-Supabase CI job.
// Deployed production builds continue to require HTTPS.
const isCloudE2e = isProduction
  && process.env.CI === "true"
  && process.env.EVOLVRA_CLOUD_E2E === "true";
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const configuredSupabase = (() => {
  const omitted = { sources: [] as string[], usesInsecureLoopback: false };
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) return omitted;
  try {
    const url = new URL(value);
    const isInsecureLoopback = url.protocol === "http:"
      && !url.username
      && !url.password
      && loopbackHosts.has(url.hostname.toLowerCase());
    const protocolAllowed = url.protocol === "https:"
      || (!isProduction && url.protocol === "http:")
      || (isCloudE2e && isInsecureLoopback);

    if (!protocolAllowed) return omitted;
    return {
      sources: [url.origin, url.origin.replace(/^http/, "ws")],
      usesInsecureLoopback: isProduction && isInsecureLoopback,
    };
  } catch {
    return omitted;
  }
})();

const connectSources = Array.from(new Set([
  "'self'",
  ...configuredSupabase.sources,
  ...(!isProduction ? ["http://localhost:*", "ws://localhost:*"] : []),
]));

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${connectSources.join(" ")}`,
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' data: blob:",
  // Private PDF evidence is rendered from a short-lived object URL. Framing
  // the app itself remains prohibited by frame-ancestors and X-Frame-Options.
  "frame-src 'self' blob:",
  ...(isHttpsDeployment && !configuredSupabase.usesInsecureLoopback ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  ...(isProduction
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
