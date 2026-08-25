import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { Chip } from "../ui/Chip";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { IconPause, IconPlay, IconSearch, IconTrash } from "../ui/icons";
import type { DisplayMode } from "../display-mode/mode";
import { visibleLevelChips, type LogLevel } from "./logFilter.helpers";
import type { LogicalService } from "./types";

const SERVICE_OPTIONS: LogicalService[] = ["telemt", "panel"];

// The level chips carry a dot in the level's own status colour so the strip
// is scannable without painting four differently-tinted pills (the app has
// one chip look — 06-ui.md). error/warn own their colours; info and debug
// read as muted, matching LogLineRow's own level mapping.
const LEVEL_DOT: Record<LogLevel, string> = {
  error: "bg-error",
  warn: "bg-warn",
  info: "bg-text-muted",
  debug: "bg-text-faint",
};

function serviceLabel(service: LogicalService): string {
  return service === "telemt"
    ? ru.journal.source.telemt
    : ru.journal.source.panel;
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
//
// Layout follows the prototype's Журнал artboard: one strip of source
// chips with the pause pill pushed to its right edge, a second strip of
// level chips, then the search field.
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
      <div className="flex items-center gap-1.5">
        {/*
          role="radiogroup" (not a tablist): picking a source swaps which
          stream the page follows, it does not switch between two mounted
          panes.
        */}
        <div
          className="flex min-w-0 flex-wrap items-center gap-1.5"
          role="radiogroup"
          aria-label={ru.journal.sourceLabel}
        >
          {SERVICE_OPTIONS.map((opt) => (
            <Chip
              key={opt}
              role="radio"
              aria-pressed={undefined}
              aria-checked={service === opt}
              active={service === opt}
              onClick={() => onServiceChange(opt)}
            >
              {serviceLabel(opt)}
            </Chip>
          ))}
        </div>

        {onTogglePause && (
          <button
            type="button"
            onClick={onTogglePause}
            className={cn(
              "ml-auto inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full px-3.5",
              "text-xs font-semibold transition-colors",
              paused
                ? "bg-accent/15 text-accent hover:bg-accent/25"
                : "bg-surface-2 text-text hover:bg-surface-3",
            )}
          >
            {paused ? <IconPlay /> : <IconPause />}
            {paused ? ru.journal.resume : ru.journal.pause}
          </button>
        )}
        {onClear && (
          <IconButton
            aria-label={ru.journal.clear}
            onClick={onClear}
            className={cn("shrink-0", !onTogglePause && "ml-auto")}
          >
            <IconTrash />
          </IconButton>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={ru.journal.levelLabel}
      >
        {visibleLevelChips(mode).map((level) => {
          const active = levels.has(level);
          return (
            <Chip
              key={level}
              active={active}
              onClick={() => toggleLevel(level)}
              icon={
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    LEVEL_DOT[level],
                  )}
                />
              }
            >
              {levelLabel(level)}
            </Chip>
          );
        })}
      </div>

      <div className="relative">
        <IconSearch
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[17px] text-text-faint"
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={ru.journal.searchPlaceholder}
          aria-label={ru.journal.searchPlaceholder}
          className="pl-10"
        />
      </div>
    </div>
  );
}
