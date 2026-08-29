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
test("login → people → create user → share → sub-page → overview → pulse → journal → server", async ({
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

  await test.step("Сводка renders HealthHero + default widgets, and the layout editor persists across reload", async () => {
    await page.getByRole("link", { name: "Сводка" }).click();
    await expect(page.getByRole("heading", { name: "Сводка", level: 1 })).toBeVisible();
    // The status banner carries no heading of its own any more (M5 S1:
    // one indicator, no caption over it) — the block itself is the assert.
    await expect(page.getByTestId("status-banner")).toBeVisible();
    // «Онлайн сейчас» ships in the default layout (M4 task 9): the seeded
    // user list is what it counts against.
    await expect(page.getByRole("heading", { name: "Онлайн сейчас", level: 2 })).toBeVisible();
    const statRow = page.getByRole("heading", { name: "Показатели", level: 2 });
    await expect(statRow).toBeVisible();

    // The layout editor now lives behind the «Вид» dropdown (concept §16).
    await page.getByRole("button", { name: /^Вид:/ }).click();
    await page.getByRole("button", { name: "Настроить сводку…" }).click();
    const statRowRow = page.getByRole("listitem").filter({ hasText: "Показатели" });
    await statRowRow.getByRole("checkbox").uncheck();
    await page.getByRole("button", { name: "Готово" }).click();
    await expect(statRow).not.toBeVisible();

    // A hidden widget lands in «Скрытые блоки» with a one-tap way back —
    // the prototype's footer list, not a trip through «Настроить».
    await expect(page.getByRole("heading", { name: "Скрытые блоки", level: 2 })).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("status-banner")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Показатели", level: 2 })).not.toBeVisible();
  });

  await test.step("Пульс is the diagnostics hub: card → Details → back", async () => {
    await page.getByRole("link", { name: "Пульс" }).click();
    await expect(page.getByRole("heading", { name: "Пульс", level: 1 })).toBeVisible();

    // All nine domains, each its own card — the eight of 06-ui.md plus
    // WEB (M4 task 8b).
    for (const domain of [
      "dc",
      "me",
      "security",
      "counters",
      "connections",
      "upstreams",
      "nat",
      "events",
      "web",
    ]) {
      await expect(page.getByTestId(`hub-card-${domain}`)).toBeVisible();
    }

    await page.getByTestId("hub-card-dc").click();
    await expect(page).toHaveURL(/\/pulse\/diag\/dc$/);
    await expect(page.getByRole("heading", { name: "Дата-центры", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Назад" }).click();
    await expect(page.getByRole("heading", { name: "Пульс", level: 1 })).toBeVisible();
  });

  await test.step("WEB Details: overview, sessions, a session surface and the close confirmation", async () => {
    await page.getByTestId("hub-card-web").click();
    await expect(page).toHaveURL(/\/pulse\/diag\/web$/);
    await expect(page.getByRole("heading", { name: "WEB", level: 1 })).toBeVisible();

    // The Overview reads the `web` topic: the runtime is running on the
    // mock, so the lifecycle tile says so rather than showing a gate.
    await expect(page.getByText("running").first()).toBeVisible();

    // The Sessions tab is a SECOND request (fetch-on-visit, cursor-paged).
    await page.getByRole("tab", { name: "Сессии" }).click();
    const firstRow = page.getByRole("button", { name: /^Открыть детали/ }).first();
    await expect(firstRow).toBeVisible();

    // «Загрузить ещё» is a real request: the mock seeds 24 sessions and the
    // page asks for 20, so the cursor continuation has work to do.
    const loadMore = page.getByRole("button", { name: "Загрузить ещё" });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(loadMore).toBeHidden();

    // A row opens the surface, which carries every remaining field —
    // including the opaque reference the close action addresses.
    await firstRow.click();
    const surface = page.getByRole("dialog");
    await expect(surface).toBeVisible();
    await expect(surface.getByText("session_ref")).toBeVisible();

    // The close action is behind the same confirmation step every other
    // irreversible action in the panel goes through.
    await surface.getByRole("button", { name: "Закрыть сессию" }).click();
    await expect(page.getByText(/Сессия будет закрыта немедленно/)).toBeVisible();
    // Cancelling leaves the registry alone — this flow asserts the
    // confirmation exists, not that a mock session dies.
    await page.getByRole("button", { name: "Отмена" }).click();
    await expect(page.getByText(/Сессия будет закрыта немедленно/)).toBeHidden();
    // Cancelling closes the confirmation, not the surface underneath it —
    // the reader is back where they were, still looking at the session.
    await expect(surface).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(surface).toBeHidden();

    // §15: nothing on this page may widen the document.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByRole("link", { name: "Пульс" }).click();
    await expect(page.getByRole("heading", { name: "Пульс", level: 1 })).toBeVisible();
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
