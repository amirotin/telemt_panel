import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./ThemeToggle";
import { setLocalePreference } from "../i18n/store";

// The switcher is rendered in two places (Настройки панели and the header
// menu) from this one component, so these assertions cover both. What they
// pin: the five choices 06-ui.md names, in its order, in both languages,
// and that a click reaches the three things a theme has to change — the
// [data-theme] attribute, the persisted preference and the theme-color
// meta the browser chrome reads.

const STORAGE_KEY = "telemt-panel:theme";

let mounted: { container: HTMLElement; root: Root } | null = null;

function renderToggle(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<ThemeToggle />));
  mounted = { container, root };
  return container;
}

function chips(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  localStorage.removeItem(STORAGE_KEY);
  document.documentElement.removeAttribute("data-theme");
  document.getElementById("theme-color-meta")?.remove();
  act(() => setLocalePreference("ru"));
});

describe("ThemeToggle", () => {
  it("offers the five themes in the spec's order and marks the active one", () => {
    localStorage.setItem(STORAGE_KEY, "mocha");
    const container = renderToggle();
    expect(chips(container).map((b) => b.textContent)).toEqual([
      "Системная",
      "Светлая",
      "Тёмная",
      "Мокко",
      "Пергамент",
    ]);
    expect(chips(container).map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
      "true",
      "false",
    ]);
  });

  it("names the warm themes in English too", () => {
    act(() => setLocalePreference("en"));
    const container = renderToggle();
    expect(chips(container).map((b) => b.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
      "Mocha",
      "Parchment",
    ]);
  });

  it("applies, persists and announces «Пергамент»", () => {
    const meta = document.createElement("meta");
    meta.id = "theme-color-meta";
    document.head.append(meta);

    const container = renderToggle();
    act(() => chips(container)[4]!.click());

    expect(localStorage.getItem(STORAGE_KEY)).toBe("parchment");
    expect(document.documentElement.getAttribute("data-theme")).toBe("parchment");
    expect(meta.getAttribute("content")).toBe("#f3ead9");
    expect(chips(container)[4]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("applies «Мокко» and hands the attribute back on «Системная»", () => {
    const container = renderToggle();

    act(() => chips(container)[3]!.click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("mocha");

    act(() => chips(container)[0]!.click());
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("system");
  });
});
