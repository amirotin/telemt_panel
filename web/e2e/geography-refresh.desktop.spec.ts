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
    await page.clock.pauseAt(new Date());
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
