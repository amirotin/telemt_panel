import { test, expect } from "./fixtures";

for (const width of [360, 768, 1440]) {
  test(`temporary history notice is compact and usable across pages at ${width}px`, async ({ page, login }) => {
    await page.setViewportSize({ width, height: 800 });
    await login();
    await expect(page.getByText("SQLite недоступна · история временная", { exact: true })).toHaveCount(0);

    // Only the startup status is substituted; navigation, authentication and
    // page data still use the built panel and Telemt mock. Real fallback and
    // persistence boundaries are exercised by the Go startup tests.
    await page.route("**/api/host", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), active_store: "memory", history_temporary: true } });
    });

    for (const path of ["/overview", "/people", "/server/settings"]) {
      await page.goto(path);
      const notice = page.locator("details").filter({ hasText: "SQLite недоступна · история временная" });
      const summary = notice.locator("summary");
      await expect(summary).toBeVisible();
      await expect(notice).not.toHaveAttribute("open");
      const compact = await notice.boundingBox();
      expect(compact?.height).toBeLessThanOrEqual(76);
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(notice).toHaveAttribute("open", "");
      await expect(notice.locator("p")).toBeVisible();
      await expect(notice).toContainText("не переносится в SQLite автоматически");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath(`history-${path.replaceAll("/", "-")}-${width}.png`) });
      await summary.click();
      await expect(notice).not.toHaveAttribute("open");
    }
  });
}
