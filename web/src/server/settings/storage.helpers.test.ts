import { describe, expect, it } from "vitest";
import type { StoragePolicy } from "../../lib/api/generated/types.gen";
import { applyStorageProfile, detectStorageProfile, sameStoragePolicies } from "./storage.helpers";

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

describe("storage profiles", () => {
  it("keeps IP collection enabled in every profile", () => {
    for (const profile of ["minimum", "recommended", "extended"] as const) {
      expect(applyStorageProfile(defaults, profile).find((p) => p.category === "user_ip_history")?.enabled).toBe(true);
    }
  });
  it("keeps mandatory technical history in every profile", () => {
    for (const profile of ["minimum", "recommended", "extended"] as const) {
      const technical = applyStorageProfile(defaults, profile).find(
        (policy) => policy.category === "technical",
      );
      expect(technical).toEqual({
        category: "technical",
        enabled: true,
        retention_days: 7,
      });
    }
  });

  it("enables demanded per-user history in the recommended profile", () => {
    const recommended = applyStorageProfile(defaults, "recommended");
    expect(recommended.find((policy) => policy.category === "traffic")?.enabled).toBe(true);
    expect(recommended.find((policy) => policy.category === "user_traffic")?.enabled).toBe(true);
  });

  it("detects a custom retention change", () => {
    const changed = defaults.map((policy) =>
      policy.category === "audit" ? { ...policy, retention_days: 180 } : policy,
    );
    expect(detectStorageProfile(defaults)).toBe("recommended");
    expect(detectStorageProfile(changed)).toBe("custom");
    expect(sameStoragePolicies(defaults, changed)).toBe(false);
  });
});
