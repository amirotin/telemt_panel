// Theme: Системная / Светлая / Тёмная / «Мокко» / «Пергамент», persisted
// per-device (localStorage — 06-ui.md's "per-device" tokens throughout
// apply the same way here). The two warm themes are the owner's 2026-08-30
// pick from v2/design/themes/: «Мокко» is a warm DARK palette and
// «Пергамент» a warm LIGHT one, which is why the colour scheme a theme
// resolves to is a lookup and not "everything that isn't light is dark".
// "system" stores no explicit choice and just follows prefers-color-scheme,
// matching tokens.css's @media block.

// Declaration order is the order the switcher renders (06-ui.md: «Системная
// · Светлая · Тёмная · Мокко · Пергамент»), so a new theme is added in one
// place.
export const THEMES = ["system", "light", "dark", "mocha", "parchment"] as const;

export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = "telemt-panel:theme";

// isTheme is the single validator for anything read back from storage or a
// URL — a name the build no longer ships must fall back, never be written
// into [data-theme] where it would select no palette at all.
export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function getStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isTheme(raw)) return raw;
  } catch {
    // localStorage unavailable (private mode, disabled storage) — fall
    // back to the default rather than throwing during app init.
  }
  return "dark";
}

export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Best-effort — see getStoredTheme.
  }
}

// The light/dark half of each theme: what the browser is told through
// `color-scheme` (index.css) and what «Системная» resolves to at call time.
const COLOR_SCHEME: Record<Exclude<Theme, "system">, "dark" | "light"> = {
  dark: "dark",
  light: "light",
  mocha: "dark",
  parchment: "light",
};

// resolvedColorScheme is what actually paints: "system" resolves through
// the OS preference at call time.
export function resolvedColorScheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return COLOR_SCHEME[theme];
}

// Must track each palette's --bg in styles/tokens.css: the browser paints
// the status bar and the PWA splash with this, and a value that is off by a
// shade shows as a seam above the page.
const THEME_COLOR: Record<Exclude<Theme, "system">, string> = {
  dark: "#12171d",
  light: "#f3f5f8",
  mocha: "#211e1a",
  parchment: "#f3ead9",
};

// themeColor is the <meta name="theme-color"> content for a theme —
// «Системная» borrows the plain dark/light value the OS preference points
// at, every other theme has its own.
export function themeColor(theme: Theme): string {
  return THEME_COLOR[theme === "system" ? resolvedColorScheme(theme) : theme];
}

// applyTheme sets the [data-theme] attribute tokens.css keys off of and
// updates the <meta name="theme-color"> tag so the browser chrome (status
// bar, PWA splash) follows — "system" removes the attribute entirely so
// tokens.css's prefers-color-scheme block takes over.
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }

  const meta = document.getElementById("theme-color-meta");
  if (meta) {
    meta.setAttribute("content", themeColor(theme));
  }
}
