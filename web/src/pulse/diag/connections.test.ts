import { describe, expect, it } from "vitest";
import { connectionsGroups, summaryGroup } from "./connections.helpers";
import type { RuntimeEdgeConnectionsSummary, StatsSummary } from "../../realtime/topics";
import { ru as s } from "../../i18n";

const data: RuntimeEdgeConnectionsSummary = {
  cache: { ttl_ms: 1000, served_from_cache: true, stale_cache_used: false },
  totals: { current_connections: 5, current_connections_me: 3, current_connections_direct: 2, active_users: 4 },
  top: {
    limit: 10,
    by_connections: [{ username: "alice", current_connections: 2, total_octets: 100 }],
    by_throughput: [],
  },
  telemetry: { user_enabled: true, throughput_is_cumulative: false },
};

describe("connectionsGroups", () => {
  it("emits one group per sub-object, in a stable order", () => {
    const groups = connectionsGroups(data, s);
    expect(groups.map((g) => g.title)).toEqual([
      "Итого",
      "Кэш",
      "Топ по соединениям",
      "Топ по трафику",
      "Телеметрия",
    ]);
  });

  it("flattens the totals into individual rows", () => {
    const groups = connectionsGroups(data, s);
    const totals = groups[0];
    expect(totals.rows).toEqual([
      { key: "current_connections", label: "current connections", value: "5" },
      { key: "current_connections_me", label: "current connections me", value: "3" },
      { key: "current_connections_direct", label: "current connections direct", value: "2" },
      { key: "active_users", label: "active users", value: "4" },
    ]);
  });

  it("expands the by_connections array by index", () => {
    const groups = connectionsGroups(data, s);
    const top = groups[2];
    expect(top.rows.map((r) => r.key)).toEqual([
      "[0].username",
      "[0].current_connections",
      "[0].total_octets",
    ]);
  });

  it("still emits an (empty) group for an empty array field", () => {
    const groups = connectionsGroups(data, s);
    expect(groups[3]).toEqual({ title: "Топ по трафику", rows: [] });
  });
});

describe("summaryGroup", () => {
  const summary: StatsSummary = {
    uptime_seconds: 3600,
    connections_total: 42,
    connections_bad_total: 3,
    handshake_timeouts_total: 1,
    configured_users: 7,
    connections_bad_by_class: [{ class: "rate_limited", total: 3 }],
    handshake_failures_by_class: [{ class: "tls", total: 1 }],
  };

  it("returns no group when summary is null (sub-call failed this poll)", () => {
    expect(summaryGroup(null, s)).toEqual([]);
  });

  it("flattens every summary scalar/array under one Сводка group", () => {
    const groups = summaryGroup(summary, s);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("Сводка");
    const keys = groups[0].rows.map((r) => r.key);
    expect(keys).toEqual([
      "uptime_seconds",
      "connections_total",
      "connections_bad_total",
      "handshake_timeouts_total",
      "configured_users",
      "connections_bad_by_class[0].class",
      "connections_bad_by_class[0].total",
      "handshake_failures_by_class[0].class",
      "handshake_failures_by_class[0].total",
    ]);
  });
});
