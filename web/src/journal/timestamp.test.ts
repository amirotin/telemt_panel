import { describe, expect, it } from "vitest";
import {
  formatAuditClock,
  formatAuditDay,
  formatAuditTimestamp,
  formatLogClock,
} from "./timestamp.helpers";
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

describe("audit timeline timestamps", () => {
  it("separates the compact clock from its relative day", () => {
    const now = new Date("2026-08-25T18:00:00Z");
    expect(formatAuditClock("2026-08-25T12:34:56Z", s)).toMatch(/^\d{2}:\d{2}$/);
    expect(formatAuditDay("2026-08-25T12:34:56Z", s, now)).toBe(s.journal.actions.today);
    expect(formatAuditDay("2026-08-24T12:34:56Z", s, now)).toBe(s.journal.actions.yesterday);
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
