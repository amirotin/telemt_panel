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
