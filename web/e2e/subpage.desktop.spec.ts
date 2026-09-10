import { test, expect } from "./fixtures";
import { SEEDED_USER } from "./env";

test("subscription link opens anonymously, copies on HTTP and is revoked after regeneration", async ({ page, browser, login }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Use the real UI flow, not a fabricated token or intercepted API response.
  await login();
  await page.getByTestId(`user-card-${SEEDED_USER}`).click();
  await page.getByRole("tab", { name: "Доступ" }).click();
  const field = page.getByTestId("sublink-value");
  await expect(field).toBeVisible();
  const before = (await field.textContent())!.trim();
  expect(new URL(before).pathname).toMatch(/^\/sub\/[a-z2-7]{32}$/);

  const anon = await browser.newContext({
    locale: "ru-RU", viewport: { width: 390, height: 844 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  try {
    const publicPage = await anon.newPage();
    const errors: string[] = [];
    publicPage.on("pageerror", error => errors.push(error.message));
    const response = await publicPage.goto(before);
    expect(new URL(before).port).not.toBe(new URL(page.url()).port);
    for (const path of ["/api/health", "/api/users", "/login"]) {
      expect((await anon.request.get(new URL(path, before).href)).status()).toBe(404);
    }
    expect(response!.status()).toBe(200);
    expect(response!.headers()["cache-control"]).toBe("private, no-store");
    expect(response!.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(publicPage.getByRole("heading", { level: 1 })).toContainText(SEEDED_USER);
    expect(await anon.cookies()).toEqual([]);
    for (const width of [360, 390, 768, 1440]) {
      await publicPage.setViewportSize({ width, height: 900 });
      expect(await publicPage.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    }
    await publicPage.setViewportSize({ width: 390, height: 844 });
    const tg = new URL((await publicPage.locator(".btn-primary").first().getAttribute("href"))!);
    const tme = new URL((await publicPage.locator(".btn-secondary").first().getAttribute("href"))!);
    expect(tg.protocol).toBe("tg:");
    expect(tme.origin + tme.pathname).toBe("https://t.me/proxy");
    expect(tme.search).toBe(tg.search);
    await expect.poll(() => publicPage.locator("img.qr").first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(256);

    await publicPage.locator("details.manual summary").first().click();
    const copy = publicPage.locator("[data-copy]");
    await copy.nth(0).click();
    await expect(copy.nth(0)).toHaveText("Скопировано");
    expect(await publicPage.evaluate(() => navigator.clipboard.readText())).toBe(tg.searchParams.get("server"));

    // Emulate an insecure HTTP origin: Clipboard API is absent.
    await publicPage.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
    await copy.nth(1).click();
    await expect(copy.nth(1)).toHaveText("Скопировано");
    // Both automatic paths may fail; leave selected text and honest feedback.
    await publicPage.evaluate(() => { document.execCommand = () => false; });
    await copy.nth(2).click();
    await expect(publicPage.getByRole("status")).toContainText("скопируйте его вручную");
    expect(await publicPage.evaluate(() => window.getSelection()?.toString())).toBe(tg.searchParams.get("secret"));
    expect(errors).toEqual([]);

    await page.getByRole("button", { name: "Перевыпустить ссылку", exact: true }).click();
    await page.getByRole("button", { name: "Перевыпустить ссылку", exact: true }).click();
    await expect(field).not.toHaveText(before);
    const after = (await field.textContent())!.trim();
    expect((await publicPage.goto(before))!.status()).toBe(404);
    expect((await publicPage.goto(after))!.status()).toBe(200);
    await expect(publicPage.getByRole("heading", { level: 1 })).toContainText(SEEDED_USER);
  } finally {
    await anon.close();
  }
});

test("subscription access form accepts a full external URL and prepares its independent path", async ({ page, login }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login();
  await page.goto("/server/settings");
  const card = page.getByTestId("subscription-transport");
  await card.getByRole("button", { name: "Настроить", exact: true }).click();
  const form = page.getByRole("dialog");
  await expect(form.getByLabel("Включить страницу подписки")).toBeChecked();
  await form.getByLabel("Внешний адрес").fill("https://links.example.com/private-clients/");
  await form.getByLabel("Префикс пути", { exact: true }).focus();
  await expect(form.getByLabel("Префикс пути", { exact: true })).toHaveValue("/private-clients");
  await form.getByRole("radio", { name: /HTTPS через reverse proxy/ }).check();
  const prepared = page.waitForResponse(response => response.url().includes("/api/settings/tls/prepare?target=subscription"));
  await form.getByRole("button", { name: "Проверить настройки", exact: true }).click();
  const response = await prepared;
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.candidate.base_path).toBe("/private-clients");
  expect(body.candidate.public_url).toBe("https://links.example.com");
  expect(body.new_url).toBe("https://links.example.com/private-clients/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  // Do not save: the suite shares its live stack with other specs.
});
