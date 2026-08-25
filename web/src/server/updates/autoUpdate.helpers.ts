import type { AutoUpdateSettings } from "../../lib/api/generated/types.gen";

export type AutoUpdateMode = AutoUpdateSettings["telemt"];

export interface AutoUpdateFormState {
  telemt: AutoUpdateMode;
  panel: AutoUpdateMode;
  intervalHours: number;
}

export const DEFAULT_INTERVAL_HOURS = 6;

// parseIntervalHours reads AutoUpdateSettings.interval — a Go duration
// string, documented ">= 1h" (openapi) — into whole hours for the form's
// numeric input. internal/update.GetAutoSettings always writes a plain
// "<n>h" string (SetAutoSettings' own validation), so that's the only
// shape this needs to round-trip; anything else (a value from a future
// backend that started allowing sub-hour units, or garbage) falls back to
// a safe default rather than crashing the settings form.
export function parseIntervalHours(interval: string, fallbackHours = DEFAULT_INTERVAL_HOURS): number {
  const m = /^(\d+)h$/.exec(interval.trim());
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
