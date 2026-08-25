import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import type { Dict, Locale } from "./dict";
import { en } from "./en";
import { ru } from "./ru";
import { errorMessage } from "./messages";
import { localeFromLanguages, resolveLocale } from "./locale";
import { countLabel, fill, formatNumber, plural, pluralIndex, pluralTemplate } from "./plural";

const DICTS: Array<[Locale, Dict]> = [
  ["ru", ru],
  ["en", en],
];

// Parses api/openapi.yaml directly (js-yaml — already a devDependency for
// scripts/filter-openapi.mjs, so this adds zero new npm packages; see
// task-4-report.md's "Fix round 1" section) rather than hand-maintaining a
// second copy of the code list here, which is exactly the drift risk this
// replaces: api/openapi.yaml's Error.code is a proper `enum:`, so this test
// is the single source of truth walking the real contract instead of a
// string a human has to remember to update in lockstep.
function documentedErrorCodes(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const openapiPath = path.join(here, "..", "..", "..", "api", "openapi.yaml");
  const doc = yaml.load(readFileSync(openapiPath, "utf8"));
  const codes = (
    doc as {
      components?: { schemas?: { Error?: { properties?: { code?: { enum?: unknown } } } } };
    }
  ).components?.schemas?.Error?.properties?.code?.enum;
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error("openapi.yaml: components.schemas.Error.properties.code.enum is missing/empty");
  }
  return codes.map((c) => {
    if (typeof c !== "string") throw new Error(`non-string error code in openapi.yaml enum: ${String(c)}`);
    return c;
  });
}

// deepKeys walks a dictionary into a sorted list of dotted paths, so the
// parity check reports the exact missing/extra key rather than "objects
// differ". Arrays contribute their length (byteUnits must stay five slots,
// every PluralForms three) but not their contents.
function deepKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return [`${prefix}[${value.length}]`];
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      deepKeys(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [prefix];
}

describe("dictionary shape parity", () => {
  // The type system already enforces this (en.ts is typed `Dict`, and Dict
  // comes from `typeof ru`) — this asserts it at runtime too, because the
  // one thing types cannot catch is a key that exists in both but got typed
  // through a widening cast somewhere down the line.
  it("en has exactly the keys ru has", () => {
    expect(deepKeys(en)).toEqual(deepKeys(ru));
  });

  it.each(DICTS)("%s has no empty strings", (_locale, dict) => {
    const empties: string[] = [];
    const walk = (value: unknown, prefix: string) => {
      if (typeof value === "string") {
        if (value.trim() === "") empties.push(prefix);
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${prefix}[${i}]`));
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k);
      }
    };
    walk(dict, "");
    expect(empties).toEqual([]);
  });

  it("keeps every dictionary's own locale tag in sync with its name", () => {
    expect(ru.locale).toBe("ru");
    expect(en.locale).toBe("en");
  });
});

describe("errors completeness", () => {
  it.each(DICTS)(
    "%s has a non-empty message for every code in openapi.yaml's Error.code enum",
    (_locale, dict) => {
      const table = dict.errors as unknown as Record<string, string>;
      for (const code of documentedErrorCodes()) {
        expect(table[code], `missing message for code "${code}"`).toBeTruthy();
      }
    },
  );

  it.each(DICTS)("%s falls back to the default message for an unknown code", (_locale, dict) => {
    expect(errorMessage(dict, "some_future_code_not_yet_known")).toBe(dict.errors.default);
  });

  it.each(DICTS)("%s returns the mapped message for a known code", (_locale, dict) => {
    expect(errorMessage(dict, "rate_limited")).toBe(
      (dict.errors as unknown as Record<string, string>)["rate_limited"],
    );
  });

  it("gives the two languages different text for the same code", () => {
    expect(errorMessage(en, "invalid_credentials")).not.toBe(errorMessage(ru, "invalid_credentials"));
  });
});

describe("audit action completeness", () => {
  // The key set is the contract with the backend and is locale-independent;
  // journal/auditActions.test.ts checks it against the real appendAudit call
  // sites. This only asserts both dictionaries carry the whole set.
  it("both dictionaries label every audit action", () => {
    const ruKeys = Object.keys(ru.auditActions).sort();
    const enKeys = Object.keys(en.auditActions).sort();
    expect(enKeys).toEqual(ruKeys);
    for (const [, dict] of DICTS) {
      for (const key of ruKeys) {
        expect((dict.auditActions as unknown as Record<string, string>)[key]).toBeTruthy();
      }
    }
  });
});

describe("plural", () => {
  it("picks the Russian one/few/many forms, including the 11–14 exception", () => {
    const forms: [string, string, string] = ["one", "few", "many"];
    const pick = (n: number) => forms[pluralIndex("ru", n)];
    expect([0, 5, 6, 9, 10, 11, 12, 13, 14, 15, 20, 25, 100, 111].map(pick)).toEqual(
      Array(14).fill("many"),
    );
    expect([1, 21, 31, 101, 1001].map(pick)).toEqual(Array(5).fill("one"));
    expect([2, 3, 4, 22, 23, 24, 102].map(pick)).toEqual(Array(7).fill("few"));
  });

  it("picks one/other for English", () => {
    expect(pluralIndex("en", 1)).toBe(0);
    for (const n of [0, 2, 5, 11, 21, 101]) expect(pluralIndex("en", n)).toBe(1);
  });

  it("resolves the dictionary's own tag", () => {
    expect(plural(ru, 2, ["запись", "записи", "записей"])).toBe("записи");
    expect(plural(en, 2, ["entry", "entries", "entries"])).toBe("entries");
    expect(plural(en, 1, ["entry", "entries", "entries"])).toBe("entry");
  });

  it("builds count labels and templates with a locale-grouped number", () => {
    expect(countLabel(en, 1, en.pulse.securityPosture.whitelistEntries)).toBe("1 entry");
    expect(countLabel(en, 5, en.pulse.securityPosture.whitelistEntries)).toBe("5 entries");
    expect(countLabel(ru, 5, ru.pulse.securityPosture.whitelistEntries)).toBe("5 записей");
    expect(pluralTemplate(en, 1, en.people.searchAmong)).toBe("Search 1 person");
    expect(pluralTemplate(en, 3, en.people.searchAmong)).toBe("Search 3 people");
    // Grouping separators differ per locale — assert the digits survive
    // rather than pinning a particular (locale-data-dependent) space glyph.
    expect(formatNumber(en, 1234)).toBe("1,234");
    expect(formatNumber(ru, 1234).replace(/\D/g, "")).toBe("1234");
  });

  it("leaves unknown placeholders alone", () => {
    expect(fill("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
  });
});

describe("locale resolution", () => {
  it("lets a stored preference beat the browser", () => {
    expect(resolveLocale("en", ["ru-RU", "ru"])).toBe("en");
    expect(resolveLocale("ru", ["en-US"])).toBe("ru");
  });

  it("follows the browser when the preference is auto", () => {
    expect(resolveLocale("auto", ["ru-RU", "ru"])).toBe("ru");
    expect(resolveLocale("auto", ["en-GB"])).toBe("en");
  });

  it("falls back to English for a language the panel doesn't ship", () => {
    expect(resolveLocale("auto", ["de-DE", "fr"])).toBe("en");
    expect(resolveLocale("auto", [])).toBe("en");
  });

  it("scans the whole language list for the first supported tag", () => {
    expect(localeFromLanguages(["de-DE", "ru-RU", "en"])).toBe("ru");
    expect(localeFromLanguages(["DE", "EN-us"])).toBe("en");
  });
});
