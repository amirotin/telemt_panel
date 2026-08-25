import { cn } from "../lib/cn";
import { useStrings, type Dict } from "../i18n";
import { gridColumnsClass } from "./logColumns";
import { formatLogClock } from "./timestamp.helpers";
import type { RingLine } from "./logRing";

// LogTone maps a LogLine.level onto the app's one status vocabulary
// (06-ui.md: "один набор семантики статусов ok|warn|error|muted") — only
// error/warn get their own colour, everything else (info/debug/unknown)
// reads as muted so the feed isn't a wall of colour. Matches the
// prototype's own lvSty table.
type LogTone = "error" | "warn" | "muted";

function levelTone(level: string | undefined): LogTone {
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  return "muted";
}

// Narrow ("bubble") tint — the prototype fills a warn/error bubble with a
// 10% wash and a matching hairline; info stays on the plain surface. At
// `lg:` the bubble flattens into a table row, so the fill is dropped.
const BUBBLE_CLASSES: Record<LogTone, string> = {
  error: "border-error/35 bg-error/10 lg:bg-transparent",
  warn: "border-warn/30 bg-warn/10 lg:bg-transparent",
  muted: "border-border bg-surface lg:bg-transparent",
};

const LEVEL_TEXT_CLASSES: Record<LogTone, string> = {
  error: "text-error",
  warn: "text-warn",
  muted: "text-text-muted",
};

function levelLabel(level: string | undefined, s: Dict): string {
  switch (level) {
    case "error":
      return s.journal.level.error;
    case "warn":
      return s.journal.level.warn;
    case "info":
      return s.journal.level.info;
    case "debug":
      return s.journal.level.debug;
    default:
      return s.journal.unknownLevel;
  }
}

// Separator — the "·" between the fields of the narrow layout's meta line.
// Hidden at `lg:`, where display:none also drops it out of the grid.
//
// `orderClass` is required rather than defaulted-and-overridden: cn() is a
// plain joiner (no tailwind-merge), so two `order-*` classes on one element
// would both survive and let stylesheet order pick the winner.
function Separator({ orderClass }: { orderClass: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("text-[10px] text-text-faint lg:hidden", orderClass)}
    >
      ·
    </span>
  );
}

export interface LogLineRowProps {
  line: RingLine;
  /** extended mode shows the source unit (LogLine.unit) — Task 7 deliverable C. */
  showUnit: boolean;
}

// LogLineRow renders both of the prototype's log layouts from one DOM tree
// rather than two conditionally-mounted subtrees: below `lg:` it is a
// left-tailed chat bubble (message first, then a "время · УРОВЕНЬ · юнит"
// meta line), and at `lg:` the same four cells fall into the artboard's
// 82px/64px/1fr table grid. The flex `order-*` classes only take effect in
// the narrow flex layout — CSS grid places by DOM order, which is already
// the desktop column order — so no JS breakpoint check is needed and a
// 500-line feed is never rendered twice.
export function LogLineRow({ line, showUnit }: LogLineRowProps) {
  const s = useStrings();
  const tone = levelTone(line.level);

  return (
    <div
      className={cn(
        "flex max-w-[88%] flex-wrap items-baseline gap-x-2 self-start",
        "rounded-[12px_12px_12px_4px] border px-3 py-2",
        "lg:grid lg:max-w-none lg:items-baseline lg:gap-x-2.5 lg:self-stretch",
        "lg:rounded-none lg:border-0 lg:border-b lg:border-border lg:px-3.5 lg:py-1.5",
        "lg:hover:bg-surface",
        gridColumnsClass(showUnit),
        BUBBLE_CLASSES[tone],
      )}
    >
      <span className="order-2 font-mono text-[10px] tabular-nums text-text-faint lg:order-none lg:text-[11px]">
        {formatLogClock(line.ts, s)}
      </span>
      {/*
        The "·" separators belong to the narrow meta line only — the table
        grid separates its cells with real gutters. They are real elements
        rather than ::before content because `display:none` at `lg:` also
        removes them from the grid's flow, which is exactly what's needed;
        a pseudo-element would have to be un-set instead.
      */}
      <Separator orderClass="order-3" />
      <span
        className={cn(
          "order-4 font-mono text-[10px] font-semibold uppercase lg:order-none lg:text-[10.5px]",
          // A grid item's min-width is auto, so without this the longest
          // label would push the message column rather than clip.
          "lg:min-w-0 lg:truncate",
          LEVEL_TEXT_CLASSES[tone],
        )}
      >
        {levelLabel(line.level, s)}
      </span>
      {/*
        Rendered whenever the unit column exists, even for a line that has
        no unit: the `lg:` grid template is chosen from `showUnit` alone, so
        skipping the cell here would slide the message into the unit column
        and misalign that row against the header. The separator is what
        drops out instead.
      */}
      {showUnit && (
        <>
          {line.unit && <Separator orderClass="order-5" />}
          <span
            className="order-6 min-w-0 truncate font-mono text-[10px] text-text-faint lg:order-none lg:text-[11px]"
            title={line.unit}
          >
            {line.unit}
          </span>
        </>
      )}
      <span
        className={cn(
          "order-1 w-full min-w-0 font-mono text-[11px] leading-relaxed break-all",
          "lg:order-none lg:w-auto lg:text-[11.5px] lg:text-text",
          LEVEL_TEXT_CLASSES[tone],
        )}
      >
        {line.msg}
      </span>
    </div>
  );
}
