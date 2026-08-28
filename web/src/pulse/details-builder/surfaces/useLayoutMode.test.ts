import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isCompact, isSplitLayout, layoutModeFor, placementFor, useLayoutMode } from "./useLayoutMode";
import { LAYOUT_TOKEN_VARS, LAYOUT_TOKENS } from "./layoutTokens";

// The §15.1 table and the §17 surface mapping, viewport by viewport. This
// matrix was written for Task 3's temporary stub and moves here with the
// real hook rather than being deleted — the thresholds are the contract,
// not the implementation that reads them.

describe("layoutModeFor (spec §15.1)", () => {
  it.each([
    [360, 640, "compact-portrait"],
    [390, 844, "compact-portrait"],
    [640, 360, "compact-landscape"],
    [740, 360, "compact-landscape"],
    [844, 390, "compact-landscape"],
    [768, 1024, "medium"],
    [1024, 768, "wide"],
    [1366, 768, "wide"],
    [1920, 1080, "wide"],
    [1280, 900, "wide"],
  ])("%i×%i is %s", (width, height, expected) => {
    expect(layoutModeFor(width, height)).toBe(expected);
  });

  it("decides compact by HEIGHT even when the width would pass for a tablet", () => {
    // §15.3: "compact режим определяется высотой, даже если ширина 700–900".
    expect(layoutModeFor(880, 500)).toBe("compact-landscape");
    expect(layoutModeFor(880, 700)).not.toBe("compact-landscape");
  });

  it("needs both dimensions for wide — a tall narrow window is not desktop", () => {
    expect(layoutModeFor(899, 900)).toBe("medium");
    expect(layoutModeFor(900, 599)).toBe("medium");
    expect(layoutModeFor(900, 600)).toBe("wide");
  });
});

describe("placementFor (spec §17)", () => {
  it("bottom sheet in portrait, side sheet in landscape, modal on desktop", () => {
    expect(placementFor("compact-portrait")).toBe("bottom");
    expect(placementFor("compact-landscape")).toBe("side");
    expect(placementFor("medium")).toBe("modal");
    expect(placementFor("wide")).toBe("modal");
  });
});

describe("mode predicates", () => {
  it("calls both phone modes compact, and splits only landscape and wide", () => {
    expect(isCompact("compact-portrait")).toBe(true);
    expect(isCompact("compact-landscape")).toBe(true);
    expect(isCompact("medium")).toBe(false);
    expect(isCompact("wide")).toBe(false);

    // R1: the landscape rail and the wide master pane are the two
    // master/detail layouts; portrait and medium stay one column.
    expect(isSplitLayout("compact-landscape")).toBe(true);
    expect(isSplitLayout("wide")).toBe(true);
    expect(isSplitLayout("compact-portrait")).toBe(false);
    expect(isSplitLayout("medium")).toBe(false);
  });
});

// --- one source for the thresholds --------------------------------------

// vitest runs from the directory holding its config (web/), and
// `import.meta.url` is not a file URL here because vite rewrites it — the
// same reason lib/sourceHygiene.test.ts reads from process.cwd().
function readTokensCss(): string {
  return readFileSync(join(process.cwd(), "src", "styles", "tokens.css"), "utf8");
}

describe("layout tokens", () => {
  it("agrees with the CSS custom properties in styles/tokens.css", () => {
    // The point of the token file is that CSS and TS cannot drift. Read the
    // stylesheet from disk (not through the bundler) and compare.
    const css = readTokensCss();
    for (const [name, cssVar] of Object.entries(LAYOUT_TOKEN_VARS)) {
      const match = new RegExp(`${cssVar}:\\s*(\\d+)px`).exec(css);
      expect(match, `${cssVar} is declared in styles/tokens.css`).not.toBeNull();
      expect(Number(match?.[1])).toBe(LAYOUT_TOKENS[name as keyof typeof LAYOUT_TOKENS]);
    }
  });

  it("declares the rail width inside R1's 80–96 px band", () => {
    const css = readTokensCss();
    const rail = Number(/--layout-rail-width:\s*(\d+)px/.exec(css)?.[1]);
    expect(rail).toBeGreaterThanOrEqual(80);
    expect(rail).toBeLessThanOrEqual(96);
  });
});

// --- the hook -----------------------------------------------------------

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setViewport(1024, 768);
});

describe("useLayoutMode", () => {
  it("reports the mode on the FIRST render and follows a resize", () => {
    const seen: string[] = [];
    function Probe() {
      seen.push(useLayoutMode());
      return null;
    }

    setViewport(360, 640);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(createElement(Probe)));

    // No "wide for one frame, then portrait": the very first value is the
    // measured one.
    expect(seen[0]).toBe("compact-portrait");

    act(() => {
      setViewport(844, 390);
      window.dispatchEvent(new Event("resize"));
    });
    expect(seen[seen.length - 1]).toBe("compact-landscape");

    act(() => {
      setViewport(1280, 900);
      window.dispatchEvent(new Event("orientationchange"));
    });
    expect(seen[seen.length - 1]).toBe("wide");
  });

  it("stops listening once unmounted", () => {
    function Probe() {
      useLayoutMode();
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(createElement(Probe)));
    act(() => root?.unmount());
    root = null;

    // A resize after unmount must not reach a torn-down store subscriber.
    expect(() => {
      setViewport(360, 640);
      window.dispatchEvent(new Event("resize"));
    }).not.toThrow();
  });
});
