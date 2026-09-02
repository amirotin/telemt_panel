import { cn } from "../lib/cn";
import { useStrings, type Dict } from "../i18n";
import { IconButton } from "../ui/IconButton";
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

function serviceLabel(service: LogicalService, s: Dict): string {
  return service === "telemt" ? s.journal.source.telemt : s.journal.source.panel;
}

function levelLabel(level: LogLevel, s: Dict): string {
  return s.journal.level[level];
}

export interface LogToolbarProps {
  service: LogicalService;
  onServiceChange: (service: LogicalService) => void;
  levels: Set<LogLevel>;
  onLevelsChange: (levels: Set<LogLevel>) => void;
  mode: DisplayMode;
  search: string;
  onSearchChange: (search: string) => void;
  sourceName?: string;
  levelCounts?: Partial<Record<LogLevel, number>>;
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
  sourceName,
  levelCounts,
  paused,
  onTogglePause,
  onClear,
}: LogToolbarProps) {
  const s = useStrings();
  function toggleLevel(level: LogLevel) {
    const next = new Set(levels);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    onLevelsChange(next);
  }

  return (
    <div className="journal-log-toolbar">
      <div className="journal-commandbar">
        {/*
          role="radiogroup" (not a tablist): picking a source swaps which
          stream the page follows, it does not switch between two mounted
          panes.
        */}
        <div
          className="journal-service-switch"
          role="radiogroup"
          aria-label={s.journal.sourceLabel}
        >
          {SERVICE_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={service === opt}
              className={service === opt ? "is-active" : undefined}
              onClick={() => onServiceChange(opt)}
            >
              {opt === "telemt" && <i aria-hidden="true" />}
              {serviceLabel(opt, s)}
            </button>
          ))}
        </div>

        {sourceName && (
          <div className="journal-source-note">
            <span>{sourceName}</span>
            {onTogglePause && <b>{s.journal.liveTail}</b>}
          </div>
        )}

        <div className="journal-stream-actions">
          {onTogglePause && (
            <button
              type="button"
              onClick={onTogglePause}
              className={cn("journal-pause", paused && "is-active")}
            >
              {paused ? <IconPlay /> : <IconPause />}
              <span>{paused ? s.journal.resume : s.journal.pause}</span>
            </button>
          )}
          {onClear && (
            <IconButton
              aria-label={s.journal.clear}
              onClick={onClear}
              className="journal-clear"
            >
              <IconTrash />
            </IconButton>
          )}
        </div>
      </div>

      <div className="journal-filterbar">
        <label className="journal-search-control">
          <IconSearch aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={s.journal.searchPlaceholder}
            aria-label={s.journal.searchPlaceholder}
          />
        </label>
        <div className="journal-levels" role="group" aria-label={s.journal.levelLabel}>
          {visibleLevelChips(mode).map((level) => {
            const active = levels.has(level);
            return (
              <button
                key={level}
                type="button"
                className={cn(`tone-${level}`, active && "is-active")}
                aria-pressed={active}
                onClick={() => toggleLevel(level)}
              >
                <i aria-hidden="true" className={LEVEL_DOT[level]} />
                {levelLabel(level, s)}
                {levelCounts?.[level] !== undefined && <b>{levelCounts[level]}</b>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
