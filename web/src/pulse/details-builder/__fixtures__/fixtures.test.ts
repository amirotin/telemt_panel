// The fixture inventory: an executable copy of the cardinality table in
// TELEMT_LIVE_API_DATA.md §24 / spec §27.2. Later tasks in this wave size
// their layouts, paging policies and completeness checks against these
// numbers, so a fixture quietly shrinking back to mock size would silently
// invalidate every one of those decisions. Type-checking is `tsc --noEmit`'s
// job (the fixtures are typed from realtime/topics.ts and the generated
// client); this file pins the counts, the documented value ranges, and the
// determinism the whole directory rests on.
import { describe, expect, it } from "vitest";
import {
  admissionEventCount,
  arrayVariants,
  connectionsSummary,
  connectionsTopLimit,
  dcAllFalsy,
  dcEndpointVariants,
  dcIds,
  dcs,
  degradedWriterCount,
  effectiveLimits,
  eventCount,
  events,
  initialization,
  initializationComponentCount,
  initializationSkippedCount,
  longCounterKey,
  longEndpoint,
  longFingerprintRaw,
  meQuality,
  mePoolState,
  meRuntimeFieldCount,
  meSelftest,
  meWriters,
  minimalAll,
  natStunConfiguredCount,
  natStunLive0,
  natStunLive10,
  natStunLive7,
  networkPath,
  rng,
  runtimeSnapshot,
  securitySnapshot,
  selftestAllNullable,
  statsSnapshot,
  summary,
  tlsFingerprints,
  tlsRowsPerScope,
  upstreamQuality,
  upstreams,
  upstreamsSnapshot,
  writerAllNull,
  writerCount,
  zeroAll,
  zeroCoreScalarCount,
  zeroDesyncCount,
  zeroMiddleProxyCount,
  zeroPoolCount,
  zeroUpstreamCount,
} from ".";

// countRenderedRows mirrors what the current generic flatten does to a
// counter section: one row per scalar key, one row per entry of a
// {class,total} breakdown, and one row for an empty array (which must show
// as "empty", never vanish). This is the arithmetic behind §11's "115".
function countRenderedRows(section: Record<string, unknown>): number {
  return Object.values(section).reduce<number>((total, value) => {
    if (Array.isArray(value)) return total + Math.max(value.length, 1);
    return total + 1;
  }, 0);
}

