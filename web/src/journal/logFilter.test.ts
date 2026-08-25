import { describe, expect, it } from "vitest";
import {
  defaultLevelsForMode,
  filterLogLines,
  matchesLogFilter,
  visibleLevelChips,
  windowLogLines,
  type LogLevel,
} from "./logFilter.helpers";
import type { LogLine } from "../lib/api/generated/types.gen";
import type { RingLine } from "./logRing";

function line(overrides: Partial<LogLine> = {}): LogLine {
  return { ts: "2026-08-25T12:00:00Z", level: "info", unit: "telemt.service", msg: "hello world", ...overrides };
}

function ringLine(id: number, overrides: Partial<LogLine> = {}): RingLine {
  return { ...line(overrides), id };
}

const ALL: Set<LogLevel> = new Set(["error", "warn", "info", "debug"]);

describe("defaultLevelsForMode", () => {
  it("critical defaults to error+warn only", () => {
    expect(defaultLevelsForMode("critical")).toEqual(new Set(["error", "warn"]));
  });
  it("basic defaults to error+warn+info", () => {
    expect(defaultLevelsForMode("basic")).toEqual(new Set(["error", "warn", "info"]));
  });
  it("extended defaults to all four levels", () => {
    expect(defaultLevelsForMode("extended")).toEqual(new Set(["error", "warn", "info", "debug"]));
  });
});

describe("visibleLevelChips", () => {
  it("hides the debug chip in critical mode", () => {
    expect(visibleLevelChips("critical")).toEqual(["error", "warn", "info"]);
  });
  it("shows all four chips in basic and extended", () => {
    expect(visibleLevelChips("basic")).toEqual(["error", "warn", "info", "debug"]);
    expect(visibleLevelChips("extended")).toEqual(["error", "warn", "info", "debug"]);
  });
});

describe("matchesLogFilter — level", () => {
  it("excludes a level not in the set", () => {
    expect(matchesLogFilter(line({ level: "debug" }), new Set(["error", "warn"]), "")).toBe(false);
  });
  it("includes a level in the set", () => {
    expect(matchesLogFilter(line({ level: "warn" }), new Set(["error", "warn"]), "")).toBe(true);
  });
  it("a line with no level (or 'unknown') always passes the level filter", () => {
    expect(matchesLogFilter(line({ level: undefined }), new Set(["error"]), "")).toBe(true);
    expect(matchesLogFilter(line({ level: "unknown" }), new Set(["error"]), "")).toBe(true);
  });
});

describe("matchesLogFilter — search", () => {
  it("is case-insensitive over msg", () => {
    expect(matchesLogFilter(line({ msg: "Connection RESET" }), ALL, "reset")).toBe(true);
    expect(matchesLogFilter(line({ msg: "Connection RESET" }), ALL, "RESET")).toBe(true);
  });
  it("matches over unit too", () => {
    expect(matchesLogFilter(line({ unit: "Telemt.Service", msg: "nothing" }), ALL, "telemt.service")).toBe(true);
  });
  it("empty query matches everything (subject to level)", () => {
    expect(matchesLogFilter(line({ msg: "anything" }), ALL, "   ")).toBe(true);
  });
  it("no match returns false", () => {
    expect(matchesLogFilter(line({ msg: "abc", unit: "def" }), ALL, "xyz")).toBe(false);
  });
});

describe("filterLogLines", () => {
  it("applies matchesLogFilter across a list, preserving order", () => {
    const lines = [line({ msg: "a", level: "error" }), line({ msg: "b", level: "debug" }), line({ msg: "c", level: "warn" })];
    const out = filterLogLines(lines, new Set(["error", "warn"]), "");
    expect(out.map((l) => l.msg)).toEqual(["a", "c"]);
  });
});

describe("windowLogLines", () => {
  it("returns everything with hiddenCount 0 when under the window size", () => {
    const lines = [ringLine(1), ringLine(2)];
    expect(windowLogLines(lines, 500)).toEqual({ visible: lines, hiddenCount: 0 });
  });

  it("keeps only the newest windowSize lines and reports how many are hidden", () => {
    const lines = Array.from({ length: 10 }, (_, i) => ringLine(i));
    const { visible, hiddenCount } = windowLogLines(lines, 4);
    expect(hiddenCount).toBe(6);
    expect(visible.map((l) => l.id)).toEqual([6, 7, 8, 9]);
  });
});
