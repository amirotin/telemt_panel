import type { AutoUpdateSettings } from "../../lib/api/generated/types.gen";

export type AutoUpdateMode = AutoUpdateSettings["telemt"];

export interface AutoUpdateFormState {
  telemt: AutoUpdateMode;
  panel: AutoUpdateMode;
  intervalHours: number;
}

export const DEFAULT_INTERVAL_HOURS = 6;

// parseIntervalHours reads AutoUpdateSettings.interval into whole hours for
// the form's numeric input. This PUTs a bare "<n>h" string, but Go's
// time.Duration.String() — what internal/httpapi's handleGetAutoUpdate
// actually formats the stored value with — always appends zero minute/
// second components for a whole-hour duration (confirmed live: a fresh
// install's 6h default GETs back as "6h0m0s", never "6h"), so the leading-
// hour match is deliberately NOT anchored at the string's end. Any
// trailing sub-hour remainder is truncated (this form has no sub-hour
// input — a value set to e.g. "1h30m" through some other path displays as
// 1h here); anything with no leading hour count at all (garbage, or a
// pure "30m" duration below this form's 1h floor) falls back to a safe
// default rather than crashing the settings form.
export function parseIntervalHours(interval: string, fallbackHours = DEFAULT_INTERVAL_HOURS): number {
  const m = /^(\d+)h/.exec(interval.trim());
  if (!m) return fallbackHours;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : fallbackHours;
}

export function formatIntervalHours(hours: number): string {
  return `${Math.max(1, Math.round(hours))}h`;
}

export function toAutoUpdateFormState(settings: AutoUpdateSettings): AutoUpdateFormState {
  return { telemt: settings.telemt, panel: settings.panel, intervalHours: parseIntervalHours(settings.interval) };
}

export function serializeAutoUpdateForm(form: AutoUpdateFormState): AutoUpdateSettings {
  return { telemt: form.telemt, panel: form.panel, interval: formatIntervalHours(form.intervalHours) };
}