describe("fixture inventory: cardinalities (TELEMT_LIVE_API_DATA §24, spec §27.2)", () => {
  it("has 12 DCs, including the negative IDs", () => {
    expect(dcs.dcs).toHaveLength(12);
    expect(dcs.dcs.map((d) => d.dc)).toEqual([...dcIds]);
    expect(dcs.dcs.filter((d) => d.dc < 0)).toHaveLength(6);
  });

  it("gives each DC 1–10 endpoints, touching both ends, and 24 endpoint_writers rows in total", () => {
    const counts = dcs.dcs.map((d) => d.endpoints.length);
    expect(Math.min(...counts)).toBe(1);
    expect(Math.max(...counts)).toBe(10);
    expect(dcs.dcs.reduce((n, d) => n + d.endpoint_writers.length, 0)).toBe(24);
  });

  it("has 46 ME writers with all 16 fields", () => {
    expect(meWriters.writers).toHaveLength(writerCount);
    expect(writerCount).toBe(46);
    for (const writer of meWriters.writers) {
      expect(Object.keys(writer)).toHaveLength(16);
    }
  });

  it("has 16 initialization components, 14 ready and 2 skipped", () => {
    expect(initialization.components).toHaveLength(initializationComponentCount);
    expect(initializationComponentCount).toBe(16);
    const skipped = initialization.components.filter((c) => c.status === "skipped");
    expect(skipped).toHaveLength(initializationSkippedCount);
    expect(initialization.components.filter((c) => c.status === "ready")).toHaveLength(14);
  });

  it("has 50 TLS records in each of the four scopes", () => {
    expect(tlsRowsPerScope).toBe(50);
    for (const scope of [
      tlsFingerprints.by_fingerprint,
      tlsFingerprints.by_ip,
      tlsFingerprints.by_cidr,
      tlsFingerprints.by_user,
    ]) {
      expect(scope).toHaveLength(50);
    }
  });

  it("gives by_fingerprint rows 9 fields and the scoped lists 10", () => {
    for (const row of tlsFingerprints.by_fingerprint) {
      expect(Object.keys(row)).toHaveLength(9);
      expect(row).not.toHaveProperty("scope");
    }
    for (const scope of [tlsFingerprints.by_ip, tlsFingerprints.by_cidr, tlsFingerprints.by_user]) {
      for (const row of scope) {
        expect(Object.keys(row)).toHaveLength(10);
        expect(row.scope).toBeTruthy();
      }
    }
  });

  it("renders 115 counter rows across the five zero/all groups", () => {
    const perGroup = {
      core: countRenderedRows(zeroAll.core),
      upstream: countRenderedRows(zeroAll.upstream),
      middle_proxy: countRenderedRows(zeroAll.middle_proxy),
      pool: countRenderedRows(zeroAll.pool),
      desync: countRenderedRows(zeroAll.desync),
    };
    // core: 21 scalars + 2 class arrays of 2 entries = 25 (§11's table).
    expect(perGroup).toEqual({ core: 25, upstream: 16, middle_proxy: 55, pool: 11, desync: 8 });
    expect(Object.values(perGroup).reduce((a, b) => a + b, 0)).toBe(115);
    expect(zeroCoreScalarCount).toBe(21);
    expect(zeroUpstreamCount).toBe(16);
    expect(zeroMiddleProxyCount).toBe(55);
    expect(zeroPoolCount).toBe(11);
    expect(zeroDesyncCount).toBe(8);
  });

  it("keeps handshake_error_codes present but empty", () => {
    expect(zeroAll.middle_proxy).toHaveProperty("handshake_error_codes");
    expect(zeroAll.middle_proxy['handshake_error_codes']).toEqual([]);
  });

  it("has 50 events: 48 admission.state plus one reload and one user mutation", () => {
    expect(events.events).toHaveLength(eventCount);
    expect(eventCount).toBe(50);
    const byType = events.events.reduce<Record<string, number>>((acc, e) => {
      acc[e.event_type] = (acc[e.event_type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({
      "admission.state": admissionEventCount,
      "config.reload.applied": 1,
      "api.user.create.ok": 1,
    });
    expect(admissionEventCount).toBe(48);
  });

  it("has 13 configured STUN servers in all three live variants (0 / 7 / 10)", () => {
    for (const variant of [natStunLive0, natStunLive7, natStunLive10]) {
      expect(variant.servers.configured).toHaveLength(natStunConfiguredCount);
      expect(natStunConfiguredCount).toBe(13);
      expect(variant.servers.live).toHaveLength(variant.servers.live_total);
    }
    expect([natStunLive0, natStunLive7, natStunLive10].map((v) => v.servers.live_total)).toEqual([0, 7, 10]);
  });

  it("has two top-10 connection rankings over the same users", () => {
    expect(connectionsSummary.top.by_connections).toHaveLength(connectionsTopLimit);
    expect(connectionsSummary.top.by_throughput).toHaveLength(connectionsTopLimit);
    expect(connectionsTopLimit).toBe(10);
  });

  it("has 2 healthy ME families and 12 dc_rtt rows", () => {
    expect(meQuality.family_states).toHaveLength(2);
    expect(meQuality.family_states.every((f) => f.state === "healthy")).toBe(true);
    expect(meQuality.dc_rtt).toHaveLength(12);
  });

  it("has 40 effective-limit leaves", () => {
    const leaves = (value: unknown): number => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.values(value as Record<string, unknown>).reduce<number>((n, v) => n + leaves(v), 0);
      }
      return 1;
    };
    expect(leaves(effectiveLimits)).toBe(40);
  });

  it("has one upstream with five nested DC rows in both stats and quality", () => {
    expect(upstreams.upstreams).toHaveLength(1);
    expect(upstreams.upstreams?.[0].dc).toHaveLength(5);
    expect(upstreamQuality.upstreams).toHaveLength(1);
    expect(upstreamQuality.upstreams?.[0].dc).toHaveLength(5);
    // Same entity from two endpoints — the reason §23.5 merges by id.
    expect(upstreamQuality.upstreams?.[0].upstream_id).toBe(upstreams.upstreams?.[0].upstream_id);
  });

  it("has a minimal/all with ~55 me_runtime fields and 5 network paths", () => {
    expect(meRuntimeFieldCount).toBeGreaterThanOrEqual(55);
    expect(Object.keys(minimalAll.me_runtime ?? {})).toHaveLength(meRuntimeFieldCount);
    expect(networkPath).toHaveLength(5);
    expect(minimalAll.network_path).toHaveLength(5);
    // The composite re-carries the standalone collections (§10).
    expect(minimalAll.dcs.dcs).toHaveLength(12);
    expect(minimalAll.me_writers.writers).toHaveLength(writerCount);
  });

  it("has both summary class breakdowns with three entries", () => {
    expect(summary.connections_bad_by_class).toHaveLength(3);
    expect(summary.handshake_failures_by_class).toHaveLength(3);
  });
});

describe("fixture inventory: documented value ranges (§8, §9, §13, §17, §19)", () => {
  it("keeps writer bound_clients in 0–31 and RTT in 4–473, with 2–4 degraded", () => {
    const clients = meWriters.writers.map((w) => w.bound_clients);
    expect(Math.min(...clients)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...clients)).toBeLessThanOrEqual(31);

    const rtts = meWriters.writers.map((w) => w.rtt_ema_ms ?? 0);
    expect(Math.min(...rtts)).toBe(4);
    expect(Math.max(...rtts)).toBe(473);

    const degraded = meWriters.writers.filter((w) => w.degraded).length;
    expect(degraded).toBe(degradedWriterCount);
    expect(degraded).toBeGreaterThanOrEqual(2);
    expect(degraded).toBeLessThanOrEqual(4);

    // Every writer was `active`, none draining, on all three VPS.
    expect(meWriters.writers.every((w) => w.state === "active")).toBe(true);
    expect(meWriters.writers.filter((w) => w.draining)).toHaveLength(0);
  });

  it("keeps DC coverage at 100% and RTT within 4–342", () => {
    for (const dc of dcs.dcs) {
      expect(dc.coverage_pct).toBe(100);
      expect(dc.fresh_coverage_pct).toBe(100);
      expect(dc.rtt_ms ?? 0).toBeGreaterThanOrEqual(4);
      expect(dc.rtt_ms ?? 0).toBeLessThanOrEqual(342);
    }
  });

  it("keeps initialization durations within 0–9838 ms at one attempt each", () => {
    const durations = initialization.components.map((c) => c.duration_ms ?? 0);
    expect(Math.min(...durations)).toBe(0);
    expect(Math.max(...durations)).toBeLessThanOrEqual(9838);
    expect(initialization.components.every((c) => c.attempts === 1)).toBe(true);
  });

  it("keeps connection rankings within 1–25 connections and ~5.6–47.2 bn octets", () => {
    for (const row of [...connectionsSummary.top.by_connections, ...connectionsSummary.top.by_throughput]) {
      expect(row.current_connections).toBeGreaterThanOrEqual(1);
      expect(row.current_connections).toBeLessThanOrEqual(25);
      expect(row.total_octets).toBeGreaterThanOrEqual(5_600_000_000);
      expect(row.total_octets).toBeLessThanOrEqual(47_200_000_000);
    }
  });

  it("keeps TLS totals within their per-scope maxima with bad_or_probe at 0", () => {
    const maxima: Array<[typeof tlsFingerprints.by_ip, number]> = [
      [tlsFingerprints.by_fingerprint, 3364],
      [tlsFingerprints.by_ip, 174],
      [tlsFingerprints.by_cidr, 174],
      [tlsFingerprints.by_user, 194],
    ];
    for (const [rows, max] of maxima) {
      const totals = rows.map((r) => r.total);
      expect(Math.min(...totals)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...totals)).toBe(max);
      // auth_success tracked total exactly, bad_or_probe was 0 everywhere.
      expect(rows.every((r) => r.auth_success === r.total)).toBe(true);
      expect(rows.every((r) => r.bad_or_probe === 0)).toBe(true);
    }
  });
});

