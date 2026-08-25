// Expiry conversions for the create/edit form (06-ui.md: "срок —
// datetime-local + быстрые пресеты 7д/30д/∞"). Two independent concerns
// live here:
//
// 1. Preset -> ISO instant, computed from an injectable `now` (never
//    `new Date()` directly) so tests are deterministic.
// 2. `<input type="datetime-local">`'s value (a timezone-less
//    "YYYY-MM-DDTHH:mm" string, always interpreted by the browser as local
//    time) <-> the RFC3339 UTC instant PatchUser/CreateUser actually carry.
//    Both directions go through the platform Date object's own local
//    getters/setters, so the conversion is correct under any host timezone
//    without this module ever reading or assuming one itself — see
//    expiry.test.ts's round-trip test for why that's "timezone-safe".

import { countLabel, type Dict } from "../i18n";

export type ExpiryPreset = "7d" | "30d" | "none";

const DAY_MS = 24 * 60 * 60 * 1000;

// presetToExpiration returns the RFC3339 instant `days` from `now`, or null
// for "none" (no expiration — omitted/cleared, per the three-state form).
export function presetToExpiration(preset: ExpiryPreset, now: Date): string | null {
  if (preset === "none") return null;
  const days = preset === "7d" ? 7 : 30;
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// isoToDatetimeLocalValue renders an RFC3339 instant as the local
// "YYYY-MM-DDTHH:mm" string a datetime-local input expects, using the
// Date object's local getters (getFullYear/getMonth/... — NOT the UTC
// variants) so the input shows the instant translated into the browser's
// own timezone, matching what the user would expect to see and re-submit
// unchanged. Returns "" for an unparseable input.
export function isoToDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

// datetimeLocalValueToISO parses a datetime-local input's value back into
// an RFC3339 UTC instant. `new Date("YYYY-MM-DDTHH:mm")` is specified by
// the ECMAScript Date Time String Format to be interpreted in the local
// timezone when it lacks an offset/Z suffix — exactly matching how the
// browser populated that value in the first place — so this is the mirror
// image of isoToDatetimeLocalValue, not a separate assumption. Returns null
// for an empty or unparseable value (the form's "clear" state).
export function datetimeLocalValueToISO(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// formatDurationApprox renders a non-negative millisecond duration as a
// single coarse unit (days, else hours, else minutes — labels from the
// active dictionary's people.durationUnits, pluralized per locale) — the
// detail screen's expiry countdown (06-ui.md: "живые метрики").
// Deliberately approximate (one unit, not "2d 3h 4m") since the exact
// framing ("expires in" / "expired … ago") is the caller's job via the
// dictionaries' templates.
export function formatDurationApprox(ms: number, s: Dict): string {
  const abs = Math.max(0, ms);
  const units = s.people.durationUnits;
  if (abs >= DAY_MS) return countLabel(s, Math.floor(abs / DAY_MS), units.days);
  if (abs >= HOUR_MS) return countLabel(s, Math.floor(abs / HOUR_MS), units.hours);
  return countLabel(s, Math.max(1, Math.floor(abs / MINUTE_MS)), units.minutes);
}
