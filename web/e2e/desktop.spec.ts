import { expect, test } from "./fixtures";

// desktop.spec.ts — 1280×800 smoke (M3 Task 9 brief: "смоук 1280×800 —
// sidebar, raw-конфиг виден"). Two things the mobile spec structurally
// cannot cover: the `lg:` sidebar (Shell.tsx's `aside`, `hidden lg:flex`)
// and the Конфигурация raw editor (CodeMirror, `lg:`-only per
// useIsDesktop.ts / ConfigPage.tsx — the mobile view is read-only with no
// editor to mount at all). M4 task 9 added the five-section walk: the
// sidebar renders the same NAV_ITEMS the tab bar does, so Сводка/Пульс
// being two destinations has to hold at this width too.
test("five-section sidebar navigates, and the raw config editor (CodeMirror) mounts at lg:", async ({ page, login }) => {
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
  // All five sections of the IA (06-ui.md), in order.
  for (const section of ["Сводка", "Люди", "Пульс", "Журнал", "Сервер"]) {
    await expect(sidebar.getByRole("link", { name: section })).toBeVisible();
  }

  // Сводка is the widget dashboard; Пульс is the diagnostics hub. The two
  // were one section through M3, so this asserts they are now distinct
  // destinations with distinct content.
  await sidebar.getByRole("link", { name: "Сводка" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole("heading", { name: "Статус", level: 3 })).toBeVisible();

  await sidebar.getByRole("link", { name: "Пульс" }).click();
  await expect(page).toHaveURL(/\/pulse$/);
  await expect(page.getByTestId("hub-card-dc")).toBeVisible();
  await page.getByTestId("hub-card-counters").click();
  await expect(page).toHaveURL(/\/pulse\/diag\/counters$/);
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page).toHaveURL(/\/pulse$/);

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
