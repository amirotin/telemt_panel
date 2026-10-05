import { test, expect } from "./fixtures";

for (const locale of ["ru", "en"] as const) {
  test.describe(`WEB DNS (${locale})`, () => {
    test.use({ uiLocale: locale });
    for (const width of [320, 1280]) {
      test(`versioned DNS settings retain draft and check an unconfirmed save (${width}px)`, async ({ page, login }) => {
        await page.setViewportSize({ width, height: 900 });
        await login();
        const response = await page.request.get("/api/telemt/config/catalog");
        expect(response.ok()).toBeTruthy();
        const catalog = await response.json();
        const supported = (process.env["TELEMT_MOCK_VERSION"] ?? "3.5.14") === "3.5.14";
        expect(catalog.fields.some((field: { path: string }) => field.path === "web.vhosts[].decoy.resolve")).toBe(supported);
        await page.goto("/server/config");
        await page.getByRole("tab", { name: locale === "ru" ? "Расширенные" : "Advanced", exact: true }).click();
        if (width === 320) await page.getByRole("button", { name: /^(Разделы|Sections)/ }).click();
        const group = catalog.groups.find((item: { id: string }) => item.id === "web");
        await page.getByRole("button", { name: new RegExp(group.title) }).click();
        const add = page.getByRole("button", { name: locale === "ru" ? "Добавить виртуальный хост" : "Add virtual host", exact: true });
        await add.click();
        await page.getByLabel(locale === "ru" ? "Публичный домен" : "Public hostname", { exact: true }).fill("proxy.example.com");
        await page.getByLabel(locale === "ru" ? "Публичный адрес" : "Public address", { exact: true }).fill("203.0.113.10:443");
        const policy = page.getByLabel(locale === "ru" ? "DNS для HTTP upstream" : "HTTP upstream DNS", { exact: true });
        if (!supported) { await expect(policy).toHaveCount(0); return; }
        await policy.selectOption("startup");
        await page.getByLabel("HTTP upstream", { exact: true }).fill("http://backend.internal:8080");
        const mode = page.getByLabel(locale === "ru" ? "Тип decoy" : "Decoy type", { exact: true });
        await mode.selectOption("static_directory");
        await expect(policy).toHaveCount(0);
        await mode.selectOption("http_upstream");
        await expect(policy).toHaveValue("startup");
        await expect(page.getByLabel("HTTP upstream", { exact: true })).toHaveValue("http://backend.internal:8080");
        let writes = 0;
        await page.route("**/api/telemt/config**", async (route) => {
          if (route.request().method() !== "PATCH") { await route.continue(); return; }
          writes++;
          expect(route.request().headers()["if-match"]).toBeTruthy();
          expect(JSON.stringify(route.request().postDataJSON())).toContain('"resolve":"startup"');
          await route.fulfill({ status: 504, contentType: "application/json", body: JSON.stringify({ code: "telemt_config_outcome_unknown" }) });
        });
        await page.getByRole("button", { name: locale === "ru" ? "Сохранить" : "Save", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: locale === "ru" ? /^Применить/ : /^Apply/ }).click();
        await expect(page.getByText(locale === "ru" ? /Telemt не подтвердил запись/ : /Telemt did not confirm the write/)).toBeVisible();
        const check = page.getByRole("button", { name: locale === "ru" ? "Проверить серверную конфигурацию" : "Check server configuration", exact: true });
        await check.click();
        await expect(policy).toHaveValue("startup");
        await expect(page.getByLabel("HTTP upstream", { exact: true })).toHaveValue("http://backend.internal:8080");
        expect(writes).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
      });
    }
  });
}
