import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const editableConfig = {
  active: { listen: "127.0.0.1:48180", tls: { mode: "http" } },
  configured: { listen: "127.0.0.1:48180", tls: { mode: "http" } },
  capabilities: { config_writable: true, restart: true, prepare: true, acme_prepare: true },
  manual_hints: [],
  config_path: "/etc/telemt-panel/config.toml",
  manual_restart_command: "systemctl restart telemt-panel",
  default_acme_cache_dir: "/etc/telemt-panel/certs",
  state: "idle",
  restart_required: false,
};

const prepared = {
  receipt: "e2e-receipt",
  expires_at: "2026-09-10T12:05:00Z",
  candidate: {
    listen: "0.0.0.0:9443",
    tls: { mode: "acme", acme_domain: "panel.example.com", acme_cache_dir: "/etc/telemt-panel/certs" },
  },
  new_url: "https://panel.example.com:9443",
  warnings: ["toml_formatting", "public_reachability_unverified", "password_login", "firewall_port", "acme_port_80"],
  certificate: { domain: "panel.example.com", expires_at: "2026-12-09T12:00:00Z", publicly_trusted: true },
};

async function configureFakeAccess(page: Page) {
  let prepareCalls = 0;
  let currentConfig: typeof editableConfig & { new_url?: string } = editableConfig;
  const prepareBodies: unknown[] = [];
  const saveBodies: unknown[] = [];

  await page.route("**/api/settings/tls/config", async (route) => {
    if (route.request().method() === "PUT") {
      saveBodies.push(route.request().postDataJSON());
      currentConfig = { ...currentConfig, configured: prepared.candidate, state: "saved", restart_required: true, new_url: prepared.new_url };
      await route.fulfill({ json: { new_url: prepared.new_url, restart_required: true } });
      return;
    }
    await route.fulfill({ json: currentConfig });
  });
  await page.route("**/api/settings/tls/restart", async (route) => {
    currentConfig = { ...currentConfig, state: "restarting" };
    await route.fulfill({ status: 202, json: { new_url: prepared.new_url, restart_required: true } });
  });
  await page.route("**/api/settings/tls/prepare", async (route) => {
    prepareCalls += 1;
    prepareBodies.push(route.request().postDataJSON());
    if (prepareCalls === 1) {
      await route.fulfill({ status: 422, json: { code: "tls_listener_unavailable", message: "listen tcp 0.0.0.0:9443: bind: address already in use" } });
      return;
    }
    await route.fulfill({ json: prepared });
  });

  return { prepareBodies, saveBodies };
}

