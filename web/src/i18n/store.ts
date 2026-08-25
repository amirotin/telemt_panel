import { useSyncExternalStore } from "react";
import type { Dict, Locale, LocalePreference } from "./dict";
import { en } from "./en";
import { ru } from "./ru";
import {
  applyDocumentLocale,
  getStoredLocalePreference,
  resolveInitialLocale,
  setStoredLocalePreference,
} from "./locale";

const DICTS: Record<Locale, Dict> = { ru, en };

// Resolved lazily on first read rather than at module-evaluation time so a
// test can seed localStorage (or call setLocalePreference) before the first
// string is ever pulled, and so importing the dictionary from a helper
// never touches document/navigator as an import side effect.
let current: Locale | null = null;
let preference: LocalePreference | null = null;

const listeners = new Set<() => void>();

function ensure(): Locale {
  if (current === null) {
    preference = getStoredLocalePreference();
    current = resolveInitialLocale();
    applyDocumentLocale(current);
  }
  return current;
}

export function getLocale(): Locale {
  return ensure();
}

// getStrings is the store getter non-component code reads through. It
// returns a stable object identity per locale, which is also what makes it
// a valid useSyncExternalStore snapshot.
export function getStrings(): Dict {
  return DICTS[ensure()];
}

export function getLocalePreference(): LocalePreference {
  ensure();
  return preference ?? "auto";
}

// setLocalePreference persists the choice per device and notifies every
// subscriber — "auto" re-resolves against the browser languages.
export function setLocalePreference(pref: LocalePreference): void {
  ensure();
  setStoredLocalePreference(pref);
  preference = pref;
  const next = resolveInitialLocale();
  if (next !== current) {
    current = next;
    applyDocumentLocale(next);
  }
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// resetLocaleForTests drops the memoized resolution so a test can change
// the stored preference / navigator languages and observe a fresh resolve.
export function resetLocaleForTests(): void {
  current = null;
  preference = null;
  for (const listener of listeners) listener();
}

// useStrings is THE hook every component reads UI text through:
// `const s = useStrings()` then `s.people.actions.share`. Backed by
// useSyncExternalStore, so switching the language in Настройки панели
// re-renders every mounted screen without a reload or a remount.
export function useStrings(): Dict {
  return useSyncExternalStore(subscribeLocale, getStrings, getStrings);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export function useLocalePreference(): LocalePreference {
  return useSyncExternalStore(subscribeLocale, getLocalePreference, getLocalePreference);
}
