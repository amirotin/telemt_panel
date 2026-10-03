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
// Language, which the Playwright runner does not fix. Tests default to
// Russian; bilingual suites can override uiLocale. The run seeds the same
// per-device localStorage key the language switch writes — before any
// document script runs, via addInitScript — instead of making the specs
// locale-agnostic or installing competing initialization scripts.
import { test as base, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./env";
import type {Page} from "@playwright/test";

export const LOCALE_STORAGE_KEY = "telemt-panel:locale:v1";

export const test = base.extend<{ login: () => Promise<void>; uiLocale: "ru" | "en" }>({
  uiLocale: ["ru", { option: true }],
  page: async ({ page, uiLocale }, use) => {
    await page.addInitScript(({ key, locale }) => {
      try {
        localStorage.setItem(key, locale);
      } catch {
        // Storage disabled — the assertions will report the mismatch.
      }
    }, { key: LOCALE_STORAGE_KEY, locale: uiLocale });
    await use(page);
  },
  login: async ({ page, uiLocale }, use) => {
    await use(async () => {
      await page.goto("/login");
      await page.getByLabel(uiLocale === "ru" ? "Имя пользователя" : "Username").fill(ADMIN_USERNAME);
      await page.getByLabel(uiLocale === "ru" ? "Пароль" : "Password").fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: uiLocale === "ru" ? "Войти" : "Sign in", exact: true }).click();
      await expect(page).toHaveURL(/\/people$/);
    });
  },
});

export { expect };

export async function openUsersSearch(page:Page) {
  const opener=page.getByRole("button",{name:"Открыть поиск",exact:true});
  const input=page.getByPlaceholder("Поиск по имени");
  await expect(input.or(opener)).toBeVisible();
  if(await opener.isVisible())await opener.click();
  await expect(input).toBeVisible();
  return input;
}
