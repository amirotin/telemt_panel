import { defineConfig } from "@playwright/test";
import { BASE_URL } from "./e2e/env";

// playwright.config.ts — Task 9 deliverable A (v2/plans/2026-08-25-m3-frontend.md,
// Ruling R4): chromium only, against the real built panel binary +
// cmd/telemt-mock (e2e/stack.ts), never a mocked fetch layer or the vite
// dev server. Two built-stack projects: `mobile` (360×640, the primary target —
// every flow in the brief), `desktop` (1280×800 smoke — sidebar, raw
// config editor). See web/README.md's "e2e" section
// for how to run this locally.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false, // one shared panel/mock stack — tests share server-side state (users, audit log)
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["html", { open: "never" }], ["list"]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  // No `webServer` here: globalSetup owns the real panel/mock stack shared
  // by both projects.
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile",
      use: { viewport: { width: 360, height: 640 } },
      testMatch: /(?:mobile|diagnostics|config-forms)\.spec\.ts/,
    },
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
      testMatch: /(?:desktop|diagnostics|config-forms)\.spec\.ts/,
    },
    // The §27.1 picture matrix (`npm run screenshots`) and the WEB
    // three-build sweep (e2e/web-scenarios.spec.ts). Opt-in: the matrix is
    // ninety page loads and asserts nothing (this repo keeps NO PNG
    // baselines — the regression guard is the overflow sweep and the DOM
    // assertions in the two projects above), and the WEB sweep needs the
    // stack restarted once per SCENARIO.
    ...(process.env["SCREENSHOTS"]
      ? [
          {
            name: "screenshots",
            use: { baseURL: BASE_URL, viewport: { width: 1280, height: 800 } },
            testMatch: /screenshots\.ts|web-scenarios\.spec\.ts/,
          },
        ]
      : []),
  ],
});
