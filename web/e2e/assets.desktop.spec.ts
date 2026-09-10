import { expect, test } from "./fixtures";

test("production HTML avoids initial module preloads and supports mobile standalone mode", async ({ page }) => {
  const response = await page.goto("/login");
  const html = await response!.text();
  expect(html).not.toMatch(/<link\b[^>]*rel=["']modulepreload["']/i);
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.getByLabel("Имя пользователя")).toBeVisible();
  await expect(page.getByText("Управление MTProxy", { exact: true })).toHaveCount(0);
  const logo = page.locator('img[src*="logo-login-"]');
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test("provided menu logo loads in full sidebar and tablet rail", async ({ page, login }) => {
  await login();
  for (const [width, testId] of [[1280, "full-sidebar"], [768, "navigation-rail"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    const logo = page.getByTestId(testId).locator('img[src*="logo-menu-"]');
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
});

test("people loads within the script request budget after a full navigation", async ({ page, login }) => {
  await login();
  const scripts: string[] = [];
  let compressedBytes = 0;
  page.on("request", request => {
    if (request.resourceType() === "script" && new URL(request.url()).pathname.includes("/assets/")) {
      scripts.push(request.url());
    }
  });
  page.on("response", response => {
    if (response.request().resourceType() === "script" && new URL(response.url()).pathname.includes("/assets/")) {
      compressedBytes += Number(response.headers()["content-length"] ?? 0);
    }
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Создать", exact: true })).toBeVisible();
  // Includes cached requests: catching excessive fragmentation, not measuring bandwidth.
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.length).toBeLessThanOrEqual(32);
  expect(new Set(scripts).size).toBe(scripts.length);
  // A single eager bundle must not pass the request budget by loading every page.
  expect(compressedBytes).toBeGreaterThan(0);
  expect(compressedBytes).toBeLessThanOrEqual(350_000);
});

test("service-worker reload keeps the interface usable without preload warnings", async ({ page, context, login }) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Log.enable");
  cdp.on("Log.entryAdded", ({ entry }: { entry: { text: string } }) => {
    if (/preload|mobile-web-app-capable/i.test(entry.text)) warnings.push(entry.text);
  });
  await login();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload({ waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  // Chrome reports unused preloads asynchronously after load.
  await page.waitForTimeout(15_000);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
});
