// e2e/screenshots.ts — the spec §27.1 viewport matrix, on demand.
//
// Visual-regression policy for this repo (M4 task 10): NO PNG baselines are
// committed. A pixel baseline for ten screens across nine viewports is 90
// files that a font-hinting difference between two machines can invalidate
// wholesale, and reviewing a re-recorded baseline is not reviewing anything.
// The CI guard is behavioural instead — mobile/desktop/details specs assert
// the DOM and sweep for horizontal overflow at every §27.1 viewport — and
// THIS file makes the picture matrix reproducible whenever a human wants to
// look at it.
//
// Run it:
//
//   make build                       # from src/, once — e2e runs the real binary
//   cd web && npm run screenshots     # writes ./screenshots-out (gitignored)
//   SCREENSHOT_DIR=/somewhere npm run screenshots
//
// It is NOT part of `npm run e2e`: the project only exists when
// SCREENSHOTS=1 is set (playwright.config.ts), so a normal run never pays
// for 90 page loads.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";

// §27.1's table, verbatim. The landscape phones are the interesting half:
// 844×390 must reach compact landscape and not desktop (§28.6).
const VIEWPORTS = [
  { name: "phone-portrait-360x640", width: 360, height: 640 },
  { name: "phone-portrait-390x844", width: 390, height: 844 },
  { name: "phone-landscape-640x360", width: 640, height: 360 },
  { name: "phone-landscape-740x360", width: 740, height: 360 },
  { name: "phone-landscape-844x390", width: 844, height: 390 },
  { name: "tablet-portrait-768x1024", width: 768, height: 1024 },
  { name: "tablet-landscape-1024x768", width: 1024, height: 768 },
  { name: "desktop-1366x768", width: 1366, height: 768 },
  { name: "desktop-1920x1080", width: 1920, height: 1080 },
] as const;

// Сводка, Пульс and the eight Details pages — the wave's whole surface.
const SCREENS = [
  { name: "01-overview", url: "/overview" },
  { name: "02-pulse", url: "/pulse" },
  { name: "03-dc", url: "/pulse/diag/dc" },
  { name: "04-me", url: "/pulse/diag/me" },
  { name: "05-security", url: "/pulse/diag/security" },
  { name: "06-counters", url: "/pulse/diag/counters" },
  { name: "07-connections", url: "/pulse/diag/connections" },
  { name: "08-upstreams", url: "/pulse/diag/upstreams" },
  { name: "09-nat", url: "/pulse/diag/nat" },
  { name: "10-events", url: "/pulse/diag/events" },
] as const;

const OUT_DIR = path.resolve(process.env["SCREENSHOT_DIR"] ?? "screenshots-out");

test.describe("§27.1 screenshot matrix", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}`, async ({ page, login }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await login();
      const dir = path.join(OUT_DIR, viewport.name);
      await mkdir(dir, { recursive: true });

      for (const screen of SCREENS) {
        await page.goto(screen.url);
        // The pages are SSE-fed; wait for the first frame to have landed
        // rather than for a fixed delay, so the shot is of a page with data
        // and not of its skeleton.
        await expect(page.locator("main")).toBeVisible();
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.screenshot({
          path: path.join(dir, `${screen.name}.png`),
          fullPage: true,
        });
      }
    });
  }
});