for (const width of [1440, 768, 390, 360]) {
  test(`panel access configure, error and manual flow at ${width}px`, async ({ page, login }) => {
    await page.setViewportSize({ width, height: 900 });
    await login();
    await page.goto("/server/settings");
    const card = page.getByTestId("panel-transport");
    await expect(card).toContainText("Без HTTPS");
    await expect(card).toContainText("Соединение не зашифровано");

    const actualStatus = await (await page.request.get("/api/settings/tls")).json();
    expect(actualStatus).toMatchObject({ mode: "http", state: "http" });
    const actualConfigResponse = await page.request.get("/api/settings/tls/config");
    expect(actualConfigResponse.ok()).toBe(true);
    const actualConfig = await actualConfigResponse.json();
    expect(actualConfig).toMatchObject({
      active: { listen: "127.0.0.1:48180", tls: { mode: "http" } },
      capabilities: {
        config_writable: expect.any(Boolean),
        restart: expect.any(Boolean),
        prepare: expect.any(Boolean),
        acme_prepare: expect.any(Boolean),
      },
      manual_hints: expect.any(Array),
    });

    const manualConfig = {
      ...actualConfig,
      capabilities: { config_writable: false, restart: false, prepare: false, acme_prepare: false },
      manual_hints: ["edit_startup_config_manually", "restart_panel_manually"],
    };
    await page.route("**/api/settings/tls/config", (route) => route.fulfill({ json: manualConfig }));
    await page.reload();
    await card.getByRole("button", { name: "Настроить" }).click();
    let dialog = page.getByRole("dialog", { name: "Доступ к панели" });
    await expect(dialog).toContainText("Измените конфигурацию вручную");
    await expect(dialog).toContainText(actualConfig.config_path);
    await expect(dialog).toContainText(actualConfig.manual_restart_command);
    await page.screenshot({ path: test.info().outputPath(`transport-manual-${width}.png`) });
    await dialog.getByRole("button", { name: "Закрыть" }).click();
    await page.unroute("**/api/settings/tls/config");

    const calls = await configureFakeAccess(page);
    await page.reload();
    await card.getByRole("button", { name: "Настроить" }).click();
    dialog = page.getByRole("dialog", { name: "Доступ к панели" });
    await expect(dialog.getByRole("radio")).toHaveCount(4);
    await expect(dialog).toContainText("Автоматический HTTPS");
    await expect(dialog).toContainText("Готовый сертификат");
    await expect(dialog).toContainText("HTTPS через reverse proxy");
    await expect(dialog).toContainText("Обычный HTTP");

    await dialog.getByRole("radio", { name: /Автоматический HTTPS/ }).check();
    await dialog.getByText("Дополнительные параметры", { exact: true }).click();
    await dialog.getByLabel("Адрес прослушивания").fill("0.0.0.0");
    await dialog.getByLabel("Домен").fill("panel.example.com");
    await dialog.getByLabel("Порт").fill("9443");
    await expect(dialog).toContainText("Нужно открыть TCP-порт 9443");
    await expect(dialog).toContainText("Адрес станет доступен не только локально");
    await expect(dialog).toContainText("публичный TCP-порт 80");
    await expect(dialog.getByRole("link", { name: /Условия использования Let's Encrypt/ })).toHaveAttribute("href", "https://letsencrypt.org/repository/");

    await dialog.getByRole("button", { name: "Получить сертификат и проверить" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Не удалось открыть новый адрес прослушивания");
    await expect(dialog.getByRole("alert")).toContainText("address already in use");
    await expect(dialog.getByLabel("Домен")).toHaveValue("panel.example.com");
    await expect(dialog.getByLabel("Порт")).toHaveValue("9443");

    await dialog.getByRole("button", { name: "Получить сертификат и проверить" }).click();
    await expect(dialog).toContainText(prepared.new_url);
    await expect(dialog.getByRole("button", { name: "Сохранить настройки" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Получить сертификат и проверить" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Изменить параметры" })).toBeVisible();
    expect(calls.prepareBodies.at(-1)).toEqual({
      base_path: "",
      public_url: "",
      enabled: false,
      listen: "0.0.0.0:9443",
      tls: { mode: "acme", acme_domain: "panel.example.com", acme_cache_dir: "/etc/telemt-panel/certs" },
    });
    await page.screenshot({ path: test.info().outputPath(`transport-review-${width}.png`) });

    await dialog.getByRole("button", { name: "Изменить параметры" }).click();
    await dialog.getByLabel("Порт").fill("9444");
    await expect(dialog.getByRole("button", { name: "Сохранить настройки" })).toHaveCount(0);
    await dialog.getByLabel("Порт").fill("9443");
    await dialog.getByRole("button", { name: "Получить сертификат и проверить" }).click();
    await dialog.getByRole("button", { name: "Сохранить настройки" }).click();
    await expect(dialog).toContainText("Настройки сохранены и ожидают перезапуска");
    await expect(dialog).toContainText("Сейчас работает: Обычный HTTP");
    await expect(dialog).not.toContainText("HTTPS уже работает");
    expect(calls.saveBodies).toEqual([{ receipt: "e2e-receipt", candidate: prepared.candidate }]);

    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(await dialog.evaluate((node) => node.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`transport-prepared-${width}.png`) });
    await dialog.getByRole("button", { name: "Перезапустить панель" }).click();
    await expect(dialog).toContainText("Перезапуск запрошен");
    await expect(dialog.getByRole("button", { name: "Перезапустить панель" })).toHaveCount(0);
    await expect(dialog).not.toContainText("HTTPS уже работает");
  });
}
