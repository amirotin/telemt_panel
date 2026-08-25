import { describe, expect, it } from "vitest";
import {
  formatIntervalHours,
  parseIntervalHours,
  serializeAutoUpdateForm,
  toAutoUpdateFormState,
} from "./autoUpdate.helpers";

describe("parseIntervalHours", () => {
  it("parses a plain hour duration", () => {
    expect(parseIntervalHours("6h")).toBe(6);
    expect(parseIntervalHours("24h")).toBe(24);
    expect(parseIntervalHours("1h")).toBe(1);
  });

  it("falls back to the default for garbage input", () => {
    expect(parseIntervalHours("not-a-duration")).toBe(6);
    expect(parseIntervalHours("")).toBe(6);
  });

  it("falls back for a sub-hour or zero duration this form doesn't support", () => {
    expect(parseIntervalHours("30m")).toBe(6);
    expect(parseIntervalHours("0h")).toBe(6);
  });

  it("honors a custom fallback", () => {
    expect(parseIntervalHours("garbage", 12)).toBe(12);
  });
});

describe("formatIntervalHours", () => {
  it("formats whole hours", () => {
    expect(formatIntervalHours(6)).toBe("6h");
  });

  it("rounds a fractional value", () => {
    expect(formatIntervalHours(6.7)).toBe("7h");
  });

  it("floors at 1h", () => {
    expect(formatIntervalHours(0)).toBe("1h");
    expect(formatIntervalHours(-5)).toBe("1h");
  });
});

describe("toAutoUpdateFormState / serializeAutoUpdateForm round trip", () => {
  it("round-trips a typical settings object", () => {
    const settings = { telemt: "check" as const, panel: "off" as const, interval: "12h" };
    const form = toAutoUpdateFormState(settings);
    expect(form).toEqual({ telemt: "check", panel: "off", intervalHours: 12 });
    expect(serializeAutoUpdateForm(form)).toEqual(settings);
  });

  it("serializes an apply/apply form", () => {
    expect(serializeAutoUpdateForm({ telemt: "apply", panel: "apply", intervalHours: 1 })).toEqual({
      telemt: "apply",
      panel: "apply",
      interval: "1h",
    });
  });
});
