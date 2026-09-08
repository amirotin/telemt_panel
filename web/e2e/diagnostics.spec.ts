import { expect, test } from "./fixtures";

const DIAGNOSTICS = [
  ["connections", "Соединения", "connections-chart"],
  ["counters", "Счётчики", "counters-hero"],
  ["dc", "Дата-центры", "dc-selected-pair"],
  ["events", "События", "events-timeline"],
  ["me", "Middle End", "me-overview"],
  ["nat", "NAT/STUN", "nat-overview"],
  ["security", "Безопасность / TLS", "security-posture-panel"],
  ["upstreams", "Апстримы", "upstreams-selection"],
  ["web", "WEB", "web-overview"],
] as const;

async function expectViewportContainment(page: import("@playwright/test").Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1);
}

async function expectDialogContainment(
  page: import("@playwright/test").Page,
  dialog: import("@playwright/test").Locator,
) {
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize();
      if (!box || !viewport) return Number.POSITIVE_INFINITY;
      return Math.max(
        0,
        -box.x,
        -box.y,
        box.x + box.width - viewport.width,
        box.y + box.height - viewport.height,
      );
    })
    .toBeLessThanOrEqual(1);
}

test("all nine live diagnostics stay inside the phone or desktop viewport", async ({
  page,
  login,
}) => {
  await login();
  for (const [domain, heading, readyTestId] of DIAGNOSTICS) {
    await page.goto(`/pulse/diag/${domain}`);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    // Each marker is inside a source-backed branch, never the loading shell.
    await expect(page.getByTestId(readyTestId)).toBeVisible();
    await expectViewportContainment(page);
  }
});

test("the live WEB surface supports keyboard and visible close with focus return", async ({
  page,
  login,
}, testInfo) => {
  await login();
  await page.goto("/pulse/diag/web");
  await page.getByRole("tab", { name: "Сессии" }).click();

  const row = page.getByRole("button", { name: /^Открыть детали/ }).first();
  await expect(row).toBeVisible();
  const sessionRef = await row.evaluate((element) =>
    element.closest("[data-web-session]")?.getAttribute("data-web-session"),
  );
  expect(sessionRef).toBeTruthy();
  if (!sessionRef) throw new Error("WEB session row has no stable session_ref");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toBeFocused();

  await row.click();
  const dialog = page.getByRole("dialog");
  const identity = dialog.getByTestId("web-session-details").getByText(sessionRef, { exact: true });
  await expect(dialog).toBeVisible();
  await expect(identity).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();

  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 390, height: 844 });
    await row.click();
    await expect(dialog).toBeVisible();
    await expect(identity).toBeVisible();
    await expectDialogContainment(page, dialog);

    await page.setViewportSize({ width: 844, height: 390 });
    await expect(dialog).toBeVisible();
    await expect(identity).toBeVisible();
    await expectDialogContainment(page, dialog);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await expect(identity).toBeVisible();
    await expectDialogContainment(page, dialog);

    await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeFocused();
  }
});
