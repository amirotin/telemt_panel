import { test, expect } from "./fixtures";
import { MOCK_URL } from "./env";

test("2000 users keep full search, bounded rows and mobile actions", async ({ page, login }) => {
  test.skip(process.env["RUN_PEOPLE_SCALE"] !== "1", "opt-in isolated mock workload");
  test.setTimeout(120_000);
  // Never seed a configured Telemt URL. globalSetup owns this fixed mock port.
  expect(MOCK_URL).toBe("http://127.0.0.1:48190");
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < 2000) {
      const index = next++;
      const response = await page.request.post(`${MOCK_URL}/v1/users`, {
        data: { username: `scale-${String(index).padStart(4, "0")}`, enabled: index % 5 !== 0 },
      });
      expect(response.status()).toBe(201);
    }
  }));

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const payloadSizes: number[] = [];
  cdp.on("Network.eventSourceMessageReceived", ({ eventName, data }) => {
    if (eventName === "users") payloadSizes.push(Buffer.byteLength(data));
  });
  let userRestRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/users") userRestRequests++;
  });
  await login();
  const rows = page.locator('[data-testid^="user-card-"]');
  const search = page.getByPlaceholder("Поиск по имени");
  const scroll = page.locator(".people-list-scroll");
  const all = page.getByRole("tab", { name: /^Все/ });
  await expect(all).toContainText("2001", { timeout: 20_000 });
  await page.locator(".people-sort-button").click();
  await page.getByRole("dialog").getByRole("button", { name: /Имя/ }).click();
  await expect(page.locator(".people-sort-button")).toContainText("Имя");

  const measurements: { width: number; position: number; rows: number }[] = [];
  for (const width of [1440, 768, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await search.fill("scale-");
    await expect.poll(async () => rows.count()).toBeGreaterThan(1);
    await expect.poll(() => scroll.evaluate((node) => node.scrollHeight)).toBeGreaterThan(100_000);
    for (const position of [0, 0.5, 1]) {
      await scroll.evaluate((node, fraction) => { node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction; }, position);
      await expect.poll(async () => rows.count()).toBeGreaterThan(0);
      const firstIndex = () => scroll.locator("[data-index]").first().getAttribute("data-index").then(Number);
      if (position === 0) await expect.poll(firstIndex).toBe(0);
      else await expect.poll(firstIndex).toBeGreaterThan(position === 1 ? 1900 : 700);
      const count = await rows.count();
      expect(count).toBeLessThan(40);
      measurements.push({ width, position, rows: count });
    }
    await search.fill("scale-1999");
    await expect(rows).toHaveCount(1);
    const last = page.getByTestId("user-card-scale-1999");
    await expect(last).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`people-2000-${width}.png`) });
  }

  const last = page.getByTestId("user-card-scale-1999");
  const box = await last.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".people-user-shell.is-swiped")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await last.click();
  await expect(page).toHaveURL(/\/people\/scale-1999$/);
  await expect(search).not.toBeVisible();
  await page.getByRole("link", { name: "Назад", exact: true }).click();
  await expect(search).toHaveValue("scale-1999");
  await expect(last).toBeVisible();

  await search.fill("");
  await page.getByRole("tab", { name: /^Внимание/ }).click();
  await expect(page.getByTestId("user-card-scale-0000")).toBeVisible();
  expect(await rows.count()).toBeLessThan(40);
  await all.click();
  await expect(all).toHaveAttribute("aria-selected", "true");
  expect(payloadSizes.length).toBeGreaterThan(0);
  console.log(JSON.stringify({ measurements, userEventPayloadBytes: payloadSizes, userRestRequests }));
});
