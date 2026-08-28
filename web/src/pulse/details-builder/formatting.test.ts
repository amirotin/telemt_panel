import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../../i18n/en";
import { ru } from "../../i18n/ru";
import {
  FORMATTERS,
  absenceText,
  epochToMs,
  formatMilliseconds,
  formatRelativeAge,
  formatValue,
  formatterForUnit,
} from "./formatting";
import type { FormatterName } from "./formatting";

// A fixed "now" — no test in this repo reads the clock (global constraint).
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

describe("formatter registry (spec §13)", () => {
  it("covers every mandatory formatter family", () => {
    const required: FormatterName[] = [
      "integer",
      "decimal",
      "percent",
      "milliseconds",
      "seconds",
      "duration",
      "bytes",
      "rate",
      "timestamp",
      "relativeAge",
      "boolean",
      "enum",
      "address",
      "identifier",
      "text",
    ];
    for (const name of required) expect(typeof FORMATTERS[name]).toBe("function");
  });

  it("derives a formatter from a unit when the catalog names only a unit", () => {
    expect(formatterForUnit("percent")).toBe("percent");
    expect(formatterForUnit("bytes")).toBe("bytes");
    expect(formatterForUnit("timestamp")).toBe("relativeAge");
  });

  it("reuses lib/format's byte units rather than inventing its own", () => {
    expect(formatValue(1536, ru, { nowMs: NOW, unit: "bytes" }).text).toBe("1.5 КБ");
    expect(formatValue(1536, en, { nowMs: NOW, unit: "bytes" }).text).toBe("1.5 KB");
  });

  it("spans the whole millisecond range Telemt reports", () => {
    // 4 ms DC RTT, 9838 ms init step, days of uptime — formatDurationApprox
    // alone would floor the first two to "1 мин.".
    expect(formatMilliseconds(4, ru)).toBe("4 мс");
    // The decimal separator is locale data (ru: comma) — assert the digits
    // and the unit, not the glyph between them.
    expect(formatMilliseconds(9838, ru).replace(",", ".")).toBe("9.84 с");
    expect(formatMilliseconds(9838, en)).toBe("9.84 s");
    expect(formatMilliseconds(864321 * 1000, ru)).toBe("10 дн.");
  });

  it("accepts both epoch spellings", () => {
    expect(epochToMs(1756000000)).toBe(1756000000000);
    expect(epochToMs(1756000000000)).toBe(1756000000000);
  });

  it("keeps the absolute timestamp reachable from a relative age", () => {
    const value = formatRelativeAge(NOW - 3 * 60 * 60 * 1000, ru, NOW);
    expect(value.text).toBe("3 ч. назад");
    expect(value.title).toBeTruthy();
    expect(formatRelativeAge(NOW - 5_000, ru, NOW).text).toBe("только что");
    expect(formatRelativeAge(NOW + 60_000, ru, NOW).text).toBe("в будущем");
  });
});

describe("null, false and zero (spec §13.1)", () => {
  it("renders false as a real value, not as absence", () => {
    const value = formatValue(false, ru, { nowMs: NOW, formatter: "boolean" });
    expect(value.text).toBe("нет");
    expect(value.absence).toBeUndefined();
    expect(value.falsy).toBe(true);
  });

  it("renders 0 as a real value, not as absence", () => {
    const value = formatValue(0, ru, { nowMs: NOW, formatter: "integer" });
    expect(value.text).toBe("0");
    expect(value.absence).toBeUndefined();
    expect(value.falsy).toBe(true);
  });

  it("attaches zeroMeaning beside a real 0, never instead of it", () => {
    const value = formatValue(0, ru, { nowMs: NOW, formatter: "integer", zeroMeaning: "нет писателей" });
    expect(value.text).toBe("0");
    expect(value.note).toBe("нет писателей");
  });

  it("follows nullMeaning when the catalog knows one", () => {
    const known = formatValue(null, ru, { nowMs: NOW, nullMeaning: "замера ещё не было" });
    expect(known.text).toBe("замера ещё не было");
    expect(known.absence).toBe("null");
    expect(formatValue(null, ru, { nowMs: NOW }).text).toBe("—");
  });

  it("distinguishes an absent optional field from a collected null", () => {
    const missing = formatValue(undefined, ru, { nowMs: NOW });
    const nulled = formatValue(null, ru, { nowMs: NOW });
    expect(missing.absence).toBe("missing");
    expect(nulled.absence).toBe("null");
    expect(missing.text).not.toBe(nulled.text);
  });

  it("distinguishes unsupported from unavailable", () => {
    const unsupported = formatValue(1, ru, { nowMs: NOW, absence: "unsupported" });
    const unavailable = formatValue(1, ru, { nowMs: NOW, absence: "unavailable" });
    expect(unsupported.text).not.toBe(unavailable.text);
    expect(unsupported.absence).toBe("unsupported");
    expect(unavailable.absence).toBe("unavailable");
  });

  it("treats a present key with present:false as missing", () => {
    expect(formatValue(3, ru, { nowMs: NOW, present: false }).absence).toBe("missing");
  });

  it("gives every absence its own words in both languages", () => {
    for (const dict of [ru, en]) {
      const texts = (["null", "missing", "unsupported", "unavailable", "empty"] as const).map((k) =>
        absenceText(k, dict),
      );
      expect(new Set(texts).size).toBe(texts.length);
    }
  });
});

