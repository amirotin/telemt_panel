const formatters = new Map<string, Intl.NumberFormat>();
const maximumFormatters = 64;
// Intl reads these through property access, including inherited options.
const numberFormatOptions = [
  "localeMatcher", "numberingSystem", "style", "currency", "currencyDisplay", "currencySign",
  "unit", "unitDisplay", "notation", "compactDisplay", "useGrouping", "minimumIntegerDigits",
  "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits", "maximumSignificantDigits",
  "signDisplay", "roundingIncrement", "roundingMode", "roundingPriority", "trailingZeroDisplay",
];

export function getNumberFormatter(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const values = options as Record<string, unknown> | undefined;
  const keys = values ? [...new Set([...numberFormatOptions, ...Object.getOwnPropertyNames(values)])].sort() : [];
  const key = JSON.stringify([locale, keys.flatMap((name) => {
    const value = values![name];
    return value === undefined ? [] : [[name, typeof value, value]];
  })]);
  const cached = formatters.get(key);
  if (cached) {
    formatters.delete(key);
    formatters.set(key, cached);
    return cached;
  }
  const formatter = new Intl.NumberFormat(locale, options);
  formatters.set(key, formatter);
  if (formatters.size > maximumFormatters) formatters.delete(formatters.keys().next().value!);
  return formatter;
}
