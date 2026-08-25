import type { Dict, Locale } from "./dict";

// PluralForms is the uniform 3-slot shape every countable string in the
// dictionaries uses: [one, few, many]. Russian needs all three (1 запись /
// 2 записи / 5 записей); English needs two, so en.ts repeats the plural in
// the `few` and `many` slots. Keeping the shape identical across
// dictionaries is what lets `Dict = typeof ru` type en.ts at all — a
// locale-specific key set (one/other vs one/few/many) could not.
export type PluralForms = readonly [one: string, few: string, many: string];

// localeOf narrows the dictionary's own BCP-47 tag (Widen<> erases the
// literal type, so this is where it comes back). Every text helper in the
// app takes just `s: Dict` because of this — no second `locale` parameter
// to thread and keep in sync.
export function localeOf(s: Dict): Locale {
  return s.locale === "ru" ? "ru" : "en";
}

// pluralIndex implements the two rule sets by hand (06-ui.md: "никаких
// ICU-фреймворков"). Russian: 1, 21, 31… → one; 2–4, 22–24… → few;
// everything else (0, 5–20, and 11–14 in particular) → many. English:
// 1 → one, everything else → the plural, which sits in the `few` slot.
export function pluralIndex(locale: Locale, n: number): 0 | 1 | 2 {
  const count = Math.abs(Math.trunc(n));
  if (locale === "en") return count === 1 ? 0 : 1;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 0;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
  return 2;
}

export function plural(s: Dict, n: number, forms: PluralForms): string {
  return forms[pluralIndex(localeOf(s), n)];
}

// formatNumber renders a count the way the active language groups digits
// (ru: 1 234, en: 1,234). The tabular-nums styling on stat readouts is
// unaffected by which separator lands between the groups.
export function formatNumber(s: Dict, n: number): string {
  return new Intl.NumberFormat(localeOf(s)).format(n);
}

// fill substitutes {name} placeholders in a dictionary template. The
// dictionaries stay plain data (no functions in ru.ts/en.ts), so every
// template's variables are spliced here instead.
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

// countLabel is the common "<number> <noun>" shape (713 соед. / 713 conns),
// with the number grouped per locale and the noun picked by the count.
export function countLabel(s: Dict, n: number, forms: PluralForms): string {
  return `${formatNumber(s, n)} ${plural(s, n, forms)}`;
}

// pluralTemplate is countLabel's sibling for forms that are whole phrases
// with the count embedded ("+{n} новых", "Search {n} people"): pick the
// form by count, then splice the grouped number in.
export function pluralTemplate(s: Dict, n: number, forms: PluralForms): string {
  return fill(plural(s, n, forms), { n: formatNumber(s, n) });
}
