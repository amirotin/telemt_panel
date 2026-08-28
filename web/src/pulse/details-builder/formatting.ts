// Value formatting for the Details-page builder (spec §13, §13.1).
//
// One registry, one entry point (`formatValue`), and every rule the spec
// makes normative about absence lives here rather than in a renderer:
//
//   * `false` and `0` are REAL VALUES (§13.1) — they render as "нет" and
//     "0", never as an em dash, and they carry a `falsy` flag so a renderer
//     can style them without having to re-derive what they were;
//   * `null` follows `nullMeaning` when the catalog knows one, otherwise it
//     is an em dash tagged `absence: "null"`;
//   * a field that never arrived is `absence: "missing"` with its OWN text,
//     because §13.1 requires "absent optional field" to differ visibly from
//     "collected empty value";
//   * `unsupported` (this Telemt build has no such field) and `unavailable`
//     (the feature is off / the source did not answer) are separate absences
//     — the same R5 split TlsSourceNotice already makes at the source level.
//
// Nothing here re-implements a formatter the app already has: bytes come
// from lib/format.ts, coarse durations from people/expiry.ts, digit
// grouping from i18n/plural.ts.

import type { Dict } from "../../i18n";
import { fill, formatNumber, localeOf } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { formatDurationApprox } from "../../people/expiry";
import type { FieldUnit } from "./model";

/** The formatter families spec §13 makes mandatory. */
export type FormatterName =
  | "text"
  | "integer"
  | "decimal"
  | "percent"
  | "milliseconds"
  | "seconds"
  | "duration"
  | "bytes"
  | "rate"
  | "timestamp"
  | "relativeAge"
  | "boolean"
  | "enum"
  | "address"
  | "identifier";

/**
 * Why there is no value. `null` and `missing` come from the payload;
 * `unsupported` and `unavailable` come from the source state (R5) and are
 * pushed down into a row so a section can stay on screen with honest
 * placeholders instead of disappearing.
 */
export type AbsenceKind = "null" | "missing" | "unsupported" | "unavailable" | "empty";

export interface FormattedValue {
  text: string;
  /** Set only when the value is genuinely absent — NEVER for `false`/`0`. */
  absence?: AbsenceKind;
  /** A real `false` or `0`: shown as a value, flagged so styling can differ from absence. */
  falsy?: boolean;
  /** Absolute rendering kept reachable from a relative one (§13, relative age). */
  title?: string;
  /** Secondary hint: the catalog's `zeroMeaning` when the value really is 0. */
  note?: string;
  /** Identifiers, addresses and fingerprints render in a monospace column. */
  monospace?: boolean;
  /**
   * Which formatter actually produced `text`. A renderer needs the identity,
   * not just the string — §13's tabular-numerals rule is a property of the
   * formatter, and re-deriving "was this a number?" from the output is how a
   * localized thousands separator turns into a rendering bug.
   */
  formatter?: FormatterName;
  /** True when `text` is a rendered number: apply tabular-nums (§13). */
  numeric?: boolean;
}

