// Checkpoint R5-Connections, the automatable half: §23.5's two rankings and
// the page's own §27.4 completeness equation over the production payload.

import { describe, expect, it } from "vitest";
import { ru } from "../../../i18n";
import { connectionsSummary, connectionsTopLimit, statsSnapshot, summary } from "../__fixtures__";
import type { StatsSnapshot } from "../../../realtime/topics";
import { aggregateSources, resolveTopicSource } from "../sources";
import { connectionsPagePayload } from "../../diag/connections.helpers";
import { classifyValue, resolveSections } from "../resolveSections";
import type { CollectionSectionInstance, ScalarSectionInstance } from "../resolveSections";
import { readBreakdownPair } from "../renderers/breakdown.helpers";
import {
  CONNECTIONS_TOP_PATHS,
  connectionsPageDefinition,
  type ConnectionsPagePayload,
} from "./connections";

const TRAFFIC_TOTAL = 987_654_321;
const full = connectionsPagePayload(summary, connectionsSummary, TRAFFIC_TOTAL) as ConnectionsPagePayload;

function resolveFor(context: ConnectionsPagePayload) {
  return resolveSections({ definition: connectionsPageDefinition, context });
}

function sectionById(context: ConnectionsPagePayload, id: string) {
  const section = resolveFor(context).sections.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no section ${id}`);
  return section;
}

describe("Connections page definition (spec §23.5)", () => {
  it("renders the two top lists as RankingSections, not as thirty KV rows", () => {
    for (const path of CONNECTIONS_TOP_PATHS) {
      const ranking = sectionById(full, path) as CollectionSectionInstance;
      expect(ranking.kind, path).toBe("ranking");
      expect(ranking.items, path).toHaveLength(connectionsTopLimit);
      // The username is the row's identity AND its key (§5.3), so a
      // re-sort by Telemt cannot re-key a row that merely moved.
      expect(ranking.itemKeys[0]).toBe(connectionsSummary.top[path][0].username);
    }
  });

  it("ranks each list by its own criterion and prints a volume as a volume", () => {
    const byConnections = connectionsPageDefinition.sections.find((s) => s.id === "by_connections");
    const byThroughput = connectionsPageDefinition.sections.find((s) => s.id === "by_throughput");
    if (byConnections?.kind !== "ranking" || byThroughput?.kind !== "ranking") {
      throw new Error("both top lists must be rankings");
    }
    const user = connectionsSummary.top.by_throughput[0];
    expect(byConnections.scoreKey).toBe("current_connections");
    expect(byConnections.score(user)).toBe(user.current_connections);
    expect(byThroughput.scoreKey).toBe("total_octets");
    expect(byThroughput.score(user)).toBe(user.total_octets);
    // 47 200 000 000 is a number a reader has to count digits in; the
    // ranking prints it through the bytes formatter instead (§13).
    expect(byThroughput.scoreFormat).toBe("bytes");
    expect(byConnections.scoreFormat).toBe("integer");
    // Each list offers the OTHER column as its explicit sort option.
    expect(byConnections.sort?.map((s) => s.key)).toEqual(["total_octets"]);
    expect(byThroughput.sort?.map((s) => s.key)).toEqual(["current_connections"]);
  });

  it("names a row with the user's own name and footnotes the other number (R6)", () => {
    const byConnections = connectionsPageDefinition.sections.find((s) => s.id === "by_connections");
    if (byConnections?.kind !== "ranking") throw new Error("ranking expected");
    const user = connectionsSummary.top.by_connections[0];
    // A username is the admin's own data and is shown verbatim — the
    // sensitive policy of ruling R6, unchanged by this page.
    expect(byConnections.identity(user)).toBe(user.username);
    const meta = byConnections.meta?.(user, ru) ?? "";
    expect(meta).toContain(ru.details.pages.connections.metaOctets.split("{")[0].trim());
    expect(meta).not.toBe("");
  });

  it("gives the two {class,total} arrays BreakdownSections (§23.5)", () => {
    for (const id of ["connections_bad_by_class", "handshake_failures_by_class"]) {
      const block = sectionById(full, id) as CollectionSectionInstance;
      expect(block.kind, id).toBe("breakdown");
      expect(block.presence, id).toBe("present");
      expect(readBreakdownPair(block.items[0], 0)).not.toBeNull();
    }
  });

  it("puts the always-on half FIRST, so a gated build lands on data (§14, R10)", () => {
    const order = resolveFor(full).sections.map((s) => s.id);
    const stats = ["summary", "connections_bad_by_class", "handshake_failures_by_class"];
    const edge = ["totals", "by_connections", "by_throughput"];
    expect(Math.max(...stats.map((id) => order.indexOf(id)))).toBeLessThan(
      Math.min(...edge.map((id) => order.indexOf(id))),
    );
    // …and with the gate off the always-on sections still resolve with rows.
    const gatedOff = connectionsPagePayload(summary, null, TRAFFIC_TOTAL) as ConnectionsPagePayload;
    expect((sectionById(gatedOff, "summary") as ScalarSectionInstance).rows.length).toBe(6);
    expect((sectionById(gatedOff, "by_connections") as CollectionSectionInstance).presence).toBe(
      "absent",
    );
  });

  it("reads every bound block as a stable record, never as a counters map", () => {
    expect(classifyValue(full.totals, { path: "totals" })).toBe("object");
    expect(classifyValue(full.cache, { path: "cache" })).toBe("object");
    expect(classifyValue(full.telemetry, { path: "telemetry" })).toBe("object");
    expect(classifyValue(full.top, { path: "top" })).toBe("object");
    expect(classifyValue(full.top?.by_connections?.[0], { path: "top.by_connections[0]" })).toBe(
      "object",
    );
  });
});

describe("checkpoint R5-Connections: completeness (§27.4, ruling R7)", () => {
  it("accounts for every leaf of the production payload", () => {
    const result = resolveFor(full);
    // 5 summary scalars + 2 x 3 class pairs + the traffic total + 4 totals
    // + 3 cache + 2 telemetry + top.limit + 2 x 10 x 3 ranking fields.
    expect(result.allPaths.length).toBe(88);
    expect(result.lostPaths).toEqual([]);
    expect(
      result.unknownPaths,
      `unplaced connection paths:\n${result.unknownPaths.join("\n")}`,
    ).toEqual([]);
    expect(result.ignoredPaths).toEqual([]);
    expect(result.extractedFromScalars).toEqual([]);
  });

  it("hands a field we have never seen to the tail instead of swallowing it", () => {
    const future = {
      ...full,
      a_block_from_a_future_telemt: { some_total: 1 },
    } as unknown as ConnectionsPagePayload;
    const result = resolveFor(future);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(["a_block_from_a_future_telemt.some_total"]);
    expect(result.consumedPaths).not.toContain("a_block_from_a_future_telemt.some_total");
  });

  it("hands a field nested inside a bound record to the tail too", () => {
    // A top-level block is the weakest probe available. A key added INSIDE
    // `cache`, which a scalars section already reads field by field, is
    // where a field disappears if a section may claim a partial subtree.
    const future = {
      ...full,
      cache: { ...full.cache, future: { detail: 3 } },
    } as unknown as ConnectionsPagePayload;
    const result = resolveFor(future);
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual(["cache.future.detail"]);
    expect(result.consumedPaths).not.toContain("cache.future.detail");
  });

  it("draws a future field on a ranked row rather than tailing it", () => {
    // The counterpart: a ranking renders every key of its rows through
    // `buildRecordNodes`, so owning `top.by_connections` is honest.
    const richer = {
      ...full,
      top: {
        ...full.top!,
        by_connections: [{ ...full.top!.by_connections[0], future_field: 7 }],
      },
    } as unknown as ConnectionsPagePayload;
    const result = resolveFor(richer);
    expect(result.unknownPaths).toEqual([]);
    expect(result.consumedPaths).toContain("top.by_connections[0].future_field");
  });

  it("stays complete with the runtime_edge half switched off", () => {
    const result = resolveFor(
      connectionsPagePayload(summary, null, null) as ConnectionsPagePayload,
    );
    expect(result.lostPaths).toEqual([]);
    expect(result.unknownPaths).toEqual([]);
  });
});

// A stock build (runtime_edge off) omits `connections_summary` from the
// stats topic entirely — internal/hub/hub.go's `omitempty`. ConnectionsPage
// normalizes that to `null`; this pins what the builder makes of it, so the
// page cannot land on a green pill over two blank rankings.
describe("runtime_edge off, the way a stock build sends it", () => {
  const withoutGate: StatsSnapshot = { ...statsSnapshot };
  delete (withoutGate as { connections_summary?: unknown }).connections_summary;

  function resolveGateSource(data: StatsSnapshot | null) {
    // The exact expression diag/ConnectionsPage.tsx builds.
    return resolveTopicSource("connections", {
      kind: "topic",
      snapshot: { data, ts: 1_756_000_000, stale: false, error: null },
      gated: data?.connections_summary ?? null,
    });
  }

  it("marks the gated source disabled once the stats topic has arrived", () => {
    const state = resolveGateSource(withoutGate);
    expect(state.status).toBe("disabled");
    expect(state.hasData).toBe(false);
  });

  it("still reports the ungated summary section's own source as ready", () => {
    const state = resolveTopicSource("stats", {
      kind: "topic",
      snapshot: { data: withoutGate, ts: 1_756_000_000, stale: false, error: null },
    });
    expect(state.status).toBe("ready");
  });

  it("does not call it disabled before the first frame", () => {
    expect(resolveGateSource(null).status).toBe("loading");
  });

  it("leaves the page partial, not ready — the summary still renders", () => {
    const byId = {
      stats: resolveTopicSource("stats", {
        kind: "topic",
        snapshot: { data: withoutGate, ts: 1_756_000_000, stale: false, error: null },
      }),
      connections: resolveGateSource(withoutGate),
    };
    expect(aggregateSources(connectionsPageDefinition.sources, byId).status).toBe("partial");
  });
});
