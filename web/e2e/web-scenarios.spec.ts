// e2e/web-scenarios.spec.ts — the WEB domain across the three Telemt builds
// it has to survive, at the three §27.1 viewport classes (M4 task 8b's
// checkpoint R5-WEB).
//
// Opt-in, like the picture matrix, because it needs the stack restarted per
// scenario:
//
//   make build                                  # from src/, once
//   cd web
//   SCREENSHOTS=1 SCENARIO=full     SCREENSHOT_DIR=… npx playwright test \
//     --project=screenshots e2e/web-scenarios.spec.ts
//   SCREENSHOTS=1 SCENARIO=web-off   … ; SCREENSHOTS=1 SCENARIO=old-build …
//
// It does assert, unlike screenshots.ts: no horizontal overflow on the
// document OR on the `main` scroller at any viewport or step, and no console
// error anywhere in the flow. The PNGs are for a human to look at; they are
// not baselines and nothing here compares pixels.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";

const OUT = path.resolve(process.env["SCREENSHOT_DIR"] ?? "screenshots-out");
const SCENARIO = process.env["SCENARIO"] ?? "full";

const VIEWPORTS = [
  { name: "360x640", width: 360, height: 640 },
  { name: "844x390", width: 844, height: 390 },
  { name: "1280x900", width: 1280, height: 900 },
] as const;

test.describe("R5-WEB", () => {
  for (const vp of VIEWPORTS) {
    test(`${SCENARIO}-${vp.name}`, async ({ page, login }) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(String(e)));

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login();
      // The pre-login /api/auth/me 401 is the app asking whether there is a
      // session; it is not this page's error.
      errors.length = 0;
      const dir = path.join(OUT, `${SCENARIO}-${vp.name}`);
      await mkdir(dir, { recursive: true });

      async function overflow(label: string) {
        const doc = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        const main = await page.evaluate(() => {
          const el = document.querySelector("main");
          return el ? el.scrollWidth - el.clientWidth : 0;
        });
        expect(doc, `${label} document`).toBeLessThanOrEqual(0);
        expect(main, `${label} main`).toBeLessThanOrEqual(0);
      }

      // 1. The Пульс hub card.
      await page.goto("/pulse");
      await expect(page.getByTestId("hub-card-web")).toBeVisible();
      // The cards start on the SSE topic's loading state; the shot is of
      // what a reader sees a moment later, once the first frame lands.
      await expect(page.getByTestId("hub-card-web")).not.toContainText("Загрузка", {
        timeout: 15_000,
      });
      await page.screenshot({ path: path.join(dir, "01-pulse.png") });
      await overflow("pulse");

      // 2. WEB Overview.
      await page.getByTestId("hub-card-web").click();
      await expect(page).toHaveURL(/\/pulse\/diag\/web$/);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.screenshot({ path: path.join(dir, "02-web-overview.png") });
      await overflow("overview");
      const scrolled = await page.evaluate(() => {
        const el = document.querySelector("main");
        if (!el || el.scrollHeight - el.clientHeight < 8) return false;
        el.scrollTop = el.scrollHeight;
        return true;
      });
      if (scrolled) {
        await page.screenshot({ path: path.join(dir, "03-web-overview-bottom.png") });
      }

      // 3. Sessions, the surface and the confirmation — only where the
      //    runtime is actually running.
      const sessionsTab = page.getByRole("tab", { name: "Сессии" });
      if (await sessionsTab.isVisible().catch(() => false)) {
        await page.evaluate(() => {
          const el = document.querySelector("main");
          if (el) el.scrollTop = 0;
        });
        await sessionsTab.click();
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.screenshot({ path: path.join(dir, "04-web-sessions.png") });
        await overflow("sessions");

        const row = page.getByRole("button", { name: /^Открыть детали/ }).first();
        if (await row.isVisible().catch(() => false)) {
          await row.click();
          await expect(page.getByRole("dialog")).toBeVisible();
          await page.screenshot({ path: path.join(dir, "05-web-surface.png") });
          await overflow("surface");

          await page.getByRole("dialog").getByRole("button", { name: "Закрыть сессию" }).click();
          await expect(page.getByText(/Сессия будет закрыта немедленно/)).toBeVisible();
          await page.screenshot({ path: path.join(dir, "06-web-confirm.png") });
          await overflow("confirm");
          await page.getByRole("button", { name: "Отмена" }).click();
        }
      }

      expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
    });
  }
});
