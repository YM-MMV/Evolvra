import { defineConfig, devices } from "@playwright/test";

const configuredUrl = process.env.EVOLVRA_PRODUCTION_URL
  ?? "https://evolvra-seven.vercel.app";
const productionUrl = new URL(configuredUrl);

if (productionUrl.protocol !== "https:") {
  throw new Error("Production browser smoke requires an HTTPS origin.");
}

if (productionUrl.username || productionUrl.password
  || productionUrl.search || productionUrl.hash) {
  throw new Error(
    "Production browser smoke URL must not contain credentials, a query, or a fragment.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results-production",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: productionUrl.origin,
    colorScheme: "dark",
    locale: "en-GB",
    serviceWorkers: "allow",
    // Production auth runs use disposable accounts, but the browser context can
    // still contain short-lived magic-link tokens. Do not retain recordings.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    {
      name: "production-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
