import { test, expect, openUsersSearch } from "./fixtures";
import { SEEDED_USER } from "./env";

test.use({ timezoneId: "Europe/Moscow" });

test("expiry calendar, card and subscription share the UTC day in Moscow", async ({ page, login, browser }) => {
  await login();
  await page.clock.install({ time: new Date("2026-11-01T12:00:00Z") });
  const username = SEEDED_USER;
  const headers = { "Sec-Fetch-Site": "same-origin" };
  const originalResponse = await page.request.get(`/api/users/${username}`);
  expect(originalResponse.ok()).toBeTruthy();
  const original = await originalResponse.json();
  // Newly created mock users intentionally have no connection links; use
  // the seeded account so its real subscription can verify the same date.
  const prepared = await page.request.patch(`/api/users/${username}`, {
    headers,
    data: {
      expiration_rfc3339: "2026-12-01T01:30:00+03:00",
    },
  });
  expect(prepared.ok()).toBeTruthy();
  try {
    await page.goto(`/people/${username}?tab=settings`);
    const expiry = page.getByLabel("Истекает (UTC)", { exact: true });
    await expect(expiry).toHaveValue("2026-11-30");
    await expiry.fill("2026-11-29");
    await expiry.fill("2026-11-30");
    const saved = page.waitForRequest(request => request.method() === "PATCH" && new URL(request.url()).pathname === `/api/users/${username}`);
    await page.getByTestId("user-form-submit").click();
    expect((await saved).postDataJSON()).toEqual({ expiration_rfc3339: "2026-11-30T23:59:59.000Z" });
    await expect(page.getByRole("button", { name: "Обзор", exact: true })).toHaveAttribute("aria-current", "page");
    await page.goto("/people");
    await (await openUsersSearch(page)).fill(username);
    const row = page.locator(`[data-user="${username}"]`);
    await expect(row.locator(".user-expiry")).toHaveText("До 30.11 UTC");
    await expect(row.locator(".user-expiry")).toHaveAttribute("title", /30\.11\.2026.*23:59:59.*UTC/);
    await page.getByTestId(`user-card-${username}`).click();
    await page.getByRole("button", { name: "Доступ", exact: true }).click();
    const sublink = page.getByTestId("sublink-value");
    await expect(sublink).toBeVisible();
    const anonymous = await browser.newContext({ timezoneId: "Europe/Moscow", locale: "ru-RU" });
    try {
      const subscription = await anonymous.newPage();
      expect((await subscription.goto((await sublink.textContent())!.trim()))!.status()).toBe(200);
      await expect(subscription.locator("body")).toContainText("2026-11-30 23:59 UTC");
    } finally {
      await anonymous.close();
    }
  } finally {
    await page.request.patch(`/api/users/${username}`, { headers, data: { expiration_rfc3339: original.expiration_rfc3339 ?? null } });
  }
});
