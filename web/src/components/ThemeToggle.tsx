import { useTheme } from "../lib/useTheme";
import { useStrings } from "../i18n";
import { Chip } from "../ui/Chip";
import { SectionLabel } from "../ui/SectionLabel";
import type { Theme } from "../lib/theme";

// ThemeToggle — the shell-level theme switcher (also reachable from
// Настройки панели). Persists via lib/theme.ts. Rendered as the
// prototype's segmented pill strip rather than a <select>: three fixed
// choices whose effect is instant and visible, so hiding two of them
// behind a dropdown buys nothing.
export function ThemeToggle() {
  const s = useStrings();
  const [theme, setTheme] = useTheme();

  // Built per render rather than as a module constant: the labels come from
  // the ACTIVE dictionary, and a module constant would freeze whichever
  // language happened to be resolved at import time.
  const options: Array<{ value: Theme; label: string }> = [
    { value: "dark", label: s.theme.dark },
    { value: "light", label: s.theme.light },
    { value: "system", label: s.theme.system },
  ];

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
