import { expect, test } from "./fixtures";

// desktop.spec.ts — 1280×800 smoke (M3 Task 9 brief: "смоук 1280×800 —
// sidebar, raw-конфиг виден"). Two things the mobile spec structurally
// cannot cover: the wide sidebar
// and the full TOML editor (CodeMirror). The sidebar also proves the grouped operational
// and management information architecture at this width.
test("grouped sidebar navigates, and the TOML config editor (CodeMirror) mounts", async ({ page, login }) => {
  await login();

  const sidebar = page.getByTestId("full-sidebar");
  await expect(sidebar).toBeVisible();

  // The sidebar status card owns its own GET /api/history query
  // (StatusStrip.tsx), so its traffic counter is populated here on /people —
  // the landing route — without ever visiting Пульс. It used to read «н/д»
  // everywhere except the one page that happened to mount that query.
  const traffic = sidebar.locator('[aria-label^="Трафик за 15 минут"]');
  await expect(traffic).toBeVisible();
  // A real formatted figure, not the «н/д» placeholder and not an empty node.
  await expect(traffic).toHaveText(/\d/, { timeout: 30_000 });
  // Four operational sections followed by two management sections.
  for (const section of ["Сводка", "Люди", "Пульс", "Журнал", "Сервер", "WEB"]) {
    await expect(sidebar.getByRole("link", { name: section })).toBeVisible();
  }

  // Сводка is the widget dashboard; Пульс is the diagnostics hub. The two
  // were one section through M3, so this asserts they are now distinct
  // destinations with distinct content.
  await sidebar.getByRole("link", { name: "Сводка" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByTestId("status-banner")).toBeVisible();
  await expect(page.getByTestId("kpi-grid")).toBeVisible();
  // The full mock intentionally exposes one RPC-only DC. Assert the
  // composition contract (one board, real groups/cards), not the old
  // prototype fixture's hard-coded 6 pairs / 12 routes.
  await expect(page.getByTestId("dc-board")).toBeVisible();
  expect(await page.locator('[data-testid^="dc-group-"]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-testid^="dc-card-"]').count()).toBeGreaterThan(0);
  await expect(page.getByTestId("overview-event-rail")).toBeVisible();
  await expect(page.getByTestId("overview-event-rail").getByTestId("widget-action")).toHaveText("Детали");

  await sidebar.getByRole("link", { name: "Пульс" }).click();
  await expect(page).toHaveURL(/\/pulse$/);
  await expect(page.getByTestId("hub-card-dc")).toBeVisible();
  await page.getByTestId("hub-card-counters").click();
  await expect(page).toHaveURL(/\/pulse\/diag\/counters$/);
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page).toHaveURL(/\/pulse$/);

  // The mobile bottom tab bar must stay hidden at this
  // viewport — the sidebar replaces it, not sits alongside it.
  await expect(page.getByTestId("mobile-bottom-nav")).toBeHidden();

  await sidebar.getByRole("link", { name: "Сервер" }).click();
  await page.getByRole("link", { name: "Конфигурация" }).click();
  await page.getByRole("tab", { name: "TOML" }).click();

  await expect(page.locator(".cm-editor")).toBeVisible();
  // The editor receives a non-empty TOML projection of the same config the
  // structured form edits, rather than an empty or placeholder shell.
  await expect(page.locator(".cm-content")).toContainText("[general]");
});
