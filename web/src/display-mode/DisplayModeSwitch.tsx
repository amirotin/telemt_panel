import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { useDisplayMode } from "./DisplayModeContext";
import type { DisplayMode } from "./mode";

const OPTIONS: Array<{ value: DisplayMode; label: string }> = [
  { value: "critical", label: ru.displayMode.critical },
  { value: "basic", label: ru.displayMode.basic },
  { value: "extended", label: ru.displayMode.extended },
];

// DisplayModeSwitch — the compact 3-way segmented control used in the
// header menu (Task 4) and later on Пульс's header / Настройки панели
// (Task 6/8). Always reads/writes through useDisplayMode, never its own
// state, so every instance on screen stays in sync.
export function DisplayModeSwitch({ className }: { className?: string }) {
  const { mode, setMode } = useDisplayMode();

  return (
    <div
      className={cn("inline-flex rounded-lg border border-border bg-surface-2 p-0.5", className)}
      role="radiogroup"
      aria-label={ru.displayMode.label}
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={mode === opt.value}
          onClick={() => setMode(opt.value)}
          className={cn(
            "tap-target rounded-md px-3 text-sm font-medium transition-colors",
            mode === opt.value ? "bg-accent text-accent-text" : "text-text-muted hover:text-text",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
