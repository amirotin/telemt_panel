import { describe, expect, it } from "vitest";
import { isUnlimitedQuota, quotaFillClass, quotaRatio } from "./quota.helpers";

const GB = 1024 ** 3;

describe("isUnlimitedQuota", () => {
  it("treats a missing limit as unlimited", () => {
    expect(isUnlimitedQuota(null)).toBe(true);
    expect(isUnlimitedQuota(undefined)).toBe(true);
  });

  it("treats a zero or negative limit as unlimited, not as exhausted", () => {
    // Telemt writes data_quota_bytes: 0 for a user with no cap — painting
    // that as a full red bar would report every uncapped user as over quota.
    expect(isUnlimitedQuota(0)).toBe(true);
    expect(isUnlimitedQuota(-1)).toBe(true);
  });

  it("treats a real limit as limited", () => {
    expect(isUnlimitedQuota(1)).toBe(false);
    expect(isUnlimitedQuota(50 * GB)).toBe(false);
  });
});

describe("quotaRatio", () => {
  it("fills the bar for an unlimited quota", () => {
    expect(quotaRatio(3 * GB, null)).toBe(1);
    expect(quotaRatio(3 * GB, 0)).toBe(1);
  });

  it("is the plain fraction under the limit", () => {
    expect(quotaRatio(25 * GB, 50 * GB)).toBe(0.5);
  });

  it("clamps at both ends", () => {
    expect(quotaRatio(80 * GB, 50 * GB)).toBe(1);
    expect(quotaRatio(-5, 50 * GB)).toBe(0);
  });
});

describe("quotaFillClass", () => {
  it("never warns about an unlimited quota", () => {
    expect(quotaFillClass(1, true)).toBe("bg-accent");
  });

  it("switches to amber at exactly 80%", () => {
    expect(quotaFillClass(0.79, false)).toBe("bg-accent");
    expect(quotaFillClass(0.8, false)).toBe("bg-warn");
    expect(quotaFillClass(0.99, false)).toBe("bg-warn");
  });

  it("switches to the exhausted red at exactly 100%", () => {
    expect(quotaFillClass(1, false)).toBe("bg-error-strong");
    expect(quotaFillClass(1.5, false)).toBe("bg-error-strong");
  });
});
