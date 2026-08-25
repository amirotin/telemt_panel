import type { DisplayMode } from "../display-mode/mode";
import type { LogLine } from "../lib/api/generated/types.gen";
import type { RingLine } from "./logRing";

// LogLevel is the panel's selectable filter vocabulary — LogLine.level's
// wire enum also includes "unknown" (01-host-matrix.md/openapi.yaml), but
// that's not a chip a user can toggle: a line with no level (or a level the
// host layer couldn't classify) always passes the level filter and is
// rendered as `muted`, matching LogLineRow's StatePill mapping.
export type LogLevel = "error" | "warn" | "info" | "debug";

const ALL_LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];

// defaultLevelsForMode — the level filter's initial selection per display
// mode (06-ui.md "Режимы отображения" + Task 7 brief C): critical/basic
// start narrower, extended shows everything. The user can still widen the
// selection via the chips that ARE visible in a given mode (see
// visibleLevelChips) — only "debug" is actually hidden in critical.
export function defaultLevelsForMode(mode: DisplayMode): Set<LogLevel> {
  if (mode === "critical") return new Set(["error", "warn"]);
  if (mode === "basic") return new Set(["error", "warn", "info"]);
  return new Set(ALL_LEVELS);
}

// visibleLevelChips — which level chips the toolbar renders at all. Only
// "debug" is dropped in critical mode (Task 7 brief C: "critical ... hides
// debug chip"); info/warn/error stay available so the admin can still widen
// the filter within a mode's density budget.
export function visibleLevelChips(mode: DisplayMode): LogLevel[] {
  if (mode === "critical") return ["error", "warn", "info"];
  return ALL_LEVELS;
}

function normalizedLevel(line: LogLine): LogLevel | "unknown" {
  return (line.level ?? "unknown") as LogLevel | "unknown";
}

// matchesLogFilter — the one predicate the level chips + search box compile
// down to. Search is case-insensitive over msg and unit (Task 7 brief A).
export function matchesLogFilter(line: LogLine, levels: Set<LogLevel>, query: string): boolean {
  const level = normalizedLevel(line);
  if (level !== "unknown" && !levels.has(level)) return false;

  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const msg = line.msg?.toLowerCase() ?? "";
  const unit = line.unit?.toLowerCase() ?? "";
  return msg.includes(q) || unit.includes(q);
}

export function filterLogLines<T extends LogLine>(lines: T[], levels: Set<LogLevel>, query: string): T[] {
  return lines.filter((l) => matchesLogFilter(l, levels, query));
}

export interface WindowedLogs {
  visible: RingLine[];
  hiddenCount: number;
}

// windowLogLines implements the brief's "keep it simple" virtualization:
// only the newest `windowSize` filtered lines render; `hiddenCount` drives
// the "показать раньше" control instead of pulling in a virtualization
// dependency for a 500-2000 line list.
export function windowLogLines(filtered: RingLine[], windowSize: number): WindowedLogs {
  if (filtered.length <= windowSize) return { visible: filtered, hiddenCount: 0 };
  return { visible: filtered.slice(filtered.length - windowSize), hiddenCount: filtered.length - windowSize };
}
