// e2e/fixtures.ts — a `login` fixture wrapping @playwright/test's own
// `test`: fills the real login form and waits for the post-login
// navigation once, so every spec that needs an authed session doesn't
// hand-roll the same three steps. Deliberately NOT a storageState-reuse
// setup (Playwright's usual "log in once in a setup project, replay the
// cookie everywhere" pattern) — this suite is small enough (two spec
// files) that the extra moving part isn't worth it, and a real login per
// test also incidentally exercises the login form itself in the mobile
// spec.
//
// The `page` fixture is also overridden to pin the UI language: the panel
// is bilingual (D3) and picks its default from the browser's Accept-
// Language, which the Playwright runner does not fix. Every selector in
// this suite matches the Russian strings, so the run seeds the same
// per-device localStorage key the language switch writes — before any
// document script runs, via addInitScript — instead of making the specs
// locale-agnostic. Testing the real, default-locale text is the point; the
// English half is covered by the dictionary tests and a component test in
// src/i18n/.
import { test as base, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./env";

export const LOCALE_STORAGE_KEY = "telemt-panel:locale:v1";

export const test = base.extend<{ login: () => Promise<void> }>({
  page: async ({ page }, use) => {
    await page.addInitScript((key: string) => {
      try {
        localStorage.setItem(key, "ru");
      } catch {
        // Storage disabled — the assertions will report the mismatch.
      }
    }, LOCALE_STORAGE_KEY);
    await use(page);
  },
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
