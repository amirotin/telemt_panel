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
    expect(formatValue(1536, ru, { unit: "bytes" }).text).toBe("1.5 КБ");
    expect(formatValue(1536, en, { unit: "bytes" }).text).toBe("1.5 KB");
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
    const value = formatValue(false, ru, { formatter: "boolean" });
    expect(value.text).toBe("нет");
    expect(value.absence).toBeUndefined();
    expect(value.falsy).toBe(true);
  });

  it("renders 0 as a real value, not as absence", () => {
    const value = formatValue(0, ru, { formatter: "integer" });
    expect(value.text).toBe("0");
    expect(value.absence).toBeUndefined();
    expect(value.falsy).toBe(true);
  });

  it("attaches zeroMeaning beside a real 0, never instead of it", () => {
    const value = formatValue(0, ru, { formatter: "integer", zeroMeaning: "нет писателей" });
    expect(value.text).toBe("0");
    expect(value.note).toBe("нет писателей");
  });

  it("follows nullMeaning when the catalog knows one", () => {
    const known = formatValue(null, ru, { nullMeaning: "замера ещё не было" });
    expect(known.text).toBe("замера ещё не было");
    expect(known.absence).toBe("null");
    expect(formatValue(null, ru, {}).text).toBe("—");
  });

  it("distinguishes an absent optional field from a collected null", () => {
    const missing = formatValue(undefined, ru, {});
    const nulled = formatValue(null, ru, {});
    expect(missing.absence).toBe("missing");
    expect(nulled.absence).toBe("null");
    expect(missing.text).not.toBe(nulled.text);
  });

  it("distinguishes unsupported from unavailable", () => {
    const unsupported = formatValue(1, ru, { absence: "unsupported" });
    const unavailable = formatValue(1, ru, { absence: "unavailable" });
    expect(unsupported.text).not.toBe(unavailable.text);
    expect(unsupported.absence).toBe("unsupported");
    expect(unavailable.absence).toBe("unavailable");
  });

  it("treats a present key with present:false as missing", () => {
    expect(formatValue(3, ru, { present: false }).absence).toBe("missing");
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

describe("defensive behaviour", () => {
  it("never comma-joins an array into a scalar row (§12.7)", () => {
    const value = formatValue([1, 2, 3], ru, {});
    expect(value.text).toBe(ru.details.value.structured);
    expect(value.text).not.toContain(",");
  });

  it("says 'empty' for an empty string rather than an em dash", () => {
    expect(formatValue("", ru, {}).absence).toBe("empty");
  });

  it("formats a non-finite number as absence, not as NaN", () => {
    expect(formatValue(Number.NaN, ru, {}).absence).toBe("null");
  });
});
