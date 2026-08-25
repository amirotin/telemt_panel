import { describe, expect, it } from "vitest";
import { formatBytes } from "./format";

describe("formatBytes", () => {
  it("renders sub-kilobyte values in bytes", () => {
    expect(formatBytes(512)).toBe("512 Б");
  });

  it("picks the largest unit under 1024 and keeps a decimal below 10", () => {
    expect(formatBytes(1536)).toBe("1.5 КБ");
  });

  it("drops the decimal at 10 or more of a unit", () => {
    expect(formatBytes(10 * 1024)).toBe("10 КБ");
  });

  it("scales up through GB", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 ГБ");
  });
});
