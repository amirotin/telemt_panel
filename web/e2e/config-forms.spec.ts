import { expect, test } from "./fixtures";
import type { TelemtConfigCatalog } from "../src/lib/api/generated/types.gen";
import type { Page } from "@playwright/test";

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

async function openTomlEditor(page: Page, phone: boolean) {
  if (phone) await page.getByRole("button", { name: "Открыть редактор", exact: true }).first().click();
  const editor = page.locator('.cm-content[contenteditable="true"]').last();
  await expect(editor).toBeVisible();
  return editor;
}

test("real TOML editor keeps late input after a delayed preview", async ({ page, login }, testInfo) => {
  await login();
  const phone = testInfo.project.name === "mobile";
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/server/config");
  await page.getByRole("tab", { name: "TOML", exact: true }).click();
  const initial = await page.request.get("/api/telemt/config/toml");
  expect(initial.ok()).toBeTruthy();
  const original = (await initial.json()).toml_projection as string;
  expect(original).toMatch(/log_level\s*=\s*"[^"]*"/);
  const draft = original.replace(/log_level\s*=\s*"[^"]*"/, 'log_level = "debug"');
  const later = original.replace(/log_level\s*=\s*"[^"]*"/, 'log_level = "error"');
  const editor = await openTomlEditor(page, phone);
  await editor.fill(draft);

  let release!: () => void;
  let captured!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const received = new Promise<void>((resolve) => { captured = resolve; });
  let submitted = "";
  await page.route("**/api/telemt/config/toml/preview", async (route) => {
    submitted = route.request().postDataJSON().toml_projection;
    const response = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response });
  });
  try {
    if (phone) await page.getByRole("button", { name: "Готово и проверить", exact: true }).click();
    else await page.getByRole("button", { name: "Проверить", exact: true }).click();
    await received;
    expect(submitted).toBe(draft);
    const current = phone ? await openTomlEditor(page, true) : editor;
    await current.fill(later);
    if (phone) await page.getByRole("button", { name: "Отмена", exact: true }).click();
    const response = page.waitForResponse((res) => res.url().endsWith("/api/telemt/config/toml/preview") && res.request().method() === "POST");
    release();
    expect((await response).ok()).toBeTruthy();
    await expect(page.getByRole("button", { name: "Сохранить проверенное", exact: true })).toBeDisabled();
    await expect(await openTomlEditor(page, phone)).toContainText('log_level = "error"');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  } finally {
    release();
    await page.unroute("**/api/telemt/config/toml/preview");
  }
});

test("real TOML editor keeps late input after a delayed save", async ({ page, login }, testInfo) => {
  await login();
  const phone = testInfo.project.name === "mobile";
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/server/config");
  await page.getByRole("tab", { name: "TOML", exact: true }).click();
  const initial = await page.request.get("/api/telemt/config/toml");
  expect(initial.ok()).toBeTruthy();
  const original = (await initial.json()).toml_projection as string;
  const nextLevel = original.includes('log_level = "debug"') ? "info" : "debug";
  const draft = original.replace(/log_level\s*=\s*"[^"]*"/, `log_level = "${nextLevel}"`);
  const later = original.replace(/log_level\s*=\s*"[^"]*"/, 'log_level = "error"');
  const editor = await openTomlEditor(page, phone);
  await editor.fill(draft);
  if (phone) await page.getByRole("button", { name: "Готово и проверить", exact: true }).click();
  else await page.getByRole("button", { name: "Проверить", exact: true }).click();
  const save = page.getByRole("button", { name: "Сохранить проверенное", exact: true });
  await expect(save).toBeEnabled();
  let release!: () => void;
  let captured!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const received = new Promise<void>((resolve) => { captured = resolve; });
  await page.route("**/api/telemt/config/toml", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    captured();
    await held;
    await route.fulfill({ response });
  });
  try {
    await save.click();
    await received;
    const current = phone ? await openTomlEditor(page, true) : editor;
    await current.fill(later);
    if (phone) await page.getByRole("button", { name: "Отмена", exact: true }).click();
    const response = page.waitForResponse((res) => res.url().includes("/api/telemt/config/toml") && res.request().method() === "PATCH");
    release();
    expect((await response).ok()).toBeTruthy();
    await expect(await openTomlEditor(page, phone)).toContainText('log_level = "error"');
    if (phone) await page.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(save).toBeDisabled();
  } finally {
    release();
    await page.unroute("**/api/telemt/config/toml");
  }
});
