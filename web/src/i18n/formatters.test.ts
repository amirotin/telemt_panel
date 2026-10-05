import { describe, expect, it } from "vitest";
import { getNumberFormatter } from "./formatters";

describe("number formatter reuse", () => {
  it("reuses identical options regardless of their insertion order", () => {
    const first = getNumberFormatter("ru", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    const second = getNumberFormatter("ru", { maximumFractionDigits: 2, minimumFractionDigits: 1 });
    expect(second).toBe(first);
  });

  it("keeps locale and every option in the key", () => {
    const first = getNumberFormatter("en", { maximumFractionDigits: 2, useGrouping: false });
    expect(getNumberFormatter("ru", { maximumFractionDigits: 2, useGrouping: false })).not.toBe(first);
    expect(getNumberFormatter("en", { maximumFractionDigits: 2, useGrouping: true })).not.toBe(first);
    expect(getNumberFormatter("en", { maximumFractionDigits: 1, useGrouping: false })).not.toBe(first);
    expect(getNumberFormatter("en", { style: "currency", currency: "USD" })).not.toBe(
      getNumberFormatter("en", { style: "currency", currency: "EUR" }),
    );
  });

  it("includes inherited and non-enumerable Intl options", () => {
    getNumberFormatter("en-GB", {});
    const inherited = Object.create({ maximumFractionDigits: 0 }) as Intl.NumberFormatOptions;
    const hidden = Object.defineProperty({}, "maximumFractionDigits", { value: 1 }) as Intl.NumberFormatOptions;
    expect(getNumberFormatter("en-GB", inherited).format(1.234)).toBe("1");
    expect(getNumberFormatter("en-GB", hidden).format(1.234)).toBe("1.2");
  });

  it("evicts the least recently used formatter after 64 keys", () => {
    const options = Array.from({ length: 65 }, (_, index) => ({
      maximumFractionDigits: index % 21,
      minimumIntegerDigits: Math.floor(index / 21) + 1,
    }));
    const first = getNumberFormatter("en-US", options[0]);
    const second = getNumberFormatter("en-US", options[1]);
    for (const option of options.slice(2, 64)) getNumberFormatter("en-US", option);
    expect(getNumberFormatter("en-US", options[0])).toBe(first);
    getNumberFormatter("en-US", options[64]);
    expect(getNumberFormatter("en-US", options[0])).toBe(first);
    expect(getNumberFormatter("en-US", options[1])).not.toBe(second);
  });

  it("preserves Intl output and validation across supported styles", () => {
    const options: Intl.NumberFormatOptions[] = [
      {}, { maximumFractionDigits: 2 }, { useGrouping: false },
      { minimumIntegerDigits: 3, minimumFractionDigits: 2 },
      { style: "currency", currency: "USD", currencySign: "accounting" },
      { style: "percent", maximumFractionDigits: 1 },
      { style: "unit", unit: "byte", unitDisplay: "short" },
      { notation: "compact", compactDisplay: "long" },
      { minimumSignificantDigits: 3, maximumSignificantDigits: 4, signDisplay: "always" },
    ];
    for (const locale of ["ru", "en"]) {
      for (const option of options) {
        const formatter = getNumberFormatter(locale, option);
        const original = new Intl.NumberFormat(locale, option);
        for (const value of [0, -0, 1.005, 1234.56, -9876543.21, NaN, Infinity]) {
          expect(formatter.format(value)).toBe(original.format(value));
        }
      }
    }
    expect(() => getNumberFormatter("en", { minimumFractionDigits: 4, maximumFractionDigits: 2 })).toThrow(RangeError);
  });
});
