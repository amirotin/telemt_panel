import { test, expect } from "./fixtures";

test("custom service commands retain unknown status and manual instructions", async ({
  page,
  login,
}) => {
  await login();
  const original = await (await page.request.get("/api/host")).json();
  const commands = {
    start: "'/opt/tools/control proxy' start",
    stop: "'/opt/tools/control proxy' stop",
    restart: "'/opt/tools/control proxy' restart",
  };
  await page.route("**/api/host", (route) =>
    route.fulfill({
      json: {
        ...original,
        service_manager: "custom",
        privileges_mode: "manual",
        caps: {
          ...original.caps,
          start_telemt: false,
          stop_telemt: false,
          restart_telemt: false,
          restart_panel: false,
          self_update: false,
        },
        manual_commands: {
          restart_telemt: commands.restart,
          restart_panel: "/opt/etc/init.d/S99telemt-panel restart",
        },
      },
    }),
  );
  await page.route("**/api/telemt/service", (route) =>
    route.fulfill({
      json: {
        service: "telemt",
        manager: "custom",
        status: "unknown",
        status_supported: false,
        binding_conflict: false,
        busy: false,
        caps: { start: false, stop: false, restart: false },
        manual_commands: commands,
      },
    }),
  );
  const writes: string[] = [];
  await page.route(/\/api\/telemt\/(start|stop|restart)$/, (route) => {
    writes.push(route.request().method());
    return route.abort();
  });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/server/platform");
    const card = page.getByTestId("telemt-service-control");
    await expect(card).toContainText("Пользовательские команды");
    await expect(card).toContainText("Статус неизвестен");
    for (const label of ["Запустить", "Остановить", "Перезапустить"]) {
      await card.getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("'/opt/tools/control proxy'");
      await page.keyboard.press("Escape");
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  }
  expect(writes).toEqual([]);
});

for (const width of [320, 390, 1280]) {
  test(`Telemt service control uses host state, exact actions and explicit confirmation (${width}px)`, async ({
    page,
    login,
  }, testInfo) => {
    await login();
    await page.setViewportSize({ width, height: 950 });
    let state = "stopped",
      supported = true,
      busy = false,
      manual = false,
      unconfirmed = false;
    const actions: string[] = [];
    await page.route("**/api/telemt/service", (route) =>
      route.fulfill({
        json: {
          service: "telemt-test",
          manager: "systemd",
          status: state,
          status_supported: supported,
          binding_conflict: false,
          busy,
          caps: { start: !manual, stop: !manual, restart: !manual },
          manual_commands: manual
            ? {
                start: "systemctl start telemt-test",
                stop: "systemctl stop telemt-test",
                restart: "systemctl restart telemt-test",
              }
            : {},
        },
      }),
    );
    for (const action of ["start", "stop", "restart"])
      await page.route(`**/api/telemt/${action}`, (route) => {
        actions.push(action);
        if (unconfirmed)
          return route.fulfill({
            status: 502,
            json: { code: "service_action_unconfirmed", message: "test timeout" },
          });
        state = action === "stop" ? "stopped" : "running";
        return route.fulfill({ status: 202 });
      });
    await page.goto("/server/platform");
    const card = page.getByTestId("telemt-service-control");
    await expect(card).toContainText("Остановлен");
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: testInfo.outputPath(`service-control-${width}.png`) });
    await card.getByRole("button", { name: "Запустить", exact: true }).click();
    const dialog = page.getByRole("dialog");
    expect(actions).toEqual([]);
    await dialog.getByRole("button", { name: "Запустить Telemt", exact: true }).click();
    await expect(card).toContainText("Работает");
    expect(actions).toEqual(["start"]);
    await card.getByRole("button", { name: "Остановить", exact: true }).click();
    await expect(dialog).toContainText("подключения");
    expect(actions).toEqual(["start"]);
    await dialog.getByRole("button", { name: "Остановить Telemt", exact: true }).click();
    await expect(card).toContainText("Остановлен");
    expect(actions).toEqual(["start", "stop"]);
    state = "unknown";
    supported = false;
    await page.reload();
    await expect(card).toContainText("Статус неизвестен");
    await expect(card.getByRole("button", { name: "Запустить", exact: true })).toBeEnabled();
    await expect(card.getByRole("button", { name: "Остановить", exact: true })).toBeEnabled();
    await card.getByRole("button", { name: "Остановить", exact: true }).click();
    await expect(dialog).toContainText("Статус неизвестен");
    await page.keyboard.press("Escape");
    expect(actions).toHaveLength(2);
    busy = true;
    await page.reload();
    await expect(card.getByRole("button", { name: "Запустить", exact: true })).toBeDisabled();
    busy = false;
    manual = true;
    await page.reload();
    await card.getByRole("button", { name: "Запустить", exact: true }).click();
    await expect(dialog).toContainText("systemctl start telemt-test");
    await expect(dialog.getByRole("button", { name: "Запустить Telemt", exact: true })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");
    expect(actions).toHaveLength(2);
    manual = false;
    unconfirmed = true;
    await page.reload();
    await card.getByRole("button", { name: "Запустить", exact: true }).click();
    await dialog.getByRole("button", { name: "Запустить Telemt", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(card).toContainText("Статус неизвестен");
    expect(actions).toHaveLength(3);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  });
}

test("failed service stays actionable during delayed background polling", async ({ page, login }) => {
  await login();
  const snapshot = {
    service: "telemt-test", manager: "systemd", status: "stopped", native_state: "failed",
    status_supported: true, binding_conflict: false, busy: false,
    caps: { start: true, stop: true, restart: true }, manual_commands: {},
  };
  let reads = 0;
  let releasePoll!: () => void;
  let pollStarted!: () => void;
  const polling = new Promise<void>((resolve) => { pollStarted = resolve; });
  const delayed = new Promise<void>((resolve) => { releasePoll = resolve; });
  await page.route("**/api/telemt/service", async (route) => {
    if (++reads > 1) { pollStarted(); await delayed; }
    await route.fulfill({ json: snapshot });
  });
  let writes = 0;
  await page.route("**/api/telemt/restart", (route) => {
    writes++;
    return route.fulfill({ status: 502, json: { code: "service_action_unconfirmed", message: "unconfirmed" } });
  });
  await page.goto("/server/platform");
  const card = page.getByTestId("telemt-service-control");
  await expect(card).toContainText("Сбой");
  await expect(card.getByRole("link", { name: "Открыть журнал Telemt" })).toHaveAttribute("href", /\/journal$/);
  await polling;
  try {
    await expect(card.getByRole("button", { name: "Перезапустить", exact: true })).toBeEnabled();
    await card.getByRole("button", { name: "Перезапустить", exact: true }).click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Перезапустить Telemt", exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Проверьте состояние службы");
    expect(writes).toBe(1);
  } finally {
    releasePoll();
  }
});
