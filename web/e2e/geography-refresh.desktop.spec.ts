import { test, expect } from "./fixtures";
import { overview } from "../src/geography/testFixtures";

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

for (const view of ["map", "globe"] as const) {
  test(`${view} stays mounted while polling refreshes a selected country`, async ({ page, login }) => {
    await login();
    await page.clock.install();
    const first = overview();
    const next = overview({ snapshot_id: "00000000000000000000000000000002", totals: { unique_ips: 2, accounts: 2, country_count: 1, location_count: 1 } });
    next.countries[0].unique_ips = 2;
    next.points[0].unique_ips = 2;
    let refreshing = false, selectionPending = false;
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/geography**", async route => {
      const url = new URL(route.request().url());
      const data = (url.searchParams.get("snapshot_id") ?? (refreshing ? next.snapshot_id : first.snapshot_id)) === next.snapshot_id ? next : first;
      if (url.pathname.endsWith("/locations")) return route.fulfill({ json: { snapshot_id: data.snapshot_id, items: data.countries, total: 1, next_cursor: null } });
      if (data === next && url.searchParams.has("country")) {
        selectionPending = true;
        await delayed;
      }
      return route.fulfill({ json: { ...data, selection: url.searchParams.has("country") ? data.countries[0] : null } });
    });
    await page.goto(`/geography?country=DE&view=${view}`);
    const renderer = page.locator(view === "map" ? ".geo-vector" : ".geo-globe canvas");
    await expect(renderer).toBeVisible();
    await page.getByRole("button", { name: "Приблизить", exact: true }).click();
    const original = await renderer.elementHandle();
    const row = page.locator(".geo-place-row").first();
    await row.focus();
    const originalRow = await row.elementHandle();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 5000));
    refreshing = true;
    await page.clock.runFor(15_000);
    await expect.poll(async () => { await page.clock.runFor(100); return selectionPending; }).toBe(true);
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    expect(await originalRow!.evaluate(node => node.isConnected && document.activeElement === node)).toBe(true);
    await expect(page.locator('[data-geography-stat="ips"] strong')).toHaveText("1");
    release();
    await expect.poll(async () => { await page.clock.runFor(100); return page.locator('[data-geography-stat="ips"] strong').textContent(); }).toBe("2");
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    expect(await originalRow!.evaluate(node => node.isConnected && document.activeElement === node)).toBe(true);
  });
}

for (const code of ["geography_source_changed", "geography_snapshot_expired"]) {
  test(`root ${code} recovers without replacing the map`, async ({ page, login }) => {
    await login();
    const first = overview();
    const next = overview({ snapshot_id: "00000000000000000000000000000002", totals: { unique_ips: 2, accounts: 2, country_count: 1, location_count: 1 } });
    let refreshing = false, failures = 0;
    await page.route("**/api/geography**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/locations")) return route.fulfill({ json: { snapshot_id: url.searchParams.get("snapshot_id"), items: first.countries, total: 1, next_cursor: null } });
      if (refreshing && failures < 2) {
        failures++;
        return route.fulfill({ status: 409, json: { code, message: "source changed" } });
      }
      return route.fulfill({ json: refreshing ? next : first });
    });
    await page.goto("/geography");
    await expect(page.locator(".geo-vector")).toBeVisible();
    const original = await page.locator(".geo-vector").elementHandle();
    refreshing = true;
    await expect.poll(() => failures, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.locator(".geo-source-line strong")).toHaveText("Последний снимок");
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator(".geo-error")).toHaveCount(0);
    await expect(page.locator('[data-geography-stat="ips"] strong')).toHaveText("2");
    expect(await original!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator(".geo-error")).toHaveCount(0);
  });
}
