import { describe, expect, it } from "vitest";
import type { StoragePolicy } from "../../lib/api/generated/types.gen";
import { sameStoragePolicies, retentionReductions } from "./storage.helpers";

const defaults: StoragePolicy[] = [
  { category: "technical", enabled: true, retention_days: 7 },
  { category: "events", enabled: true, retention_days: 30 },
  { category: "audit", enabled: true, retention_days: 90 },
  { category: "connection_issues", enabled: true, retention_days: 14 },
  { category: "traffic", enabled: true, retention_days: 7 },
  { category: "user_traffic", enabled: true, retention_days: 365 },
  { category: "user_ip_history", enabled: true, retention_days: 30 },
  { category: "diagnostics", enabled: false, retention_days: 7 },
];

describe("independent history policies", () => {
  it("identifies only the categories whose retention is shortened", () => {
    const next = defaults.map((p) => p.category === "connection_issues" ? { ...p, retention_days: 7 } : p);
    expect(retentionReductions(defaults, next)).toEqual([next.find((p) => p.category === "connection_issues")]);
    expect(retentionReductions(next, defaults)).toEqual([]);
  });
  it("detects a custom retention change", () => {
    const changed = defaults.map((policy) =>
      policy.category === "audit" ? { ...policy, retention_days: 180 } : policy,
    );
    expect(sameStoragePolicies(defaults, defaults)).toBe(true);
    expect(sameStoragePolicies(defaults, changed)).toBe(false);
  });
});
