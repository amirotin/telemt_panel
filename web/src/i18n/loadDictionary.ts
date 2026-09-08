import type { Dict, Locale } from "./dict";
import { localeURLs } from "virtual:locale-urls";

const failures: Partial<Record<Locale, number>> = {};

export async function loadDictionary(locale: Locale): Promise<Dict> {
  const attempt = failures[locale] ?? 0;
  const url = localeURLs[locale] + (attempt ? `?retry=${attempt}` : "");
  try {
    const module = await import(/* @vite-ignore */ url) as Partial<Record<Locale, Dict>>;
    const dictionary = module[locale];
    if (!dictionary || dictionary.locale !== locale) throw new Error("Invalid locale dictionary");
    return dictionary;
  } catch (error) {
    // Browsers cache failed module fetches. Change only this build-owned URL.
    failures[locale] = attempt + 1;
    throw error;
  }
}
