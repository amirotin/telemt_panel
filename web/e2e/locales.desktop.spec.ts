import { expect, test } from "./fixtures";

test.use({ serviceWorkers: "block" });

test("an English browser starts with only the English dictionary", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, locale: "en-US", serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    const dictionaries: string[] = [];
    page.on("request", request => {
      const name = new URL(request.url()).pathname.split("/").pop() ?? "";
      if (/^(ru|en)-.*\.js$/.test(name)) dictionaries.push(name.slice(0, 2));
    });
    await page.goto("/login");
    await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(dictionaries).toEqual(["en"]);
  } finally {
    await context.close();
  }
});

test("cold login loads only the requested dictionary", async ({ page }) => {
  const dictionaries: string[] = [];
  page.on("request", request => {
    const name = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (/^(ru|en)-.*\.js$/.test(name)) dictionaries.push(name.slice(0, 2));
  });
  await page.goto("/login");
  await expect(page.getByLabel("Имя пользователя")).toBeVisible();
  expect(dictionaries).toEqual(["ru"]);
});

test("a delayed language change preserves an unsaved form and commits atomically", async ({ page, login }) => {
  await login();
  await page.goto("/server/settings");
  await page.locator('#geoip input[value="files"]').check();
  const draft = page.locator('#geoip input[type="text"]').first();
  await draft.fill("/srv/geoip/unsaved.mmdb");
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route(/\/en-[^/]+\.js$/, async route => {
    requested = true;
    await waiting;
    await route.continue();
  });
  const controls = page.getByTestId("settings-interface");
  try {
    await controls.getByRole("radio", { name: "English", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await expect(controls).toContainText("Загрузка языка");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(controls.getByRole("radio", { name: "Русский", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(draft).toHaveValue("/srv/geoip/unsaved.mmdb");
  } finally {
    release();
  }
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(draft).toHaveValue("/srv/geoip/unsaved.mmdb");
  await expect(controls.getByRole("radio", { name: "English", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("a failed language download can be retried without reloading the form", async ({ page, login }) => {
  await login();
  await page.goto("/server/settings");
  await page.locator('#geoip input[value="files"]').check();
  const draft = page.locator('#geoip input[type="text"]').first();
  await draft.fill("/srv/geoip/unsaved.mmdb");
  let fail = true;
  await page.route(/\/en-[^/]+\.js(?:\?.*)?$/, route => fail ? route.abort("failed") : route.continue());
  const controls = page.getByTestId("settings-interface");
  await controls.getByRole("radio", { name: "English", exact: true }).click();
  await expect(controls.getByRole("alert")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  fail = false;
  await controls.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(controls.getByRole("alert")).not.toBeVisible();
  await expect(draft).toHaveValue("/srv/geoip/unsaved.mmdb");
  const downloads: string[] = [];
  page.on("request", request => {
    if (/\/(ru|en)-[^/]+\.js/.test(request.url())) downloads.push(request.url());
  });
  await controls.getByRole("radio", { name: "Русский", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await controls.getByRole("radio", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(downloads).toEqual([]);
});

test("initial dictionary failure offers recovery instead of a blank screen", async ({ page }) => {
  let fail = true;
  await page.route(/\/ru-[^/]+\.js(?:\?.*)?$/, route => fail ? route.abort("failed") : route.continue());
  await page.goto("/login");
  await expect(page.getByRole("alert")).toContainText("Не удалось загрузить язык");
  fail = false;
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByLabel("Имя пользователя")).toBeVisible();
});
