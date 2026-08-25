// Theme: dark (default) / light / system, persisted per-device
// (localStorage — 06-ui.md's "per-device" tokens throughout apply the same
// way here). "system" stores no explicit choice and just follows
// prefers-color-scheme, matching tokens.css's @media block.
export type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "telemt-panel:theme";

export function getStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
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

// resolvedColorScheme is what actually paints: "system" resolves through
// the OS preference at call time.
function resolvedColorScheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return theme;
}

// Must track --bg in styles/tokens.css: the browser paints the status bar
// and the PWA splash with this, and a value that is off by a shade shows
// as a seam above the page.
const THEME_COLOR = { dark: "#12171d", light: "#f3f5f8" } as const;

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
    meta.setAttribute("content", THEME_COLOR[resolvedColorScheme(theme)]);
  }
}
