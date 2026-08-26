import { expect, test } from "./fixtures";

// desktop.spec.ts — 1280×800 smoke (Task 9 brief: "смоук 1280×800 — sidebar,
// raw-конфиг виден"). Two things the mobile spec structurally cannot cover:
// the `lg:` sidebar (Shell.tsx's `aside`, `hidden lg:flex`) and the
// Конфигурация raw editor (CodeMirror, `lg:`-only per useIsDesktop.ts /
// ConfigPage.tsx — the mobile view is read-only with no editor to mount at
// all).
test("sidebar is visible and the raw config editor (CodeMirror) mounts at lg:", async ({ page, login }) => {
  await login();

  const sidebar = page.locator("aside");
  await expect(sidebar).toBeVisible();

  // The sidebar status card owns its own GET /api/history query
  // (StatusStrip.tsx), so its traffic counter is populated here on /people —
  // the landing route — without ever visiting Пульс. It used to read «н/д»
  // everywhere except the one page that happened to mount that query.
  const traffic = sidebar.locator('[aria-label^="Трафик за 15 минут"]');
  await expect(traffic).toBeVisible();
  // A real formatted figure, not the «н/д» placeholder and not an empty node.
  await expect(traffic).toHaveText(/\d/, { timeout: 30_000 });
  await expect(sidebar.getByRole("link", { name: "Люди" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Пульс" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Журнал" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Сервер" })).toBeVisible();

  // The mobile bottom tab bar (`lg:hidden`) must stay hidden at this
  // viewport — the sidebar replaces it, not sits alongside it.
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeHidden();

  await sidebar.getByRole("link", { name: "Сервер" }).click();
  await page.getByRole("link", { name: "Конфигурация" }).click();
  await page.getByRole("tab", { name: "Raw" }).click();

  await expect(page.locator(".cm-editor")).toBeVisible();
  // The doc CodeMirror mounted is the same JSON `sections` object the
  // Quick Settings tab edits — a non-empty JSON object round-tripped
  // through the editor, not an empty/placeholder shell.
  await expect(page.locator(".cm-content")).toContainText("{");
});
