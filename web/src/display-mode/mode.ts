// Detail-density modes (06-ui.md "Режимы отображения", owner decision
// 2026-08-25): a single global filter every widget/section/field declares a
// minimum for. `critical < basic < extended` — never affects what actions
// are available, only how much secondary data is shown.
export type DisplayMode = "critical" | "basic" | "extended";

const ORDER: Record<DisplayMode, number> = { critical: 0, basic: 1, extended: 2 };

// Versioned so a future change to the mode set (unlikely, but see the
// other panel preferences' versioning precedent) can invalidate old
// stored values instead of silently misinterpreting them.
const STORAGE_KEY = "telemt-panel:display-mode:v1";
const DEFAULT_MODE: DisplayMode = "basic";

export function isDisplayMode(value: unknown): value is DisplayMode {
  return value === "critical" || value === "basic" || value === "extended";
}

export function getStoredDisplayMode(): DisplayMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isDisplayMode(raw)) return raw;
  } catch {
    // localStorage unavailable (private mode, disabled storage) — fall
    // back to the default rather than throwing during app init.
  }
  return DEFAULT_MODE;
}

export function setStoredDisplayMode(mode: DisplayMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Best-effort — see getStoredDisplayMode.
  }
}

// visibleFor is the ONE filter function every widget/section/field uses
// (06-ui.md: "одна функция, не if-ы по страницам") — true when the current
// mode shows at least as much detail as minMode requires.
export function visibleFor(minMode: DisplayMode, mode: DisplayMode): boolean {
  return ORDER[mode] >= ORDER[minMode];
}
