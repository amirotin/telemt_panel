import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { StatePill, type State } from "../ui/StatePill";
import { formatLogClock } from "./timestamp.helpers";
import type { RingLine } from "./logRing";

// levelPillState maps a LogLine.level to the app's one status vocabulary
// (06-ui.md: "один набор семантики статусов ok|warn|error|muted") — only
// error/warn get their own color, everything else (info/debug/unknown)
// reads as muted so the feed isn't a wall of color.
function levelPillState(level: string | undefined): State {
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  return "muted";
}

function levelLabel(level: string | undefined): string {
  switch (level) {
    case "error":
      return ru.journal.level.error;
    case "warn":
      return ru.journal.level.warn;
    case "info":
      return ru.journal.level.info;
    case "debug":
      return ru.journal.level.debug;
    default:
      return ru.journal.unknownLevel;
  }
}

export interface LogLineRowProps {
  line: RingLine;
  /** extended mode shows the source unit (LogLine.unit) — Task 7 deliverable C. */
  showUnit: boolean;
}

export function LogLineRow({ line, showUnit }: LogLineRowProps) {
  return (
    <div className="flex items-baseline gap-2 border-b border-border/50 py-1 font-mono text-xs leading-relaxed break-all last:border-b-0">
      <span className="shrink-0 tabular-nums text-text-faint">{formatLogClock(line.ts)}</span>
      <StatePill state={levelPillState(line.level)} className="shrink-0">
        {levelLabel(line.level)}
      </StatePill>
      {showUnit && line.unit && (
        <span className="shrink-0 truncate text-text-faint" title={line.unit}>
          {line.unit}
        </span>
      )}
      <span className={cn("min-w-0 flex-1 text-text")}>{line.msg}</span>
    </div>
  );
}
