import { expect, test } from "./fixtures";

const domains = [
  ["connections", "Соединения", "Connections", "connections-chart"],
  ["counters", "Счётчики", "Counters", "counters-hero"],
  ["dc", "Дата-центры", "Data centers", "dc-selected-pair"],
  ["events", "События", "Events", "events-timeline"],
  ["me", "Middle End", "Middle End", "me-overview"],
  ["nat", "NAT/STUN", "NAT/STUN", "nat-overview"],
  ["security", "Безопасность / TLS", "Security / TLS", "security-posture-panel"],
  ["upstreams", "Апстримы", "Upstreams", "upstreams-selection"],
  ["web", "WEB", "WEB", "web-overview"],
] as const;

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"] as const) {
    test(`RU/EN diagnostics render and preserve numeric readings at ${width}px in ${theme}`, async ({ page, login }) => {
      test.slow();
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await login();
      let russianCapacity: Array<{ id: string | null; digits: string }> = [];
      for (const locale of ["ru", "en"] as const) {
        if (locale === "en") {
          await page.goto("/server/settings");
          await page.getByTestId("settings-interface").getByRole("radio", { name: "English", exact: true }).click();
          await expect(page.locator("html")).toHaveAttribute("lang", "en");
        }
        for (const [domain, russian, english, ready] of domains) {
          await page.goto(`/pulse/diag/${domain}`);
          await expect(page.getByRole("heading", { name: locale === "ru" ? russian : english, level: 1 })).toBeVisible();
          await expect(page.getByTestId(ready)).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        }
        const readings = await page.locator("[data-web-capacity]").evaluateAll(rows => rows.map(row => ({
          id: row.getAttribute("data-web-capacity"),
          digits: (row.querySelector(".tabular-nums")?.textContent ?? "").replace(/\D/g, ""),
        })));
        expect(readings.length).toBeGreaterThan(0);
        expect(readings.every(reading => reading.digits.length > 0)).toBe(true);
        if (locale === "ru") russianCapacity = readings;
        else expect(readings).toEqual(russianCapacity);
        const labels = page.locator('[data-web-capacity="streams"]');
        await expect(labels).toContainText(locale === "ru" ? "Потоки" : "Streams");
        await expect(page.locator('[data-web-capacity="http"]')).toContainText(locale === "ru" ? "HTTP-соединения" : "HTTP connections");
      }
    });
  }
}
