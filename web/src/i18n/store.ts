import { useSyncExternalStore } from "react";
import type { Dict, Locale, LocalePreference } from "./dict";
import { loadDictionary } from "./loadDictionary";
import {
  applyDocumentLocale,
  getStoredLocalePreference,
  resolveInitialLocale,
  resolvePreferredLocale,
  setStoredLocalePreference,
} from "./locale";

const dictionaries: Partial<Record<Locale, Dict>> = {};
const pendingLoads = new Map<Locale, Promise<Dict>>();
let selection = 0;

interface LocaleLoadState {
  pending: LocalePreference | null;
  error: LocalePreference | null;
}

const idle: LocaleLoadState = { pending: null, error: null };
let loadState = idle;

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
  const dictionary = dictionaries[ensure()];
  if (!dictionary) throw new Error("Locale must be initialized before rendering UI strings");
  return dictionary;
}

export function isLocaleReady(): boolean {
  return dictionaries[ensure()] !== undefined;
}

export function getLocaleLoadState(): LocaleLoadState {
  return loadState;
}

export function getLocalePreference(): LocalePreference {
  ensure();
  return preference ?? "auto";
}

function notify(): void {
  for (const listener of listeners) listener();
}

function load(locale: Locale): Promise<Dict> {
  const existing = pendingLoads.get(locale);
  if (existing) return existing;
  const pending = loadDictionary(locale).then(dictionary => {
    dictionaries[locale] = dictionary;
    return dictionary;
  }).finally(() => pendingLoads.delete(locale));
  pendingLoads.set(locale, pending);
  return pending;
}

async function selectLocale(pref: LocalePreference, persist: boolean): Promise<boolean> {
  ensure();
  const request = ++selection;
  const next = resolvePreferredLocale(pref);
  if (!dictionaries[next]) {
    loadState = { pending: pref, error: null };
    notify();
    try {
      await load(next);
    } catch {
      if (request === selection) {
        loadState = { pending: null, error: pref };
        notify();
      }
      return false;
    }
  }
  // A slow or failed earlier selection must not overwrite the latest choice.
  if (request !== selection) return false;
  if (persist) setStoredLocalePreference(pref);
  preference = pref;
  current = next;
  applyDocumentLocale(next);
  loadState = idle;
  notify();
  return true;
}

export function initializeLocale(): Promise<boolean> {
  if (isLocaleReady()) return Promise.resolve(true);
  return selectLocale(getLocalePreference(), false);
}

// Commit the preference only after loading succeeds; keep mounted UI on failure.
export function setLocalePreference(pref: LocalePreference): Promise<boolean> {
  return selectLocale(pref, true);
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
  selection++;
  current = null;
  preference = null;
  loadState = idle;
  notify();
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

export function useLocaleLoadState(): LocaleLoadState {
  return useSyncExternalStore(subscribeLocale, getLocaleLoadState, getLocaleLoadState);
}