describe("fixture inventory: edge cases (spec §27.2)", () => {
  it("offers absent / empty / one / many for an optional array", () => {
    expect(arrayVariants).toEqual(["absent", "empty", "one", "many"]);
    // absent must be a MISSING key, not an undefined one — that is the
    // only shape Go's omitempty produces, and the distinction a renderer
    // has to make between "no data" and "empty list".
    expect("endpoints" in dcEndpointVariants.absent).toBe(false);
    expect(dcEndpointVariants.empty.endpoints).toEqual([]);
    expect(dcEndpointVariants.one.endpoints).toHaveLength(1);
    expect(dcEndpointVariants.many.endpoints).toHaveLength(10);
  });

  it("offers null / false / 0 scalars that are present, not missing", () => {
    expect(dcAllFalsy.rtt_ms).toBeNull();
    expect(dcAllFalsy.floor_capped).toBe(false);
    expect(dcAllFalsy.load).toBe(0);
    expect("rtt_ms" in dcAllFalsy).toBe(true);

    expect(writerAllNull.dc).toBeNull();
    expect(writerAllNull.rtt_ema_ms).toBeNull();
    expect(writerAllNull.idle_for_secs).toBeNull();
    expect(writerAllNull.bound_clients).toBe(0);

    // The healthy self-test already omits one IP family; the edge fixture
    // omits both and nulls `bnd`.
    expect(meSelftest.ip.v6).toBeUndefined();
    expect(selftestAllNullable.ip.v4).toBeUndefined();
    expect(selftestAllNullable.ip.v6).toBeUndefined();
    expect(selftestAllNullable.bnd).toBeNull();
  });

  it("offers identifiers far longer than the production snapshot's", () => {
    expect(longEndpoint.length).toBeGreaterThan(120);
    expect(longFingerprintRaw.length).toBeGreaterThan(150);
    expect(longCounterKey.length).toBeGreaterThan(80);
  });
});

