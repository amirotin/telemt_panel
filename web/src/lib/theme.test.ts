import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  getStoredTheme,
  isTheme,
  resolvedColorScheme,
  setStoredTheme,
  THEMES,
  themeColor,
  type Theme,
} from "./theme";

const STORAGE_KEY = "telemt-panel:theme";

// jsdom's window.matchMedia exists but always answers `matches: false`, so
// «Системная» would only ever be measurable in its dark half. The stub is
// the smallest thing that lets both halves be asserted.
function stubPrefersLight(light: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: query.includes("light") ? light : !light,
        media: query,
      }) as MediaQueryList,
  );
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  document.documentElement.removeAttribute("data-theme");
  document.getElementById("theme-color-meta")?.remove();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme names", () => {
  it("ships the five choices 06-ui.md lists, in switcher order", () => {
    expect([...THEMES]).toEqual(["system", "light", "dark", "mocha", "parchment"]);
  });

  // index.html applies the stored theme before first paint, from a
  // hand-written duplicate of this list (it cannot import the module). A
  // theme added here but not there flashes the dark palette on every load.
  it("is the same list index.html's boot script pins before first paint", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    const match = /var known = \[([^\]]*)\];/.exec(html);
    expect(match, "index.html's known-theme list").not.toBeNull();
    const known = match![1]!.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    expect(known.sort()).toEqual(THEMES.filter((t) => t !== "system").toSorted());
  });

  it("accepts every shipped name and rejects anything else", () => {
    for (const theme of THEMES) expect(isTheme(theme), theme).toBe(true);
    for (const junk of ["comfort", "latte", "Dark", "", null, undefined, 3])
      expect(isTheme(junk), String(junk)).toBe(false);
  });
});

describe("persistence", () => {
  it("round-trips every theme through localStorage", () => {
    for (const theme of THEMES) {
      setStoredTheme(theme);
      expect(localStorage.getItem(STORAGE_KEY)).toBe(theme);
      expect(getStoredTheme()).toBe(theme);
    }
  });

  // The value survives an upgrade that drops a theme, and a hand-edited
  // storage entry: either way the product default is what paints.
  it("falls back to dark for an absent or unknown stored value", () => {
    expect(getStoredTheme()).toBe("dark");
    localStorage.setItem(STORAGE_KEY, "latte");
    expect(getStoredTheme()).toBe("dark");
  });
});

describe("resolvedColorScheme", () => {
  it("reads the warm themes as the halves they are, not as 'not light'", () => {
    expect(resolvedColorScheme("mocha")).toBe("dark");
    expect(resolvedColorScheme("parchment")).toBe("light");
    expect(resolvedColorScheme("dark")).toBe("dark");
    expect(resolvedColorScheme("light")).toBe("light");
  });

  it("asks the OS only for «Системная»", () => {
    stubPrefersLight(true);
    expect(resolvedColorScheme("system")).toBe("light");
    // The stub would answer "light" for anything that consulted it.
    expect(resolvedColorScheme("mocha")).toBe("dark");
    stubPrefersLight(false);
    expect(resolvedColorScheme("system")).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("writes [data-theme] for a named theme and clears it for «Системная»", () => {
    for (const theme of THEMES.filter((t): t is Exclude<Theme, "system"> => t !== "system")) {
      applyTheme(theme);
      expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
    }
    stubPrefersLight(false);
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("moves the theme-color meta with the theme", () => {
    const meta = document.createElement("meta");
    meta.id = "theme-color-meta";
    meta.setAttribute("content", "#000000");
    document.head.append(meta);

    applyTheme("mocha");
    expect(meta.getAttribute("content")).toBe("#211e1a");
    applyTheme("parchment");
    expect(meta.getAttribute("content")).toBe("#f3ead9");

    stubPrefersLight(true);
    applyTheme("system");
    expect(meta.getAttribute("content")).toBe("#f3f5f8");
  });

  it("survives a document with no theme-color meta at all", () => {
    expect(() => applyTheme("parchment")).not.toThrow();
  });
});

// The status bar sits directly above the page: a theme-color that is a
// shade off its palette's --bg shows as a seam. theme.ts says it "must
// track --bg in styles/tokens.css" — this is that promise, measured.
describe("theme-color tracks each palette's --bg", () => {
  const TOKENS = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");

  function bgOf(blockStart: string): string {
    const start = TOKENS.indexOf(blockStart);
    expect(start, blockStart).toBeGreaterThanOrEqual(0);
    const match = /--bg:\s*(\d+)\s+(\d+)\s+(\d+)\s*;/.exec(TOKENS.slice(start));
    expect(match, `--bg after ${blockStart}`).not.toBeNull();
    return (
      "#" +
      [1, 2, 3]
        .map((i) => Number(match![i]).toString(16).padStart(2, "0"))
        .join("")
    );
  }

  it.each([
    ["dark", ":root {"],
    ["light", '[data-theme="light"] {'],
    ["mocha", '[data-theme="mocha"] {'],
    ["parchment", '[data-theme="parchment"] {'],
  ] as const)("%s", (theme, blockStart) => {
    expect(themeColor(theme)).toBe(bgOf(blockStart));
  });
});
