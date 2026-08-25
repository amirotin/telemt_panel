import { useTheme } from "../lib/useTheme";
import { ru, useStrings } from "../i18n";
import { Chip } from "../ui/Chip";
import { SectionLabel } from "../ui/SectionLabel";
import type { Theme } from "../lib/theme";

const OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: "dark", label: ru.theme.dark },
  { value: "light", label: ru.theme.light },
  { value: "system", label: ru.theme.system },
];

// ThemeToggle — the shell-level theme switcher (also reachable from
// Настройки панели). Persists via lib/theme.ts. Rendered as the
// prototype's segmented pill strip rather than a <select>: three fixed
// choices whose effect is instant and visible, so hiding two of them
// behind a dropdown buys nothing.
export function ThemeToggle() {
  const s = useStrings();
  const [theme, setTheme] = useTheme();

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{s.theme.toggle}</SectionLabel>
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={s.theme.toggle}
      >
        {OPTIONS.map((opt) => (
          <Chip
            key={opt.value}
            active={theme === opt.value}
            onClick={() => setTheme(opt.value)}
          >
            {opt.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}
