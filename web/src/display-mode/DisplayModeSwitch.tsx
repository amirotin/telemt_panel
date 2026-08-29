import { cn } from "../lib/cn";
import { useStrings } from "../i18n";
import { Chip } from "../ui/Chip";
import { useDisplayMode } from "./DisplayModeContext";
import type { DisplayMode } from "./mode";

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

  // See ThemeToggle: the labels come from the active dictionary, so this
  // cannot be a module constant.
  // Two options, not three: «Критично» is gone from the UI (concept §16 —
  // criticality is a state of the service, not a viewing preference). The
  // mode itself survives in the model, and a device still holding it reads
  // as Стандартный here until the reader picks something.
  const options: Array<{ value: DisplayMode; label: string }> = [
    { value: "basic", label: s.displayMode.basic },
    { value: "extended", label: s.displayMode.extended },
  ];

  return (
    <div
      className={cn("inline-flex gap-1.5", className)}
      role="radiogroup"
      aria-label={s.displayMode.label}
    >
      {options.map((opt) => (
        <Chip
          key={opt.value}
          role="radio"
          aria-checked={mode === opt.value || (opt.value === "basic" && mode === "critical")}
          aria-pressed={undefined}
          active={mode === opt.value || (opt.value === "basic" && mode === "critical")}
          onClick={() => setMode(opt.value)}
        >
          {opt.label}
        </Chip>
      ))}
    </div>
  );
}
