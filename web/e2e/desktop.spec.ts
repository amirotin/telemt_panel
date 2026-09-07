import { expect, test } from "./fixtures";

for (const width of [1440, 768, 390]) {
  test(`overview KPI keeps mixed history accurate at ${width}px`, async ({ page, login }) => {
    await page.setViewportSize({ width, height: 900 });
    const base = Math.floor(Date.now() / 300000) * 300 - 1800;
    let missingRefusals = false, partial = false;
    await page.route("**/api/history?*", async route => {
      const metric = new URL(route.request().url()).searchParams.get("metric");
      if (!["traffic", "attempts", "refusals"].includes(metric ?? "")) return route.continue();
      const value = (ts: number) => metric === "traffic" ? ts * 1024 : metric === "attempts" ? ts * 20 : ts <= 900 ? ts / 5 : 180 + ts - 900;
      const points = [
        ...Array.from({ length: 5 }, (_, i) => {
          const ts = i * 300;
          return { ts: base + ts, v: value(ts + 295), tier: "5m", samples: 60,
            min: value(ts), max: value(ts + 295), first_observed_value: value(ts),
            first_observed_epoch_secs: base + ts, last_observed_epoch_secs: base + ts + 295,
            observed_delta: value(ts + 295) - value(ts), observed_seconds: 295, gaps: 0 };
        }),
        ...Array.from({ length: 61 }, (_, i) => ({ ts: base + 1500 + i * 5, v: value(1500 + i * 5) })),
        ...(partial ? [{ ts: base + 1810, v: value(1810) }] : []),
      ];
      const empty = missingRefusals && metric === "refusals";
      await route.fulfill({ json: { metric, range: "30m", state: empty ? "empty" : "ready",
        requested_from_epoch_secs: base, retention_secs: 86400, source_available: true, points: empty ? [] : points } });
    });
    await login();
    await page.goto("/overview");
    const grid = page.getByTestId("kpi-grid");
    const traffic = grid.getByRole("link", { name: /Трафик/ });
    const quality = grid.getByRole("link", { name: /Качество подключений/ });
    await expect(traffic).toContainText(/900\s+КБ/);
    await expect(quality).toContainText("95 %");
    await expect(quality).toContainText("−4 % за 15 мин");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("overview-mixed-history.png") });

    partial = true;
    await page.reload();
    await expect(traffic).toContainText("доступна часть истории");
    await expect(quality).not.toContainText("−4 % за 15 мин");
    missingRefusals = true;
    await page.reload();
    await expect(quality).toContainText("—");
    await expect(quality).not.toContainText("100 %");
  });
}

for (const width of [1440, 768, 390]) {
  test(`independent history settings confirm retention without changing other categories at ${width}px`, async ({ page, login }) => {
    await page.setViewportSize({ width, height: 900 });
    await login();
    await page.goto("/server/settings");
    const storage = page.getByTestId("settings-storage");
    const duration = storage.getByLabel("Хранить: Технические метрики", { exact: true });
    await expect(duration).toHaveValue("30");
    await expect(storage).not.toContainText("Метрики и события на диске");
    await expect(storage).not.toContainText("Размер недоступен");
    await expect(storage.getByRole("article")).toHaveCount(8);
    await expect(storage.getByRole("combobox")).toHaveCount(8);
    for (const title of ["Технические метрики", "События панели", "Аудит действий", "Проблемы подключений", "Общий трафик", "Трафик пользователей", "История IP-адресов", "Расширенная диагностика"]) {
      await expect(storage.getByRole("article", { name: title, exact: true })).toBeAttached();
    }
    await duration.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("storage.png") });
    const before = await (await page.request.get("/api/settings/storage")).json();
    await duration.selectOption("7");
    await storage.getByRole("button", { name: "Сохранить", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Сократить срок хранения?");
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    const canceled = await (await page.request.get("/api/settings/storage")).json();
    expect(canceled.policies).toEqual(before.policies);
    await storage.getByRole("button", { name: "Сохранить", exact: true }).first().click();
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings/storage") && r.request().method() === "PUT");
    await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await saved).status()).toBe(204);
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await expect(duration).toHaveValue("7");
    const after = await (await page.request.get("/api/settings/storage")).json();
    for (const category of ["events", "connection_issues", "traffic", "diagnostics", "audit", "user_traffic", "user_ip_history"]) {
      expect(after.policies.find((p: { category: string }) => p.category === category))
        .toEqual(before.policies.find((p: { category: string }) => p.category === category));
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await duration.selectOption("30");
    const restored = page.waitForResponse((r) => r.url().endsWith("/api/settings/storage") && r.request().method() === "PUT");
    await storage.getByRole("button", { name: "Сохранить", exact: true }).first().click();
    expect((await restored).status()).toBe(204);
    await expect(dialog).not.toBeVisible();
  });
}

for (const width of [1440, 768, 390]) {
  test(`panel settings keep a single scroll owner and reachable footer at ${width}px`, async ({ page, login }) => {
    await page.setViewportSize({ width, height: 900 });
    await login();
    await page.goto("/server/settings");
    const geoip = page.locator("#geoip");
    await expect(geoip.locator("input").first()).toBeAttached();
    await expect(geoip.locator(".geoip-form-fields")).toHaveAccessibleName("География IP");
    await expect(geoip.locator(".geoip-sources")).toHaveAccessibleName("Источник баз");

    // Visually hidden legends must not escape the page scroll container.
    expect.soft(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
    const main = page.locator("main");
    await main.evaluate(element => element.scrollTo(0, element.scrollHeight));
    expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, 10000));
    expect.soft(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(0);

    const footer = await geoip.locator(".geoip-attribution").boundingBox();
    const mainBox = await main.boundingBox();
    expect(footer).not.toBeNull();
    expect(mainBox).not.toBeNull();
    const bottomNav = page.getByTestId("mobile-bottom-nav");
    const visibleBottom = await bottomNav.isVisible()
      ? (await bottomNav.boundingBox())!.y
      : mainBox!.y + mainBox!.height;
    // The last lines must stay above the fixed mobile navigation.
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(visibleBottom + 1);
  });
}

// desktop.spec.ts — 1280×800 smoke (M3 Task 9 brief: "смоук 1280×800 —
// sidebar, raw-конфиг виден"). Two things the mobile spec structurally
// cannot cover: the wide sidebar
// and the full TOML editor (CodeMirror). The sidebar also proves the grouped operational
// and management information architecture at this width.
test("grouped sidebar navigates, and the TOML config editor (CodeMirror) mounts", async ({ page, login }) => {
  test.slow();
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
  // A clean store needs two cumulative observations before it can report an
  // honest window delta: the first one is only the baseline and the traffic
  // collector's production cadence is 30 seconds. Keep a little scheduling
  // margin instead of racing the second observation at exactly 30 seconds.
  await expect(traffic).toHaveText(/\d/, { timeout: 45_000 });
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
