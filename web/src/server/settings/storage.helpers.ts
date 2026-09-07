import type { StorageCategory, StoragePolicy } from "../../lib/api/generated/types.gen";

export type StorageProfile = "minimum" | "recommended" | "extended" | "custom";

export function applyStorageProfile(
  policies: StoragePolicy[],
  profile: Exclude<StorageProfile, "custom">,
): StoragePolicy[] {
  return policies.map((policy) => {
    if (policy.category === "user_ip_history") {
      return { ...policy, enabled: true, retention_days: profile === "minimum" ? 7 : profile === "recommended" ? 30 : policy.retention_days };
    }
    if (policy.category === "technical") {
      return { ...policy, enabled: true, retention_days: 7 };
    }
    if (profile === "minimum") {
      return { ...policy, enabled: false };
    }
    if (profile === "extended") {
      return { ...policy, enabled: true };
    }
    const enabled = ["events", "audit", "connection_issues", "traffic", "user_traffic"].includes(policy.category);
    const retention: Partial<Record<StorageCategory, number>> = {
      events: 30,
      audit: 90,
      connection_issues: 14,
      traffic: 7,
      user_traffic: 365,
      diagnostics: 7,
    };
    return {
      ...policy,
      enabled,
      retention_days: retention[policy.category] ?? policy.retention_days,
    };
  });
}

export function sameStoragePolicies(a: StoragePolicy[], b: StoragePolicy[]): boolean {
  return (
    a.length === b.length &&
    a.every((policy, index) => {
      const other = b[index];
      return (
        other?.category === policy.category &&
        other.enabled === policy.enabled &&
        other.retention_days === policy.retention_days
      );
    })
  );
}

export function detectStorageProfile(policies: StoragePolicy[]): StorageProfile {
  for (const profile of ["minimum", "recommended", "extended"] as const) {
    if (sameStoragePolicies(policies, applyStorageProfile(policies, profile))) {
      return profile;
    }
  }
  return "custom";
}
