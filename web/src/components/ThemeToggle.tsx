import { useTheme } from "../lib/useTheme";
import { ru } from "../i18n/ru";
import { Select } from "../ui/Select";
import type { Theme } from "../lib/theme";

const OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: "dark", label: ru.theme.dark },
  { value: "light", label: ru.theme.light },
  { value: "system", label: ru.theme.system },
];

// ThemeToggle — the shell-level theme switcher (also reachable from
// Настройки панели in Task 8). Persists via lib/theme.ts.
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();

  return (
    <label className="flex flex-col gap-1 text-left">
      <span className="text-xs text-text-muted">{ru.theme.toggle}</span>
      <Select
        value={theme}
        onChange={(e) => setTheme(e.target.value as Theme)}
        className="w-40"
      >
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
