import { useStrings, type Dict } from "../i18n";
import { formatLogClock } from "./timestamp.helpers";
import type { RingLine } from "./logRing";

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

export interface LogLineRowProps {
  line: RingLine;
  showUnit: boolean;
}

// One DOM order supports both layouts: a compact table on wide screens and
// a full-width message card with a secondary metadata row on phones.
export function LogLineRow({ line, showUnit }: LogLineRowProps) {
  const s = useStrings();
  const level = line.level ?? "unknown";

  return (
    <div className={`journal-log-row level-${level} ${showUnit ? "has-unit" : ""}`}>
      <time dateTime={line.ts}>{formatLogClock(line.ts, s)}</time>
      <span className="journal-log-level"><i aria-hidden="true" />{levelLabel(line.level, s)}</span>
      {showUnit && <code title={line.unit}>{line.unit || "—"}</code>}
      <span className="journal-log-message">{line.msg}</span>
    </div>
  );
}
