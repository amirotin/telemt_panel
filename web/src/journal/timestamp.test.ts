import { describe, expect, it } from "vitest";
import { formatAuditTimestamp, formatLogClock } from "./timestamp.helpers";
import { ru as s } from "../i18n";

// Assertions use shape (regex), not an exact string — the formatted value
// depends on the test runner's local timezone, which this suite doesn't
// control or need to.

describe("formatLogClock", () => {
  it("renders a tabular HH:MM:SS clock", () => {
    expect(formatLogClock("2026-08-25T12:34:56Z", s)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("falls back to the raw string for an unparseable ts", () => {
    expect(formatLogClock("not-a-date", s)).toBe("not-a-date");
  });
});

describe("formatAuditTimestamp", () => {
  it("renders day.month plus a clock", () => {
    expect(formatAuditTimestamp("2026-08-25T12:34:56Z", s)).toMatch(/^\d{2}\.\d{2},?\s+\d{2}:\d{2}:\d{2}$/);
  });

  it("falls back to the raw string for an unparseable ts", () => {
    expect(formatAuditTimestamp("not-a-date", s)).toBe("not-a-date");
  });
});
