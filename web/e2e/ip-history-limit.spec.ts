import { expect, test } from "./fixtures";
import { BASE_URL, SEEDED_USER } from "./env";

test("IP history supports unlimited mode and confirms a lower cap", async ({ page, login }) => {
  await login();
  const original = await page.request.get("/api/settings/storage");
  expect(original.ok()).toBeTruthy();
  const baseline = await original.json();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const effectiveLimit = async () => {
    const response = await page.request.get(`/api/users/${SEEDED_USER}/ip-history`);
    expect(response.ok()).toBeTruthy();
    return (await response.json()).max_ips_per_user;
  };
  try {
    await page.goto("/server/settings");
    const storage = page.getByTestId("settings-storage");
    const field = storage.getByRole("spinbutton", { name: "Адресов на пользователя", exact: true });
    const unlimited = storage.getByRole("switch", { name: "Без лимита на пользователя", exact: true });
    await expect(field).toHaveValue("256");
    await unlimited.click();
    await expect(field).toBeDisabled();
    const save = storage.getByRole("button", { name: "Сохранить", exact: true }).first();
    await save.click();
    await expect.poll(effectiveLimit).toBe(0);
    await expect(save).toBeDisabled();

    await page.reload();
    await expect(unlimited).toBeChecked();
    await expect(storage).toContainText("20 000");
    await expect(storage).toContainText("100 000");
    await unlimited.click();
    await field.fill("512");
    await save.click();
    const confirmation = page.getByRole("dialog", { name: "Сократить историю?" });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText("512");
    expect(await effectiveLimit()).toBe(0);
    await confirmation.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect.poll(effectiveLimit).toBe(512);
    await expect(confirmation).not.toBeVisible();
    await page.reload();
    await expect(field).toHaveValue("512");
    await expect(unlimited).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    const response = await page.request.put("/api/settings/storage", {
      headers: { Origin: BASE_URL },
      data: { policies: baseline.policies, confirm_retention_reduction: true },
    });
    expect(response.ok()).toBeTruthy();
  }
});
