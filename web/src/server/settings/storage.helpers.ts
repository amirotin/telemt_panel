import type { StoragePolicy } from "../../lib/api/generated/types.gen";

export function ipHistoryLimit(policy: StoragePolicy): number {
  return policy.max_ips_per_user ?? 256;
}

export function parseIPHistoryLimit(value: string): number | null {
  const limit = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100_000
    ? limit
    : null;
}

export function ipHistoryLimitReduced(previous: StoragePolicy, next: StoragePolicy): boolean {
  const oldLimit = ipHistoryLimit(previous);
  const nextLimit = ipHistoryLimit(next);
  return next.category === "user_ip_history" && nextLimit !== 0 && (oldLimit === 0 || nextLimit < oldLimit);
}

export function retentionReductions(previous: StoragePolicy[], next: StoragePolicy[]): StoragePolicy[] {
  return next.filter((p) => previous.some((old) => old.category === p.category &&
    (p.retention_days < old.retention_days || ipHistoryLimitReduced(old, p))));
}

export function sameStoragePolicies(a: StoragePolicy[], b: StoragePolicy[]): boolean {
  return (
    a.length === b.length &&
    a.every((policy, index) => {
      const other = b[index];
      return (
        other?.category === policy.category &&
        other.enabled === policy.enabled &&
        other.retention_days === policy.retention_days &&
        (policy.category !== "user_ip_history" || ipHistoryLimit(other) === ipHistoryLimit(policy))
      );
    })
  );
}
