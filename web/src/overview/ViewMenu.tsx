import { useDisplayMode, type DisplayMode } from "../display-mode";
import { fill, useStrings } from "../i18n";
import { Popover } from "../ui/Popover";
import { IconCheck, IconEye } from "../ui/icons";
import { cn } from "../lib/cn";

// The two modes the dashboard OFFERS. `critical` still exists in the model
// (display-mode/mode.ts, and widgets still declare it as a minMode), but it
// is not a viewing preference: criticality is a state of the service, and a
// problem must surface on its own rather than behind a mode the reader has
// to remember to switch on. A layout stored under the old `critical` value
// therefore reads as Стандартный here and moves to `basic` the moment the
// reader picks anything.
const OFFERED: readonly DisplayMode[] = ["basic", "extended"];

const ITEM_CLASSES =
  "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2";

// ViewMenu — the «Вид» control at the right of Сводка's title: detail level,
// the layout editor and the reset, in one dropdown. It replaces the
// three-chip segmented strip that used to sit under the title and outweigh
// it — a permanent row of controls for a setting changed once a month.
export function ViewMenu({
  onConfigure,
  onReset,
  className,
}: {
  onConfigure: () => void;
  onReset: () => void;
  className?: string;
}) {
  const s = useStrings();
  const { mode, setMode } = useDisplayMode();
  const current: DisplayMode = mode === "extended" ? "extended" : "basic";
  const names: Record<DisplayMode, string> = {
    critical: s.displayMode.basic,
    basic: s.displayMode.basic,
    extended: s.displayMode.extended,
  };
  const hints: Record<DisplayMode, string> = {
    critical: s.displayMode.hint.basic,
    basic: s.displayMode.hint.basic,
    extended: s.displayMode.hint.extended,
  };

  return (
    <Popover
      className={className}
      label={fill(s.overview.viewLabel, { mode: names[current] })}
      icon={<IconEye className="h-4 w-4" />}
    >
      <div className="flex flex-col">
        <div role="radiogroup" aria-label={s.displayMode.label} className="flex flex-col">
          {OFFERED.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={current === value}
              onClick={() => setMode(value)}
              className={ITEM_CLASSES}
            >
              <IconCheck
                aria-hidden="true"
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0 text-accent",
                  current !== value && "invisible",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-row font-semibold text-text">{names[value]}</span>
                <span className="block text-micro text-text-muted">{hints[value]}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="my-1.5 h-px shrink-0 bg-border" aria-hidden="true" />

        <button
          type="button"
          onClick={onConfigure}
          className={cn(ITEM_CLASSES, "text-row text-text")}
        >
          {s.overview.configureBlocks}
        </button>
        <button
          type="button"
          onClick={onReset}
          className={cn(ITEM_CLASSES, "text-row text-text-muted")}
        >
          {s.pulse.reset}
        </button>
      </div>
    </Popover>
  );
}
