import { defineConfig } from "@playwright/test";
import { BASE_URL, DEV_PORT, DEV_URL } from "./e2e/env";

// playwright.config.ts — Task 9 deliverable A (v2/plans/2026-08-25-m3-frontend.md,
// Ruling R4): chromium only, against the real built panel binary +
// cmd/telemt-mock (e2e/stack.ts), never a mocked fetch layer or the vite
// dev server. Three projects: `mobile` (360×640, the primary target —
// every flow in the brief), `desktop` (1280×800 smoke — sidebar, raw
// config editor) and `details` (M4 Task 5 — spec §27.3's interaction
// matrix on /dev/details, which only a DEV build serves; see e2e/env.ts
// for why that one runs against vite). See web/README.md's "e2e" section
// for how to run this locally.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false, // one shared panel/mock stack — tests share server-side state (users, audit log)
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["html", { open: "never" }], ["list"]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  // The `details` project drives /dev/details, which only exists in a DEV
  // build (see e2e/env.ts). The panel stack for the other two projects is
  // started by globalSetup, as before.
  webServer: {
    command: `npx vite --port ${DEV_PORT} --strictPort --host 127.0.0.1`,
    url: `${DEV_URL}/dev/details`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile",
      use: { viewport: { width: 360, height: 640 } },
      testMatch: /mobile\.spec\.ts/,
    },
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
      testMatch: /desktop\.spec\.ts/,
    },
    {
      // §27.3's interaction scenarios on the Details builder. Phone
      // portrait by default; the specs that need another viewport set it
      // themselves, since half of them are ABOUT changing it.
      name: "details",
      use: { baseURL: DEV_URL, viewport: { width: 390, height: 844 }, hasTouch: true },
      testMatch: /details\.spec\.ts/,
    },
  ],
});