describe("fixture inventory: composition and determinism", () => {
  it("composes the topic snapshots the way hub.go does", () => {
    expect(statsSnapshot.summary).toBe(summary);
    expect(runtimeSnapshot.initialization).toBe(initialization);
    expect(runtimeSnapshot.me_pool_state?.data).toBe(mePoolState);
    expect(runtimeSnapshot.recent_events?.data).toBe(events);
    expect(upstreamsSnapshot.dcs).toBe(dcs);
    expect(upstreamsSnapshot.me_writers).toBe(meWriters);
    expect(securitySnapshot.posture).toBeTruthy();
  });

  it("keeps TLS fingerprints out of the security topic", () => {
    // They moved to GET /api/telemt/tls-fingerprints in M4 task 1; a
    // fixture that still carried them would let a page be built against a
    // shape the server no longer sends.
    expect(securitySnapshot).not.toHaveProperty("tls_fingerprints");
  });

  it("draws from a seeded generator, not the clock", () => {
    // Two generators on the same seed must agree — this is the property
    // the whole directory rests on.
    expect(rng(0x1234).next()).toBe(rng(0x1234).next());
    expect(rng(1).int(0, 1000)).toBe(rng(1).int(0, 1000));
    expect(rng(1).next()).not.toBe(rng(2).next());
  });

  it("produces the same values on every run", () => {
    // Pinned samples from across the generated fixtures. Any value here
    // moving means a generator started depending on Math.random, Date.now
    // or module evaluation order — the failure mode that would make a
    // Details-page render test irreproducible.
    expect(dcs.dcs[0].rtt_ms).toBe(252.5);
    expect(dcs.dcs[0].load).toBe(0.604);
    expect(dcs.dcs[11].rtt_ms).toBe(103);
    expect(meWriters.writers[0].bound_clients).toBe(29);
    expect(meWriters.writers[45].bound_clients).toBe(11);
    expect(tlsFingerprints.by_fingerprint[0].ja3).toBe("531be4edbdf1f875c7e02fb660ccad74");
    expect(connectionsSummary.top.by_connections[0].total_octets).toBe(19350129967);
    expect(zeroAll.core['core_0_total']).toBe(356972);
  });
});
