import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke tiers.
 *
 * `offline.spec.ts` runs against the built UI in `VITE_OFFLINE_MODE=1`, so it
 * needs no Freenet node and gates every PR.
 *
 * `gateway.spec.ts` runs only when FREENET_BASE_URL points at a
 * `/v1/contract/web/<id>/` URL. It is the iframe-shell/liveness tier and is
 * skipped otherwise, so it is harmless to ship in CI.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run preview:offline -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