export interface FormatContext {
  formatter?: FormatterName;
  unit?: FieldUnit;
  nullMeaning?: string;
  zeroMeaning?: string;
  /**
   * Whether the key exists in the payload at all. `false` produces the
   * `missing` absence even when the value reads as undefined for some other
   * reason — Go's omitempty is the common case.
   */
  present?: boolean;
  /** Forced absence from the source state, overriding the value entirely. */
  absence?: Extract<AbsenceKind, "unsupported" | "unavailable">;
  /**
   * Current time in epoch ms. REQUIRED, and deliberately not defaulted to
   * `Date.now()`: a default would make every relative age silently
   * non-deterministic and let a caller forget the clock without the types
   * noticing. The hook layer supplies one clock for the whole page, so every
   * age on screen is measured from the same instant.
   */
  nowMs: number;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

// absenceText maps each absence to its own sentence. Four different strings
// for four different situations is the entire point of §13.1's "unsupported
// MUST differ from unavailable".
export function absenceText(kind: AbsenceKind, s: Dict): string {
  switch (kind) {
    case "null":
      return s.details.value.none;
    case "missing":
      return s.details.value.missing;
    case "unsupported":
      return s.details.value.unsupported;
    case "unavailable":
      return s.details.value.unavailable;
    case "empty":
      return s.details.value.empty;
  }
}

/** absent builds a FormattedValue for one of the absence kinds. */
export function absent(kind: AbsenceKind, s: Dict): FormattedValue {
  return { text: absenceText(kind, s), absence: kind };
}

function round(value: number, digits: number): string {
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

// formatDecimal keeps at most two fraction digits and groups the integer
// part per locale — the "decimal with tabular numerals" family of §13.
function formatDecimal(n: number, s: Dict): string {
  return new Intl.NumberFormat(localeOf(s), { maximumFractionDigits: 2 }).format(n);
}

// formatMilliseconds spans the whole range Telemt reports in ms: a 4 ms DC
// RTT, a 9838 ms init step, and an uptime of days. formatDurationApprox
// alone would floor the first two to "1 мин.".
export function formatMilliseconds(ms: number, s: Dict): string {
  const abs = Math.abs(ms);
  if (abs < SECOND_MS) return `${formatNumber(s, Math.round(ms))} ${s.details.value.ms}`;
  if (abs < MINUTE_MS) return `${formatDecimal(ms / SECOND_MS, s)} ${s.details.value.seconds}`;
  return formatDurationApprox(ms, s);
}

// formatAbsoluteTimestamp — the absolute rendering §13 requires to stay
// reachable from every relative age.
export function formatAbsoluteTimestamp(epochMs: number, s: Dict): string {
  return new Date(epochMs).toLocaleString(localeOf(s));
}

// formatRelativeAge renders "N назад" with the absolute stamp as the title.
// A timestamp in the future (client clock behind the server's — the polling
// fallback makes this real, see realtime/topicWindow.ts) says so instead of
// rendering a negative age.
export function formatRelativeAge(epochMs: number, s: Dict, nowMs: number): FormattedValue {
  const title = formatAbsoluteTimestamp(epochMs, s);
  const delta = nowMs - epochMs;
  if (delta < 0) return { text: s.details.value.inFuture, title };
  if (delta < MINUTE_MS) return { text: s.details.value.justNow, title };
  return { text: fill(s.details.value.agoTemplate, { age: formatDurationApprox(delta, s) }), title };
}

// epochToMs accepts both of the two epoch spellings Telemt uses: seconds
// (`*_epoch_secs`, everything on the SSE topics) and milliseconds. The
// threshold is "would this be a date before 2001 if read as ms" — a
// seconds-valued stamp is ~1.7e9, a ms-valued one ~1.7e12.
const MS_EPOCH_FLOOR = 1e11;

export function epochToMs(value: number): number {
  return value < MS_EPOCH_FLOOR ? value * SECOND_MS : value;
}

// FORMATTERS is the registry §13 asks for: name -> renderer over an
// already-non-null value. Keeping it a plain record (not a class) means a
// page definition can name a formatter by string and a test can enumerate
// the whole set.
type Formatter = (value: unknown, s: Dict, ctx: FormatContext) => FormattedValue;

export const FORMATTERS: Record<FormatterName, Formatter> = {
  text: (value, s) => formatPrimitiveText(value, s),
  integer: (value, s) =>
    typeof value === "number"
      ? { text: formatNumber(s, Math.trunc(value)), falsy: value === 0 }
      : formatPrimitiveText(value, s),
  decimal: (value, s) =>
    typeof value === "number"
      ? { text: formatDecimal(value, s), falsy: value === 0 }
      : formatPrimitiveText(value, s),
  percent: (value, s) =>
    typeof value === "number"
      ? { text: `${round(value, 1)} ${s.details.value.percentSuffix}`, falsy: value === 0 }
      : formatPrimitiveText(value, s),
  milliseconds: (value, s) =>
    typeof value === "number"
      ? { text: formatMilliseconds(value, s), falsy: value === 0 }
      : formatPrimitiveText(value, s),
  seconds: (value, s) =>
    typeof value === "number"
      ? { text: formatMilliseconds(value * SECOND_MS, s), falsy: value === 0 }
      : formatPrimitiveText(value, s),
  duration: (value, s) =>
    typeof value === "number"
      ? { text: formatMilliseconds(value, s), falsy: value === 0 }
      : formatPrimitiveText(value, s),
  bytes: (value, s) =>
    typeof value === "number"
      ? { text: formatBytes(value, s), falsy: value === 0 }
      : formatPrimitiveText(value, s),
  rate: (value, s) =>
    typeof value === "number"
      ? { text: `${formatBytes(value, s)}${s.details.value.perSecond}`, falsy: value === 0 }
      : formatPrimitiveText(value, s),
  timestamp: (value, s) =>
    typeof value === "number"
      ? { text: formatAbsoluteTimestamp(epochToMs(value), s) }
      : formatPrimitiveText(value, s),
  relativeAge: (value, s, ctx) =>
    typeof value === "number"
      ? formatRelativeAge(epochToMs(value), s, ctx.nowMs)
      : formatPrimitiveText(value, s),
  // §13.1: `false` is a value. It renders through the same yes/no words the
  // diagnostics tables already use, and carries `falsy` rather than an
  // absence.
  boolean: (value, s) =>
    typeof value === "boolean"
      ? { text: value ? s.common.yes : s.common.no, falsy: !value }
      : formatPrimitiveText(value, s),
  enum: (value, s) => formatPrimitiveText(value, s),
  address: (value, s) => ({ ...formatPrimitiveText(value, s), monospace: true }),
  identifier: (value, s) => ({ ...formatPrimitiveText(value, s), monospace: true }),
};

// formatPrimitiveText is the last-resort renderer: whatever the value is,
// show it as itself. Never returns an em dash for a present value — an
// empty string is a collected value and says so.
function formatPrimitiveText(value: unknown, s: Dict): FormattedValue {
  if (typeof value === "boolean") return { text: value ? s.common.yes : s.common.no, falsy: !value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return absent("null", s);
    return { text: formatNumber(s, value), falsy: value === 0 };
  }
  if (typeof value === "string") {
    return value === "" ? { text: s.details.value.empty, absence: "empty" } : { text: value };
  }
  return { text: String(value) };
}

// formatterForUnit picks a default formatter when the catalog names a unit
// but no formatter — the common case for a seeded field.
export function formatterForUnit(unit: FieldUnit): FormatterName {
  switch (unit) {
    case "percent":
      return "percent";
    case "milliseconds":
      return "milliseconds";
    case "seconds":
      return "seconds";
    case "bytes":
      return "bytes";
    case "timestamp":
      return "relativeAge";
  }
}

// formatValue is the single entry point every renderer uses.
//
// Order matters and encodes §13.1 exactly: a forced source-level absence
// beats everything; a missing key beats a null value; only then does the
// registry see a real value. `false` and `0` never reach an absence branch.
export function formatValue(value: unknown, s: Dict, ctx: FormatContext): FormattedValue {
  if (ctx.absence) return absent(ctx.absence, s);
  if (value === undefined || ctx.present === false) return absent("missing", s);
  if (value === null) {
    return ctx.nullMeaning ? { text: ctx.nullMeaning, absence: "null" } : absent("null", s);
  }
  // Defensive: §12.7 forbids ever handing an array to a scalar row, and the
  // resolver enforces it. If a hand-written definition still manages it,
  // say so instead of printing "[object Object]" or a comma-joined list.
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return { text: s.details.value.structured, absence: "empty" };
  }
  const name = ctx.formatter ?? (ctx.unit ? formatterForUnit(ctx.unit) : "text");
  const formatted = FORMATTERS[name](value, s, ctx);
  const tagged: FormattedValue = {
    ...formatted,
    formatter: name,
    numeric: NUMERIC_FORMATTERS.has(name) && typeof value === "number",
  };
  if (tagged.falsy && value === 0 && ctx.zeroMeaning) {
    return { ...tagged, note: ctx.zeroMeaning };
  }
  return tagged;
}

// The formatter families §13 renders as numbers, i.e. the ones whose output
// gets tabular numerals. `text` is in the set because a bare number falls
// through to it; `numeric` is still gated on the VALUE being a number, so a
// string rendered by `text` is not tagged.
const NUMERIC_FORMATTERS: ReadonlySet<FormatterName> = new Set<FormatterName>([
  "text",
  "integer",
  "decimal",
  "percent",
  "milliseconds",
  "seconds",
  "duration",
  "bytes",
  "rate",
]);
