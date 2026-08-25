import { useMemo } from "react";
import { useSnapshot } from "../realtime";
import type { UsersTopic, UsersTopicQuotaEntry, UsersTopicUser } from "../realtime/topics";

export interface UsersTopicView {
  users: UsersTopicUser[];
  quota: Record<string, UsersTopicQuotaEntry> | null;
  quotaSupported: boolean;
  isPending: boolean;
  isError: boolean;
  errorCode: string | null;
  stale: boolean;
}

// useUsersTopic adapts the raw SSE snapshot (useSnapshot<UsersTopic>) into
// the shape People's screens actually consume, plus the loading/error/stale
// flags <AsyncState> expects — SSE data doesn't have a TanStack Query
// status, so this derives an equivalent: pending until the first frame ever
// arrives, error only when a source_error arrived before any data was ever
// received (afterwards a source_error just marks the existing data stale,
// per 02-hub-sse.md — it is NEVER treated as an error once real data exists).
export function useUsersTopic(): UsersTopicView {
  const snapshot = useSnapshot<UsersTopic>("users");
  return useMemo(() => {
    const data = snapshot.data;
    return {
      users: data?.users ?? [],
      quota: data?.quota ?? null,
      quotaSupported: data?.quota_supported ?? false,
      isPending: data === null,
      isError: data === null && snapshot.error !== null,
      errorCode: snapshot.error,
      stale: snapshot.stale,
    };
  }, [snapshot]);
}

export function findQuotaEntry(
  quota: Record<string, UsersTopicQuotaEntry> | null,
  username: string,
): UsersTopicQuotaEntry | undefined {
  return quota?.[username];
}
