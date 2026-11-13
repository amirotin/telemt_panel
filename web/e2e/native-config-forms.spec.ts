import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";

test("native config preflight fences saves and applies saved settings without discarding a draft", async ({ page, login }, testInfo) => {
  test.skip(process.env["SCENARIO"] !== "native-config", "explicit 3.5.17 native config fixture");
  await login();
  await page.goto("/server/config");
  await expect(page.getByTestId("config-native-state")).toBeVisible();
  await page.getByRole("tab", { name: "Расширенные", exact: true }).click();
  const search = page.getByLabel("Поиск параметров");
  await search.fill("network.dns_overrides");
  const dns = page.getByLabel("Подмена адресов DNS", { exact: true });
  const rule = `example.org:443:192.0.2.${testInfo.project.name === "desktop" ? "11" : "12"}`;
  await dns.fill(rule);
  await page.getByTestId("config-save-bar").getByRole("button", { name: "Сохранить", exact: true }).click();
  const preview = page.getByRole("dialog");
  await expect(preview).toContainText("Сервер проверил изменения");
  await expect(preview).toContainText("Эти изменения применяются автоматически");
  const outgoing = page.waitForRequest((request) => request.method() === "PATCH" && new URL(request.url()).pathname.endsWith("/config"));
  await preview.getByRole("button", { name: /^Применить/ }).click();
  const write = await outgoing;
  expect(write.headers()["if-runtime-match"]).toMatch(/^native-/);
  await expect(page.getByTestId("config-save-bar")).toContainText("Нет изменений");

  await search.fill("server.api.runtime_edge_enabled");
  await page.getByRole("switch", { name: "Подробная диагностика", exact: true }).click();
  await page.getByTestId("config-save-bar").getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(preview).toContainText("Сервер проверил изменения");
  await preview.getByRole("button", { name: /^Применить/ }).click();
  const state = page.getByTestId("config-native-state");
  await state.getByRole("button", { name: "Обновить состояние", exact: true }).click();
  await expect(state).toContainText("server.api");
  const directory = process.env["CONFIG_ARTIFACT_DIR"];
  if (directory) {
    await mkdir(directory, { recursive: true });
    await state.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, `native-state-pending-${testInfo.project.name}.png`), fullPage: true });
  }
  await search.fill("network.dns_overrides");
  const unsaved = "unsaved.example:443:192.0.2.99";
  await dns.fill(unsaved);
  await state.getByRole("button", { name: "Перезагрузить сейчас", exact: true }).click();
  await expect(state).toContainText("Сохранённая конфигурация опубликована.");
  await expect(dns).toHaveValue(unsaved);
  await expect(page.getByTestId("config-save-bar")).not.toContainText("Нет изменений");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  if (directory) {
    await state.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, `native-state-applied-${testInfo.project.name}.png`), fullPage: true });
    await dns.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, `native-config-${testInfo.project.name}.png`), fullPage: true });
  }
});
