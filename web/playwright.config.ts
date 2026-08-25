import { defineConfig } from "@playwright/test";
import { BASE_URL } from "./e2e/env";

// playwright.config.ts — Task 9 deliverable A (v2/plans/2026-08-25-m3-frontend.md,
// Ruling R4): chromium only, against the real built panel binary +
// cmd/telemt-mock (e2e/stack.ts), never a mocked fetch layer or the vite
// dev server. Two projects: `mobile` (360×640, the primary target — every
// flow in the brief) and `desktop` (1280×800 smoke — sidebar, raw config
// editor). See web/README.md's "e2e" section for how to run this locally.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false, // one shared panel/mock stack — tests share server-side state (users, audit log)
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["html", { open: "never" }], ["list"]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
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
  ],
});
