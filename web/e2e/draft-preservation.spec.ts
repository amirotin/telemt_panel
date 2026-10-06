import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { SEEDED_USER } from "./env";

// Exercise the built UI. Controlled mutation responses keep the shared
// Telemt fixture unchanged while testing draft ownership across async work.

async function openTomlEditor(page: Page, phone: boolean) {
  if (phone) await page.getByRole("button", { name: "Открыть редактор", exact: true }).first().click();
  const editor = page.locator('.cm-content[contenteditable="true"]').last();
  await expect(editor).toBeVisible();
  return editor;
}

test("unsaved TOML survives switching configuration tabs", async ({ page, login }, testInfo) => {
  await login();
  const phone = testInfo.project.name === "mobile";
  await page.goto("/server/config");
  await page.getByRole("tab", { name: "TOML", exact: true }).click();
  const editor = await openTomlEditor(page, phone);
  const original = await editor.innerText();
  const marker = "# preserve this unsaved TOML draft";
  await editor.fill(original + "\n" + marker + "\n");
  await expect(editor).toContainText(marker);

  if (phone) await page.getByRole("dialog").getByRole("button", { name: "Отмена", exact: true }).click();
  await page.getByRole("tab", { name: "Обычные", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("tab", { name: "TOML", exact: true }).click();
  const restored = await openTomlEditor(page, phone);
  await expect(restored, "A local tab change must preserve the dirty TOML document or require an explicit discard").toContainText(marker);
});

test("structured conflict retry includes edits made after conflict inspection", async ({ page, login }) => {
  await login();
  const initial = { revision: "audit-r1", sections: { general: { log_level: "normal", fast_mode: false } } };
  const fresh = { revision: "audit-r2", sections: { general: { log_level: "normal", fast_mode: true } } };
  const catalog = {
    version: "3.5.14", source_commit: "audit-fixture", documented_fields: 1, runtime_additions: [],
    groups: [{ id: "diagnostics", title: "Diagnostics", short: "Diagnostics" }],
    fields: [{ path: "general.log_level", kind: "enum", options: ["normal", "debug", "error"], data_type: "LogLevel", group: "diagnostics", tier: "normal", default_value: "normal", doc_hot: false, apply: "runtime reload", secret: false }],
  };
  const writes: Array<{ sections: { general: { log_level: string } } }> = [];
  await page.route("**/api/telemt/config/catalog", (route) => route.fulfill({ json: catalog }));
  await page.route("**/api/telemt/config", async (route) => {
    if (route.request().method() === "PATCH") {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) return route.fulfill({ status: 409, json: { code: "revision_conflict", message: "audit external config change" } });
      return route.fulfill({ json: { revision: "audit-r3", changed: ["general.log_level"] } });
    }
    return route.fulfill({ json: writes.length ? fresh : initial });
  });
  await page.goto("/server/config");
  const level = page.locator("select").first();
  await expect(level).toHaveValue("normal");
  await level.selectOption("debug");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByRole("button", { name: "Применить (1)", exact: true }).click();
  const retry = page.getByRole("button", { name: "Перезагрузить и повторить", exact: true });
  await expect(retry).toBeVisible();
  await expect(level).toHaveValue("debug");
  await level.selectOption("error");
  await expect(level).toHaveValue("error");
  await retry.click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].sections.general.log_level, "The visible latest draft must be used by the explicit retry").toBe("error");
});

test("user settings preserve late input during a delayed PATCH", async ({ page, login }) => {
  await login();
  const baselineResponse = await page.request.get(`/api/users/${SEEDED_USER}`);
  expect(baselineResponse.ok()).toBeTruthy();
  const baseline = await baselineResponse.json();
  let release!: () => void;
  let captured!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const received = new Promise<void>((resolve) => { captured = resolve; });
  let submitted: { max_tcp_conns: number } | undefined;
  const path = `**/api/users/${SEEDED_USER}`;
  await page.route(path, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    submitted = route.request().postDataJSON();
    captured();
    await held;
    // Return a contract-shaped success without forwarding the mutation.
    await route.fulfill({ json: { ...baseline, max_tcp_conns: submitted!.max_tcp_conns } });
  });
  try {
    await page.goto(`/people/${SEEDED_USER}?tab=settings`);
    const field = page.locator(".user-inline-form").getByLabel("Макс. соединений", { exact: true });
    await expect(field).toBeVisible();
    await field.fill("41");
    await page.getByTestId("user-form-submit").click();
    await received;
    expect(submitted).toEqual({ max_tcp_conns: 41 });
    await expect(field).toBeEnabled();
    await field.fill("42");
    await expect(field).toHaveValue("42");
    const response = page.waitForResponse((res) => res.request().method() === "PATCH" && new URL(res.url()).pathname === `/api/users/${SEEDED_USER}`);
    release();
    expect((await response).ok()).toBeTruthy();
    await expect(field, "A successful save of 41 must keep the later unsaved value 42 accessible").toHaveValue("42");
    await expect(page.getByTestId("user-form-submit")).toBeEnabled();
  } finally {
    release();
    await page.unroute(path);
  }
});
