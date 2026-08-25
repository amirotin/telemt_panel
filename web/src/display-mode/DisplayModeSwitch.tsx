import { cn } from "../lib/cn";
import { ru, useStrings } from "../i18n";
import { Chip } from "../ui/Chip";
import { useDisplayMode } from "./DisplayModeContext";
import type { DisplayMode } from "./mode";

const OPTIONS: Array<{ value: DisplayMode; label: string }> = [
  { value: "critical", label: ru.displayMode.critical },
  { value: "basic", label: ru.displayMode.basic },
  { value: "extended", label: ru.displayMode.extended },
];

// DisplayModeSwitch — the compact 3-way segmented control used in the
// header menu (Task 4) and on Пульс's header. Always reads/writes through
// useDisplayMode, never its own state, so every instance on screen stays in
// sync.
//
// Visually it's the prototype's pill strip, so it renders through `Chip`
// like every other segmented control in the app. Chip defaults to a toggle
// button (`aria-pressed`); a radiogroup member must expose `aria-checked`
// instead, so `aria-pressed={undefined}` is passed deliberately — Chip
// spreads the rest props last, which drops the attribute.
export function DisplayModeSwitch({ className }: { className?: string }) {
  const s = useStrings();
  const { mode, setMode } = useDisplayMode();

  return (
    <div
      className={cn("inline-flex gap-1.5", className)}
      role="radiogroup"
      aria-label={s.displayMode.label}
    >
      {OPTIONS.map((opt) => (
        <Chip
          key={opt.value}
          role="radio"
          aria-checked={mode === opt.value}
          aria-pressed={undefined}
          active={mode === opt.value}
          onClick={() => setMode(opt.value)}
        >
          {opt.label}
        </Chip>
      ))}
    </div>
  );
}
