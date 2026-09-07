import type { StoragePolicy } from "../../lib/api/generated/types.gen";

export function retentionReductions(previous: StoragePolicy[], next: StoragePolicy[]): StoragePolicy[] {
  return next.filter((p) => previous.some((old) => old.category === p.category && p.retention_days < old.retention_days));
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
