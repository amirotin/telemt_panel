import { describe, expect, it } from "vitest";
import { connectionsGroups } from "./connections.helpers";
import type { RuntimeEdgeConnectionsSummary } from "../../realtime/topics";

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
    const groups = connectionsGroups(data);
    expect(groups.map((g) => g.title)).toEqual([
      "Итого",
      "Кэш",
      "Топ по соединениям",
      "Топ по трафику",
      "Телеметрия",
    ]);
  });

  it("flattens the totals into individual rows", () => {
    const groups = connectionsGroups(data);
    const totals = groups[0];
    expect(totals.rows).toEqual([
      { key: "current_connections", label: "current connections", value: "5" },
      { key: "current_connections_me", label: "current connections me", value: "3" },
      { key: "current_connections_direct", label: "current connections direct", value: "2" },
      { key: "active_users", label: "active users", value: "4" },
    ]);
  });

  it("expands the by_connections array by index", () => {
    const groups = connectionsGroups(data);
    const top = groups[2];
    expect(top.rows.map((r) => r.key)).toEqual([
      "[0].username",
      "[0].current_connections",
      "[0].total_octets",
    ]);
  });

  it("still emits an (empty) group for an empty array field", () => {
    const groups = connectionsGroups(data);
    expect(groups[3]).toEqual({ title: "Топ по трафику", rows: [] });
  });
});
