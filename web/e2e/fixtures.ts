// e2e/fixtures.ts — a `login` fixture wrapping @playwright/test's own
// `test`: fills the real login form and waits for the post-login
// navigation once, so every spec that needs an authed session doesn't
// hand-roll the same three steps. Deliberately NOT a storageState-reuse
// setup (Playwright's usual "log in once in a setup project, replay the
// cookie everywhere" pattern) — this suite is small enough (two spec
// files) that the extra moving part isn't worth it, and a real login per
// test also incidentally exercises the login form itself in the mobile
// spec.
import { test as base, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./env";

export const test = base.extend<{ login: () => Promise<void> }>({
  login: async ({ page }, use) => {
    await use(async () => {
      await page.goto("/login");
      await page.getByLabel("Имя пользователя").fill(ADMIN_USERNAME);
      await page.getByLabel("Пароль").fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Войти" }).click();
      await expect(page).toHaveURL(/\/people$/);
    });
  },
});

export { expect };
