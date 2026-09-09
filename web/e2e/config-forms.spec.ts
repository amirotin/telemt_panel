import { expect, test } from "./fixtures";
import type { TelemtConfigCatalog } from "../src/lib/api/generated/types.gen";

test("structured config keeps domain navigation and advanced search on desktop and phone", async ({ page, login }, testInfo) => {
  await login();
  await page.goto("/server/config");
  const response = await page.request.get("/api/telemt/config/catalog");
  expect(response.ok()).toBeTruthy();
  const catalog = await response.json() as TelemtConfigCatalog;
  const phone = testInfo.project.name === "mobile";
  const picker = page.getByRole("button", { name: /^Разделы / });

  await expect(page.locator("main")).toHaveCount(1);
  for (const id of ["routing", "me", "upstreams", "tls", "web", "listeners"]) {
    const group = catalog.groups.find((item) => item.id === id)!;
    expect(group).toBeTruthy();
    if (phone) await picker.click();
    const navigation = phone
      ? page.getByRole("dialog", { name: "Разделы настроек" })
      : page.locator("aside").filter({ has: page.locator('button[aria-current="page"]') });
    await navigation.getByRole("button").filter({ has: page.getByText(group.short, { exact: true }) }).click();
    if (phone) await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: group.title, exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }

  await page.getByRole("tab", { name: "Расширенные", exact: true }).click();
  await page.getByLabel("Поиск параметров").fill("general.fast_mode");
  await expect(page.locator("code").filter({ hasText: /^general\.fast_mode$/ })).toBeVisible();
  await page.getByRole("tab", { name: "Обычные", exact: true }).click();
  await expect(page.getByLabel("Поиск параметров")).toHaveCount(0);
  await expect(page.getByTestId("config-save-bar")).toContainText("Нет изменений");
});
