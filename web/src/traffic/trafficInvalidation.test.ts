import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  getAuditInfiniteQueryKey,
  getAuditQueryKey,
  getHistoryQueryKey,
  getStorageSettingsQueryKey,
  getTelemtConfigQueryKey,
  getTrafficSummaryQueryKey,
  getTrafficUsersInfiniteQueryKey,
  getTrafficUsersQueryKey,
  getUserIpHistoryInfiniteQueryKey,
  getUserIpHistoryQueryKey,
  getUserQueryKey,
  getUserTrafficHistoryQueryKey,
  listUsersQueryKey,
} from "../lib/api/generated/@tanstack/react-query.gen";
import { invalidateTrafficQueries } from "./trafficInvalidation";

type QueryCase = { label: string; key: QueryKey };

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function mountQueries(client: QueryClient, cases: QueryCase[]) {
  const refetches = new Map<string, number>();
  const unsubscribes = cases.map(({ label, key }) => {
    client.setQueryData(key, { cached: label });
    refetches.set(label, 0);
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => {
        const count = (refetches.get(label) ?? 0) + 1;
        refetches.set(label, count);
        return { fetched: label, count };
      },
      staleTime: Infinity,
    });
    return observer.subscribe(() => {});
  });
  return {
    refetches,
    unsubscribe: () => unsubscribes.forEach((unsubscribe) => unsubscribe()),
  };
}

function cacheQueries(client: QueryClient, cases: QueryCase[]) {
  for (const { label, key } of cases) client.setQueryData(key, { cached: label });
}

function expectRefetches(
  refetches: Map<string, number>,
  cases: QueryCase[],
  expected: number,
) {
  for (const { label } of cases) expect(refetches.get(label), label).toBe(expected);
}

function expectInvalidated(client: QueryClient, cases: QueryCase[], expected: boolean) {
  for (const { label, key } of cases) {
    expect(client.getQueryState(key)?.isInvalidated, label).toBe(expected);
  }
}

const sharedActive: QueryCase[] = [
  { label: "summary 24h", key: getTrafficSummaryQueryKey({ query: { range: "24h" } }) },
  {
    label: "rankings infinite month",
    key: getTrafficUsersInfiniteQueryKey({ query: { range: "month", limit: 25 } }),
  },
  { label: "storage", key: getStorageSettingsQueryKey() },
  { label: "audit infinite", key: getAuditInfiniteQueryKey({ query: { limit: 25 } }) },
  { label: "users list", key: listUsersQueryKey() },
];

const sharedInactive: QueryCase[] = [
  { label: "summary 1y", key: getTrafficSummaryQueryKey({ query: { range: "1y" } }) },
  {
    label: "rankings page 7d",
    key: getTrafficUsersQueryKey({ query: { range: "7d", cursor: "page-2" } }),
  },
  {
    label: "rankings infinite 30d",
    key: getTrafficUsersInfiniteQueryKey({ query: { range: "30d", include_deleted: true } }),
  },
  {
    label: "storage alternate base",
    key: getStorageSettingsQueryKey({ baseUrl: "http://other-panel.test" }),
  },
  {
    label: "audit page",
    key: getAuditQueryKey({ query: { limit: 50, before: "2026-09-08T00:00:00Z" } }),
  },
  { label: "users list alternate base", key: listUsersQueryKey({ baseUrl: "http://other-panel.test" }) },
];

const unrelatedActive: QueryCase[] = [
  {
    label: "alice IP history",
    key: getUserIpHistoryQueryKey({ path: { username: "alice" }, query: { range: "24h" } }),
  },
  {
    label: "technical history",
    key: getHistoryQueryKey({ query: { metric: "connections", range: "1h" } }),
  },
  { label: "Telemt config", key: getTelemtConfigQueryKey() },
];

const unrelatedInactive: QueryCase[] = [
  {
    label: "alice IP history infinite",
    key: getUserIpHistoryInfiniteQueryKey({
      path: { username: "alice" },
      query: { range: "30d", limit: 25 },
    }),
  },
  {
    label: "technical history 24h",
    key: getHistoryQueryKey({ query: { metric: "connections", range: "24h" } }),
  },
  { label: "Telemt config alternate base", key: getTelemtConfigQueryKey({ baseUrl: "http://other-panel.test" }) },
];

describe("invalidateTrafficQueries", () => {
  it("invalidates every shared variant and only one user's detail families for an individual reset", async () => {
    const client = makeClient();
    const aliceActive: QueryCase[] = [
      {
        label: "alice history 24h",
        key: getUserTrafficHistoryQueryKey({
          path: { username: "alice" },
          query: { range: "24h" },
        }),
      },
      { label: "alice detail", key: getUserQueryKey({ path: { username: "alice" } }) },
    ];
    const aliceInactive: QueryCase[] = [
      {
        label: "alice history 1y",
        key: getUserTrafficHistoryQueryKey({
          path: { username: "alice" },
          query: { range: "1y" },
          baseUrl: "http://other-panel.test",
        }),
      },
      {
        label: "alice detail alternate base",
        key: getUserQueryKey({
          path: { username: "alice" },
          baseUrl: "http://other-panel.test",
        }),
      },
    ];
    const otherUsers: QueryCase[] = [
      {
        label: "bob history",
        key: getUserTrafficHistoryQueryKey({
          path: { username: "bob" },
          query: { range: "7d" },
        }),
      },
      { label: "bob detail", key: getUserQueryKey({ path: { username: "bob" } }) },
    ];
    const active = [...sharedActive, ...aliceActive, ...unrelatedActive];
    const inactive = [...sharedInactive, ...aliceInactive, ...otherUsers, ...unrelatedInactive];
    const mounted = mountQueries(client, active);
    cacheQueries(client, inactive);

    await invalidateTrafficQueries(client, "alice");

    expectRefetches(mounted.refetches, [...sharedActive, ...aliceActive], 1);
    expectRefetches(mounted.refetches, unrelatedActive, 0);
    expectInvalidated(client, [...sharedInactive, ...aliceInactive], true);
    expectInvalidated(client, [...otherUsers, ...unrelatedInactive], false);
    mounted.unsubscribe();
  });

  it("invalidates every user's detail families after a global reset", async () => {
    const client = makeClient();
    const userActive: QueryCase[] = [
      {
        label: "alice history",
        key: getUserTrafficHistoryQueryKey({
          path: { username: "alice" },
          query: { range: "30d" },
        }),
      },
      { label: "bob detail", key: getUserQueryKey({ path: { username: "bob" } }) },
    ];
    const userInactive: QueryCase[] = [
      {
        label: "bob history alternate range",
        key: getUserTrafficHistoryQueryKey({
          path: { username: "bob" },
          query: { range: "1y" },
        }),
      },
      { label: "alice detail", key: getUserQueryKey({ path: { username: "alice" } }) },
    ];
    const active = [...sharedActive, ...userActive, ...unrelatedActive];
    const inactive = [...sharedInactive, ...userInactive, ...unrelatedInactive];
    const mounted = mountQueries(client, active);
    cacheQueries(client, inactive);

    await invalidateTrafficQueries(client);

    expectRefetches(mounted.refetches, [...sharedActive, ...userActive], 1);
    expectRefetches(mounted.refetches, unrelatedActive, 0);
    expectInvalidated(client, [...sharedInactive, ...userInactive], true);
    expectInvalidated(client, unrelatedInactive, false);
    mounted.unsubscribe();
  });
});
