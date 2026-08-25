import type { Dict } from "../i18n";

// formatBytes renders a byte count the way quotas/traffic are shown
// throughout the app: binary units (1024-based), the active language's unit
// abbreviations, one decimal place under 10 of a unit, none above.
export function formatBytes(n: number, s: Dict): string {
  const units = s.ui.byteUnits;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
