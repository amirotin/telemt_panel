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

test("people loads within the script request budget after a full navigation", async ({ page, context, login }, testInfo) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  const cpuThrottlingRate = Number(process.env["TELEMT_PANEL_ASSET_CPU"] ?? 1);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottlingRate });
  const trace: Array<Record<string, unknown>> = [];
  cdp.on("Network.requestWillBeSent", event => {
    if (event.type === "Document" || event.type === "Script") {
      trace.push({ event: "request", requestId: event.requestId, loaderId: event.loaderId, type: event.type, url: event.request.url, timestamp: event.timestamp });
    }
  });
  cdp.on("Network.responseReceived", event => {
    if (event.type === "Document" || event.type === "Script") {
      trace.push({ event: "response", requestId: event.requestId, loaderId: event.loaderId, type: event.type, url: event.response.url, status: event.response.status, fromDiskCache: event.response.fromDiskCache ?? false, fromServiceWorker: event.response.fromServiceWorker ?? false, contentLength: Object.entries(event.response.headers).find(([name]) => name.toLowerCase() === "content-length")?.[1], encodedDataLength: event.response.encodedDataLength });
    }
  });
  cdp.on("Network.loadingFinished", event => trace.push({ event: "finished", requestId: event.requestId, encodedDataLength: event.encodedDataLength }));
  cdp.on("Page.frameNavigated", event => trace.push({ event: "navigation", frameId: event.frame.id, loaderId: event.frame.loaderId, url: event.frame.url }));
  await login();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Создать", exact: true })).toBeVisible();
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const loadedScripts = trace.filter(event => event["loaderId"] === frameTree.frame.loaderId && event["type"] === "Script" && typeof event["url"] === "string" && new URL(event["url"]).pathname.includes("/assets/"));
  const scripts = loadedScripts.filter(event => event["event"] === "request").map(event => String(event["url"]));
  const compressedBytes = loadedScripts.filter(event => event["event"] === "response").reduce((total, event) => total + Number(event["contentLength"] ?? 0), 0);
  await testInfo.attach("asset-document-trace", { body: JSON.stringify({ profile: { cpuThrottlingRate, network: "Playwright default; no emulated network throttling", serviceWorkers: "allowed", viewport: page.viewportSize() }, loadedDocument: frameTree.frame, measured: { scripts, compressedBytes }, trace }, null, 2), contentType: "application/json" });
  // Include cached requests, but only for the reloaded document. Login's in-flight
  // lazy imports can finish after reload and belong to a different loader.
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
  await expect(page.getByTestId("user-form-submit")).toBeVisible();
  await page.getByRole("link", { name: /К списку пользователей/ }).click();
  await expect(page.getByTestId("user-form-submit")).not.toBeVisible();
  // Chrome reports unused preloads asynchronously after load.
  await page.waitForTimeout(15_000);
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
});