describe("purity: the module never reads the clock", () => {
  it("has no Date.now() in formatting.ts at all", () => {
    // L2 from the task-2 review: `ctx.nowMs ?? Date.now()` made every caller
    // that forgot the clock silently non-deterministic, and nothing in the
    // types objected. `nowMs` is now required; this asserts the default is
    // gone rather than merely unused.
    const here = path.dirname(fileURLToPath(import.meta.url));
    // Comments are stripped first: the doc comment on `nowMs` is allowed to
    // name the default it deliberately does not have (same convention as
    // i18n/i18n.test.ts's Cyrillic sweep).
    const code = readFileSync(path.join(here, "formatting.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code.includes("Date.now(")).toBe(false);
  });

  it("returns the same result for the same inputs, twice", () => {
    const ctx = { formatter: "relativeAge", nowMs: NOW } as const;
    const value = NOW - 90 * 60 * 1000;
    expect(formatValue(value, ru, ctx)).toEqual(formatValue(value, ru, ctx));
  });

  it("moves the age only when the caller's clock moves", () => {
    const stamp = NOW - 60 * 60 * 1000;
    const early = formatValue(stamp, ru, { formatter: "relativeAge", nowMs: NOW });
    const later = formatValue(stamp, ru, {
      formatter: "relativeAge",
      nowMs: NOW + 3 * 60 * 60 * 1000,
    });
    expect(early.text).not.toBe(later.text);
    // The absolute stamp is the same instant either way.
    expect(early.title).toBe(later.title);
  });
});

describe("formatter identity travels with the value (spec §13)", () => {
  it("reports which formatter produced the text", () => {
    expect(formatValue(5, ru, { formatter: "integer", nowMs: NOW }).formatter).toBe("integer");
    expect(formatValue(1536, ru, { unit: "bytes", nowMs: NOW }).formatter).toBe("bytes");
    // No formatter and no unit still names the one that ran.
    expect(formatValue("x", ru, { nowMs: NOW }).formatter).toBe("text");
  });

  it("flags rendered numbers so a renderer can apply tabular numerals", () => {
    for (const name of ["integer", "decimal", "percent", "milliseconds", "bytes"] as const) {
      expect(formatValue(12, ru, { formatter: name, nowMs: NOW }).numeric, name).toBe(true);
    }
    // A bare number with no formatter is still a number…
    expect(formatValue(12, ru, { nowMs: NOW }).numeric).toBe(true);
    // …and 0 is a number, not an absence.
    expect(formatValue(0, ru, { formatter: "integer", nowMs: NOW }).numeric).toBe(true);
    // Non-numeric families and non-numeric values are not flagged.
    expect(formatValue(true, ru, { formatter: "boolean", nowMs: NOW }).numeric).toBe(false);
    expect(formatValue("198.51.100.7:443", ru, { formatter: "address", nowMs: NOW }).numeric).toBe(
      false,
    );
    expect(formatValue(1756000000, ru, { formatter: "relativeAge", nowMs: NOW }).numeric).toBe(
      false,
    );
    // An absence is never numeric — there is no number to align.
    expect(formatValue(null, ru, { formatter: "integer", nowMs: NOW }).numeric).toBeUndefined();
  });
});

describe("defensive behaviour", () => {
  it("never comma-joins an array into a scalar row (§12.7)", () => {
    const value = formatValue([1, 2, 3], ru, { nowMs: NOW });
    expect(value.text).toBe(ru.details.value.structured);
    expect(value.text).not.toContain(",");
  });

  it("says 'empty' for an empty string rather than an em dash", () => {
    expect(formatValue("", ru, { nowMs: NOW }).absence).toBe("empty");
  });

  it("formats a non-finite number as absence, not as NaN", () => {
    expect(formatValue(Number.NaN, ru, { nowMs: NOW }).absence).toBe("null");
  });
});
