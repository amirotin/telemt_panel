import { expect, test } from "./fixtures";
import { SEEDED_USER } from "./env";

// mobile.spec.ts — 360×640, the plan's primary e2e target
// (v2/plans/2026-08-25-m3-frontend.md Task 9 / R4): one sequential flow
// through the app's real happy path against the built panel binary +
// cmd/telemt-mock (e2e/stack.ts). Steps are ordered and share state (the
// same panel process, same test — see playwright.config.ts's
// `fullyParallel: false`/`workers: 1`), so this is one `test()` with
// `test.step()`s rather than several independent tests: "the Journal shows
// the user-creation event" only makes sense after "create a user" already
// ran in this same run.
test("login → people → create user → share → sub-page → pulse → journal → server", async ({
  page,
  context,
  login,
}) => {
  const newUsername = `e2e${Date.now()}`;

  await test.step("login lands on /people", async () => {
    await login();
    await expect(page.getByRole("heading", { name: "Люди" })).toBeVisible();
  });

  await test.step("create a user via the Sheet form", async () => {
    await page.getByRole("button", { name: "Создать", exact: true }).click();
    await page.getByTestId("user-form-username").fill(newUsername);
    await page.getByTestId("user-form-submit").click();
    await expect(page.getByText("Пользователь создан")).toBeVisible();
  });

  await test.step("the new user appears in the list without a manual reload", async () => {
    // Bounded well under the hub's slower fallback-poll interval — proves
    // the SSE push (hub.Poke after a user mutation, see task-5-report.md's
    // mini-task 2b) delivered the update, not a fallback poll timing out
    // into visibility.
    await expect(page.getByTestId(`user-card-${newUsername}`)).toBeVisible({ timeout: 8_000 });
  });

  let sublinkUrl = "";

  await test.step("share the seeded user's sub-link", async () => {
    // The freshly-created user above has no proxy links yet (telemt-mock's
    // CreateUser fixture always returns empty Links — see env.ts's
    // SEEDED_USER comment), so the share/sub-page flow uses "alice", the
    // fixture user telemttest seeds with a real classic link.
    await page.getByTestId(`user-card-actions-${SEEDED_USER}`).click();
    await page.getByRole("button", { name: "Поделиться доступом" }).click();
    const sublinkValue = page.getByTestId("sublink-value");
    await expect(sublinkValue).toBeVisible();
    sublinkUrl = (await sublinkValue.textContent())?.trim() ?? "";
    expect(sublinkUrl).toMatch(/^https?:\/\//);
  });

  await test.step("the sub-page renders the user's status/links, unauthenticated", async () => {
    const anonContext = await context.browser()!.newContext();
    const anonPage = await anonContext.newPage();
    await anonPage.goto(sublinkUrl);
    await expect(anonPage.getByRole("heading", { name: SEEDED_USER, level: 1 })).toBeVisible();
    await expect(anonPage.locator(".status")).toBeVisible();
    await anonContext.close();

    // Close the still-open action sheet (Sheet.tsx's own "Закрыть" button)
    // before navigating elsewhere on the main page — its backdrop is
    // `fixed inset-0` and intercepts clicks on the tab bar underneath it
    // until dismissed.
    await page.getByRole("button", { name: "Закрыть" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  await test.step("Пульс renders HealthHero + default widgets, and the layout editor persists across reload", async () => {
    await page.getByRole("link", { name: "Пульс" }).click();
    await expect(page.getByRole("heading", { name: "Статус", level: 3 })).toBeVisible();
    const statRow = page.getByRole("heading", { name: "Показатели", level: 3 });
    await expect(statRow).toBeVisible();

    await page.getByRole("button", { name: "Настроить" }).click();
    const statRowRow = page.getByRole("listitem").filter({ hasText: "Показатели" });
    await statRowRow.getByRole("checkbox").uncheck();
    await page.getByRole("button", { name: "Готово" }).click();
    await expect(statRow).not.toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "Статус", level: 3 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Показатели", level: 3 })).not.toBeVisible();
  });

  await test.step("Журнал → События shows the user-creation entry", async () => {
    await page.getByRole("link", { name: "Журнал" }).click();
    await page.getByRole("tab", { name: "События" }).click();
    await expect(page.getByText(`Создан пользователь — ${newUsername}`)).toBeVisible();
  });

  await test.step("Сервер → Платформа shows the capability matrix", async () => {
    await page.getByRole("link", { name: "Сервер" }).click();
    await page.getByRole("link", { name: "Платформа" }).click();
    await expect(page.getByRole("heading", { name: "Возможности" })).toBeVisible();
  });
});
