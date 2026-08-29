import { useTheme } from "../lib/useTheme";
import { useStrings } from "../i18n";
import { Chip } from "../ui/Chip";
import { SectionLabel } from "../ui/SectionLabel";
import { THEMES, type Theme } from "../lib/theme";

// ThemeToggle — the shell-level theme switcher (also reachable from
// Настройки панели). Persists via lib/theme.ts. Rendered as the
// prototype's segmented pill strip rather than a <select>: the choices are
// few and each one's effect is instant and visible on the very screen the
// strip sits on, so hiding four of them behind a dropdown buys nothing.
export function ThemeToggle() {
  const s = useStrings();
  const [theme, setTheme] = useTheme();

  // Built per render rather than as a module constant: the labels come from
  // the ACTIVE dictionary, and a module constant would freeze whichever
  // language happened to be resolved at import time. The ORDER is THEMES'
  // own (06-ui.md: «Системная · Светлая · Тёмная · Мокко · Пергамент»), so
  // adding a theme never means editing this file.
  const options: Array<{ value: Theme; label: string }> = THEMES.map((value) => ({
    value,
    label: s.theme[value],
  }));

  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{s.theme.toggle}</SectionLabel>
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={s.theme.toggle}
      >
        {options.map((opt) => (
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
