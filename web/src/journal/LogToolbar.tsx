import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import type { DisplayMode } from "../display-mode/mode";
import { visibleLevelChips, type LogLevel } from "./logFilter.helpers";
import type { LogicalService } from "./types";

const SERVICE_OPTIONS: LogicalService[] = ["telemt", "panel"];

function serviceLabel(service: LogicalService): string {
  return service === "telemt" ? ru.journal.source.telemt : ru.journal.source.panel;
}

function levelLabel(level: LogLevel): string {
  return ru.journal.level[level];
}

export interface LogToolbarProps {
  service: LogicalService;
  onServiceChange: (service: LogicalService) => void;
  levels: Set<LogLevel>;
  onLevelsChange: (levels: Set<LogLevel>) => void;
  mode: DisplayMode;
  search: string;
  onSearchChange: (search: string) => void;
  /** Omitted entirely for the tail-only fallback — there's no live buffer to pause. */
  paused?: boolean;
  onTogglePause?: () => void;
  onClear?: () => void;
}

// LogToolbar — the Logs tab's header row: source switch + level chips +
// search + pause/clear (Task 7 deliverable A). Shared between the live
// stream viewer and the tail-only fallback, which is why pause is optional.
export function LogToolbar({
  service,
  onServiceChange,
  levels,
  onLevelsChange,
  mode,
  search,
  onSearchChange,
  paused,
  onTogglePause,
  onClear,
}: LogToolbarProps) {
  function toggleLevel(level: LogLevel) {
    const next = new Set(levels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    onLevelsChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex rounded-lg border border-border bg-surface-2 p-0.5"
          role="radiogroup"
          aria-label={ru.journal.sourceLabel}
        >
          {SERVICE_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={service === opt}
              onClick={() => onServiceChange(opt)}
              className={cn(
                "tap-target rounded-md px-3 text-sm font-medium transition-colors",
                service === opt ? "bg-accent text-accent-text" : "text-text-muted hover:text-text",
              )}
            >
              {serviceLabel(opt)}
            </button>
          ))}
        </div>

        {onTogglePause && (
          <Button variant="secondary" onClick={onTogglePause}>
            {paused ? ru.journal.resume : ru.journal.pause}
          </Button>
        )}
        {onClear && (
          <Button variant="ghost" onClick={onClear}>
            {ru.journal.clear}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={ru.journal.levelLabel}>
        {visibleLevelChips(mode).map((level) => {
          const active = levels.has(level);
          return (
            <button
              key={level}
              type="button"
              aria-pressed={active}
              onClick={() => toggleLevel(level)}
              className={cn(
                "tap-target rounded-full border px-3 text-xs font-medium transition-colors",
                active
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-border text-text-muted hover:text-text",
              )}
            >
              {levelLabel(level)}
            </button>
          );
        })}
      </div>

      <Input
        type="search"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={ru.journal.searchPlaceholder}
        aria-label={ru.journal.searchPlaceholder}
      />
    </div>
  );
}
