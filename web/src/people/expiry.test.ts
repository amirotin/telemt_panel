import { describe, expect, it } from "vitest";
import {
  datetimeLocalValueToISO,
  formatDurationApprox,
  isoToDatetimeLocalValue,
  presetToExpiration,
} from "./expiry";

describe("presetToExpiration", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");

  it("adds exactly 7 days for the 7d preset", () => {
    expect(presetToExpiration("7d", now)).toBe("2026-09-01T12:00:00.000Z");
  });

  it("adds exactly 30 days for the 30d preset", () => {
    expect(presetToExpiration("30d", now)).toBe("2026-09-24T12:00:00.000Z");
  });

  it("returns null for the none preset (unlimited)", () => {
    expect(presetToExpiration("none", now)).toBeNull();
  });
});

describe("datetime-local <-> ISO round trip (timezone-safe)", () => {
  it("round-trips a local value back to itself regardless of host timezone", () => {
    // Neither direction reads/assumes a specific timezone — both go through
    // the Date object's own local getters/setters, so this holds under
    // whatever TZ the test runner happens to use.
    const local = "2026-01-15T10:30";
    const iso = datetimeLocalValueToISO(local);
    expect(iso).not.toBeNull();
    expect(isoToDatetimeLocalValue(iso!)).toBe(local);
  });

  it("round-trips a value with a single-digit month/day/hour/minute (zero-padding)", () => {
    const local = "2026-03-05T04:07";
    const iso = datetimeLocalValueToISO(local);
    expect(isoToDatetimeLocalValue(iso!)).toBe(local);
  });

  it("round-trips midnight", () => {
    const local = "2026-12-31T00:00";
    const iso = datetimeLocalValueToISO(local);
    expect(isoToDatetimeLocalValue(iso!)).toBe(local);
  });
});

describe("datetimeLocalValueToISO", () => {
  it("returns null for an empty value", () => {
    expect(datetimeLocalValueToISO("")).toBeNull();
  });
  it("returns null for a garbage value", () => {
    expect(datetimeLocalValueToISO("not-a-date")).toBeNull();
  });
});

describe("isoToDatetimeLocalValue", () => {
  it("returns an empty string for a garbage ISO value", () => {
    expect(isoToDatetimeLocalValue("not-a-date")).toBe("");
  });
});

describe("formatDurationApprox", () => {
  it("renders multi-day durations in days", () => {
    expect(formatDurationApprox(3 * 24 * 60 * 60 * 1000)).toBe("3 дн.");
  });
  it("renders sub-day durations in hours", () => {
    expect(formatDurationApprox(5 * 60 * 60 * 1000)).toBe("5 ч.");
  });
  it("renders sub-hour durations in minutes", () => {
    expect(formatDurationApprox(30 * 60 * 1000)).toBe("30 мин.");
  });
  it("floors to at least 1 minute for a near-zero duration", () => {
    expect(formatDurationApprox(500)).toBe("1 мин.");
  });
  it("treats a negative duration as zero", () => {
    expect(formatDurationApprox(-1000)).toBe("1 мин.");
  });
});
