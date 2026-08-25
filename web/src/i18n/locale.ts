import type { Locale, LocalePreference } from "./dict";

// Versioned exactly like display-mode's and the dashboard layout's keys so
// a future change to the locale set can invalidate old stored values
// instead of silently misinterpreting them.
const STORAGE_KEY = "telemt-panel:locale:v1";

// Fallback when nothing is stored and the browser asks for a language the
// panel doesn't ship (06-ui.md: "дефолт — по языку браузера, fallback en").
const FALLBACK_LOCALE: Locale = "en";

export const LOCALES: readonly Locale[] = ["ru", "en"];

export function isLocale(value: unknown): value is Locale {
  return value === "ru" || value === "en";
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "auto" || isLocale(value);
}

export function getStoredLocalePreference(): LocalePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isLocalePreference(raw)) return raw;
  } catch {
    // localStorage unavailable (private mode, disabled storage) — fall
    // back to the default rather than throwing during app init.
  }
  return "auto";
}

export function setStoredLocalePreference(pref: LocalePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Best-effort — see getStoredLocalePreference.
  }
}

// localeFromLanguages picks the first browser language tag whose primary
// subtag is one the panel ships ("ru-RU" → ru, "en-GB" → en); anything
// else falls through to FALLBACK_LOCALE.
export function localeFromLanguages(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return FALLBACK_LOCALE;
}

// resolveLocale is the whole resolution order in one pure function so the
// matrix (stored beats navigator; ru-RU → ru; de → en) is testable without
// touching globals: stored preference → navigator languages → "en".
export function resolveLocale(pref: LocalePreference, languages: readonly string[]): Locale {
  if (isLocale(pref)) return pref;
  return localeFromLanguages(languages);
}

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  const list = navigator.languages;
  if (Array.isArray(list) && list.length > 0) return list;
  return navigator.language ? [navigator.language] : [];
}

export function resolveInitialLocale(): Locale {
  return resolveLocale(getStoredLocalePreference(), navigatorLanguages());
}

// applyDocumentLocale keeps <html lang> in sync with the active language —
// screen readers pick their voice from it and the browser keys hyphenation
// and spellcheck off it, so a bilingual UI that never updates it reads
// every English screen with a Russian voice.
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}
