// The i18n barrel: components import { useStrings } from "@/i18n", helpers
// take a `Dict` parameter (or read getStrings() when they have no component
// to thread it from). ru.ts stays the source of truth for the dictionary
// SHAPE; en.ts is typed against it.
export type { Dict, Locale, LocalePreference } from "./dict";
export {
  applyDocumentLocale,
} from "./locale";
export type { PluralForms } from "./plural";
export {
  countLabel,
  fill,
  formatNumber,
  localeOf,
  pluralTemplate,
} from "./plural";
export {
  getLocale,
  getStrings,
  resetLocaleForTests,
  setLocalePreference,
  useLocale,
  useLocalePreference,
  useStrings,
} from "./store";
export { auditActionLabel, errorMessage } from "./messages";
