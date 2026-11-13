import { test, expect } from "./fixtures";

for (const width of [390, 768, 1280, 1920, 2560, 3840]) {
  test(`overview problems and DC grid fit at ${width}px`, async ({ page, login }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 });
    // This layout matrix controls problems through SSE, with supported optional features.
    await page.route("**/api/telemt/info", async route => {
      const info = await (await route.fetch()).json();
      for (const name of ["config_schema", "config_state", "config_validation", "access_policy", "user_source_deny"]) {
        info.capabilities[name] = true;
      }
      await route.fulfill({ json: info });
    });
    await login();
    let count = 0;
    await page.route("**/api/events?*", async (route) => {
      let body;
      for (let i = 0; i < 30; i++) {
        const response = await page.request.get("/api/snapshot?topics=stats,runtime,upstreams,security,users");
        body = await response.json();
        if (body.stats && body.upstreams?.dcs?.dcs?.length) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const base = body.upstreams.dcs.dcs[0];
      const ids = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 203, -203];
      body.upstreams.dcs = {
        ...body.upstreams.dcs, middle_proxy_enabled: true,
        dcs: ids.map((dc, index) => ({ ...base, dc, floor_min: 3, required_writers: 3, alive_writers: index < count - 1 ? 2 : 3, coverage_pct: index < count - 1 ? 66 : 100, rtt_ms: 40 })),
      };
      body.stats.ready = { ...body.stats.ready, ready: count === 0, reason: "Connection source temporarily unavailable; retry the connection and inspect routing. ".repeat(2) };
      body.stats.health = { ...body.stats.health, read_only: false };
      const ts = Math.floor(Date.now() / 1000);
      const frames = Object.entries(body).map(([topic, v]) => `event: ${topic}\ndata: ${JSON.stringify({ v, ts })}\n\n`).join("");
      await route.fulfill({ contentType: "text/event-stream", body: "retry: 60000\n\n" + frames });
    });
    for (count of [0, 1, 4, 6, 10]) {
      await page.goto("/overview");
      const heading = page.getByRole("heading", { name: "Проблемы", exact: true });
      const frame = heading.locator("xpath=../../..");
      const items = page.getByTestId("overview-problem");
      if (count === 0) {
        await expect(frame).toContainText("Проблем не обнаружено");
      } else {
        await expect(items).toHaveCount(Math.min(count, 6));
        expect(await items.evaluateAll((nodes) => nodes.every((node) => node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth))).toBe(true);
        await expect(items.first()).toContainText("inspect routing.");
      }
      expect((await frame.boundingBox())!.height).toBeGreaterThanOrEqual(174);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      if (count === 6) {
        const columns = await page.getByTestId("overview-problems").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
        expect(columns).toBe(width >= 1920 ? 3 : width >= 768 ? 2 : 1);
        const dcBoard = page.getByTestId("dc-board");
        await expect(dcBoard.locator(".overview-dc-group")).toHaveCount(6);
        const dcColumns = await dcBoard.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
        if (width >= 2560) expect(dcColumns).toBe(6);
        if (width >= 1280) {
          const rail = await page.getByTestId("overview-event-rail").boundingBox();
          expect(rail!.width).toBeGreaterThanOrEqual(300);
          expect(rail!.width).toBeLessThanOrEqual(400);
        }
        if (width >= 1920) {
          const support = await page.getByTestId("overview-support-grid").evaluate((node) => ({ columns: getComputedStyle(node).gridTemplateColumns.split(" ").length, tops: Array.from(node.children).slice(0, 3).map((child) => child.getBoundingClientRect().top) }));
          expect(support.columns).toBe(3);
          expect(new Set(support.tops).size).toBe(1);
        }
        await frame.screenshot({ path: testInfo.outputPath("problems.png") });
        await dcBoard.screenshot({ path: testInfo.outputPath("dc-grid.png") });
        await page.getByRole("heading", { name: "Сводка", exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("overview.png") });
      }
      if (count === 10) {
        await page.getByRole("button", { name: /Показать все проблемы/ }).click();
        await expect(items).toHaveCount(10);
        await page.getByRole("button", { name: "Свернуть список" }).click();
        await expect(items).toHaveCount(6);
        await items.nth(1).getByRole("link").click();
        await expect(page).toHaveURL(/\/pulse\/diag\/dc/);
      }
    }
  });
}

for (const width of [2560, 3840]) {
  test(`wide page frames stay fluid across sections at ${width}px`, async ({ page, login }) => {
    await page.setViewportSize({ width, height: 1440 });
    await login();
    for (const path of ["/overview", "/people", "/pulse", "/pulse/diag/security", "/journal", "/server", "/server/config", "/server/settings"]) {
      await page.goto(path);
      const frame = page.getByTestId("page-frame");
      await expect(frame).toBeVisible();
      expect((await frame.boundingBox())!.width).toBeGreaterThan(width - 320);
      await expect(frame).toHaveCSS("max-width", "none");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
  });
}
