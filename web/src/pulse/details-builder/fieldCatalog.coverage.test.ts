// The catalog coverage harness (owner decision 2026-08-26: "каталог
// описаний полей в репо с тестом покрытия и пунктом чек-листа при бампе
// Telemt").
//
// This is the test that turns "a new Telemt release added a field" into a
// red CI run instead of an undescribed row nobody notices. Asserted on all
// nine migrated domains: DC (Task 2), TLS and Security (Task 6), ME and
// Counters (Task 7), Upstreams, Connections, NAT and Events (Task 8) — the
// Telemt-bump checklist points at this file.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIELD_CATALOG,
  catalogCoverage,
  lookupField,
  TLS_FINGERPRINTS_ENDPOINT,
  WEB_ENDPOINT,
} from "./fieldCatalog";
import { webPagePayload } from "../diag/web.helpers";
import { connectionsPagePayload } from "../diag/connections.helpers";
import { eventsPagePayload } from "../diag/events.helpers";
import { mePagePayload } from "../diag/me.helpers";
import { upstreamsPagePayload } from "../diag/upstreams.helpers";
import {
  connectionsSummary,
  dcs,
  effectiveLimits,
  events,
  gates,
  initialization,
  mePoolState,
  meQuality,
  meRuntime,
  meSelftest,
  meWriters,
  minimalAll,
  natStunLive0,
  natStunLive10,
  posture,
  summary,
  upstreamQuality,
  upstreams,
  tlsFingerprints,
  whitelist,
  zeroAll,
  webSessionsAll,
  webStatusRunning,
} from "./__fixtures__";

describe("field catalog coverage: DC domain", () => {
  it("describes every leaf of the production DC payload", () => {
    const report = catalogCoverage(dcs);
    // Pinned exactly, the way the TLS and Security domains are: a bound
    // ("> 200") cannot tell a Telemt release that ADDED fields apart from
    // one that dropped them, and a reported figure nobody can reproduce is
    // worse than no figure. Twelve DCs x 16 fields plus their endpoint and
    // writer arrays and the four response-level fields.
    expect(report.total).toBe(284);
    // The message names the offenders, so a failure is actionable without
    // re-running anything locally.
    expect(report.undescribed, `undescribed DC paths:\n${report.undescribed.join("\n")}`).toEqual(
      [],
    );
  });

  it("describes one DC read as the page's entity context, not as the wire delivers it", () => {
    // The DC Details page's context is ONE DcStatus once an entity is
    // selected, so its paths are bare ("rtt_ms"), not payload-rooted
    // ("dcs[0].rtt_ms"). Both spellings must resolve — §8.3.
    const report = catalogCoverage(dcs.dcs[0]);
    expect(report.undescribed).toEqual([]);
  });

  it("describes the network_path block the DC page merges in", () => {
    const report = catalogCoverage(minimalAll.network_path?.[0] ?? {}, {
      pathPrefix: "network_path",
    });
    expect(report.undescribed).toEqual([]);
  });

  it("reports which lookup step answered for each path", () => {
    const report = catalogCoverage(dcs);
    const sources = new Set(report.rows.map((r) => r.source));
    // Every DC field resolves from a hand-written entry — never from the
    // counters-family guess, and never from the neutral fallback.
    expect(sources.has("fallback")).toBe(false);
    expect(sources.has("family")).toBe(false);
  });

  it("still flags an undescribed field, so the harness itself cannot pass vacuously", () => {
    const report = catalogCoverage({ ...dcs, a_field_from_a_future_telemt: 1 });
    expect(report.undescribed).toEqual(["a_field_from_a_future_telemt"]);
  });
});

// The TLS domain is seeded ENDPOINT-scoped (ruling R9): its record fields
// are named `total`, `limit`, `capacity`, `scope` — words every other
// Telemt payload also uses for something else, so a global entry would
// describe an unrelated field as a TLS capture bound. Both halves of that
// decision are asserted, so neither the coverage nor the scoping can drift
// before Tasks 6-8 pick the domain up.
describe("field catalog coverage: TLS domain (endpoint-scoped, ruling R9)", () => {
  it("describes every leaf of the production TLS payload", () => {
    const report = catalogCoverage(tlsFingerprints, { endpoint: TLS_FINGERPRINTS_ENDPOINT });
    expect(report.total).toBe(1955);
    expect(report.undescribed, `undescribed TLS paths:\n${report.undescribed.join("\n")}`).toEqual(
      [],
    );
  });

  it("describes NONE of them without the endpoint scope", () => {
    const report = catalogCoverage(tlsFingerprints);
    expect(report.total).toBe(1955);
    expect(report.described).toEqual([]);
  });
});

// The Security domain (§12, §20) — posture, whitelist and effective limits,
// as the `security` topic delivers them and as securityPageData spreads
// them into the page context. Global entries rather than endpoint-scoped
// ones: every path is already prefixed by its topic field.
describe("field catalog coverage: Security domain", () => {
  const context = { posture, whitelist, effective_limits: effectiveLimits };

  it("describes every leaf of the production security payload", () => {
    const report = catalogCoverage(context);
    expect(report.total).toBe(53);
    expect(
      report.undescribed,
      `undescribed security paths:\n${report.undescribed.join("\n")}`,
    ).toEqual([]);
  });

  it("never falls back to a counters-family guess or to the neutral text", () => {
    const sources = new Set(catalogCoverage(context).rows.map((row) => row.source));
    expect(sources.has("fallback")).toBe(false);
    expect(sources.has("family")).toBe(false);
  });

  it("covers a middle_proxy knob a future Telemt adds, by wildcard", () => {
    // EffectiveMiddleProxyLimits is `Record<string, unknown>`; one honest
    // wildcard describes the block rather than 21 invented sentences (§8.2
    // forbids inventing meaning for a field we have never seen).
    const report = catalogCoverage({
      effective_limits: {
        ...effectiveLimits,
        middle_proxy: { ...effectiveLimits.middle_proxy, a_knob_from_a_future_telemt: 1 },
      },
    });
    expect(report.undescribed).toEqual([]);
    const row = report.rows.find(
      (r) => r.path === "effective_limits.middle_proxy.a_knob_from_a_future_telemt",
    );
    expect(row?.source).toBe("wildcard");
  });

  it("still flags a security field nobody described", () => {
    const report = catalogCoverage({
      posture: { ...posture, a_field_from_a_future_telemt: 1 },
    });
    expect(report.undescribed).toEqual(["posture.a_field_from_a_future_telemt"]);
  });
});

// The ME domain (§8, §10, §13–16) — the largest one in the panel and the
// reason the coverage harness exists at all: 1 064 leaves, every one of them
// with a hand-written sentence rather than a suffix guess.
describe("field catalog coverage: ME domain", () => {
  const context = mePagePayload({
    meWriters,
    gates,
    initialization,
    pool: mePoolState,
    quality: meQuality,
    selftest: meSelftest,
    meRuntime,
  });

  it("describes every leaf of the production ME payload", () => {
    const report = catalogCoverage(context);
    // Pinned exactly: 46 writers x 16 fields, the 9-field summary, 13 gates,
    // 16 initialization components, the pool/quality/self-test blocks and
    // the ~55 me_runtime knobs.
    expect(report.total).toBe(1064);
    expect(report.undescribed, `undescribed ME paths:\n${report.undescribed.join("\n")}`).toEqual(
      [],
    );
  });

  it("never falls back to a counters-family guess or to the neutral text", () => {
    const sources = new Set(catalogCoverage(context).rows.map((row) => row.source));
    expect(sources.has("fallback")).toBe(false);
    expect(sources.has("family")).toBe(false);
  });

  it("keeps `pool.writers` and the top-level `writers[]` apart", () => {
    // The two spellings are different things — the pool's writer COUNTS and
    // the writer ROWS — and a shared prefix would give one of them the
    // other's sentence.
    expect(lookupField("pool.writers.total").entry?.descriptionKey).toBe("me.pool.writers.total");
    expect(lookupField("writers[0].writer_id").entry?.descriptionKey).toBe("me.writers.writer_id");
  });

  it("still flags an ME field nobody described", () => {
    const report = catalogCoverage({ summary: { a_field_from_a_future_telemt: 1 } });
    expect(report.undescribed).toEqual(["summary.a_field_from_a_future_telemt"]);
  });
});

// The Counters domain (§11) is the ONE place where the family rule of §8.2
// step 4 is the designed answer rather than a gap: Telemt's counter names
// grow with every release, and the panel describes what a suffix means
// instead of inventing meaning for a key it has never seen.
describe("field catalog coverage: Counters domain", () => {
  it("describes every documented counter of the live payload shape by hand", () => {
    // The catalog entries are pinned by count so a Telemt release that adds
    // a counter shows up here rather than as a silent family guess.
    const counters = DEFAULT_FIELD_CATALOG.entries.filter((entry) =>
      entry.descriptionKey?.startsWith("counters."),
    );
    expect(counters).toHaveLength(120);
    for (const path of [
      "core.connections_total",
      "core.handshake_failures_by_stage",
      "upstream.connect_attempt_total",
      "middle_proxy.handshake_error_codes",
      "pool.pool_swap_total",
      "desync.desync_total",
    ]) {
      expect(lookupField(path).source, path).toBe("exact");
    }
  });

  it("resolves every leaf of the production dump, and never to the neutral text", () => {
    const report = catalogCoverage(zeroAll);
    expect(report.total).toBe(120);
    const sources = report.rows.map((row) => row.source);
    // The fixture's counter names are synthesized, so they exercise exactly
    // the branch live names do not: the family rule. What must NEVER appear
    // is the neutral "no description yet" text.
    expect(sources.filter((s) => s === "fallback")).toEqual([]);
    expect(sources.filter((s) => s === "family").length).toBe(110);
  });

  it("describes the ME domain's own counters separately from the zero/all ones", () => {
    // `reconnect_attempt_total` exists in both payloads and means the same
    // thing, but the paths differ — and each carries its own sentence rather
    // than one of them borrowing the other's.
    expect(lookupField("quality.counters.reconnect_attempt_total").entry?.descriptionKey).toBe(
      "me.quality.counters.reconnect_attempt_total",
    );
    expect(lookupField("middle_proxy.reconnect_attempt_total").entry?.descriptionKey).toBe(
      "counters.middle_proxy.reconnect_attempt_total",
    );
  });
});

// The Upstreams domain (§7). Both response envelopes are keyed by their own
// prefix, so neither borrows the DC domain's `reason`/`generated_at_epoch_secs`
// — that separation is asserted here rather than left to a code comment.
describe("field catalog coverage: Upstreams domain", () => {
  const context = upstreamsPagePayload(upstreams, upstreamQuality);

  it("describes every leaf of the production upstream payload", () => {
    const report = catalogCoverage(context);
    // One upstream x (9 fields + 5 nested DC rows x 3) + 7 route totals +
    // 16 zero counters + 5 policy knobs + 2 x 3 envelope fields.
    expect(report.total).toBe(56);
    expect(
      report.undescribed,
      `undescribed upstream paths:\n${report.undescribed.join("\n")}`,
    ).toEqual([]);
  });

  it("never falls back to a counters-family guess or to the neutral text", () => {
    const sources = new Set(catalogCoverage(context).rows.map((row) => row.source));
    expect(sources.has("fallback")).toBe(false);
    expect(sources.has("family")).toBe(false);
  });

  it("keeps the two response envelopes apart from the DC domain's own", () => {
    expect(lookupField("stats.generated_at_epoch_secs").entry?.descriptionKey).toBe(
      "upstreams.stats.generated_at_epoch_secs",
    );
    expect(lookupField("upstream_quality.reason").entry?.descriptionKey).toBe(
      "upstreams.quality.reason",
    );
    // …and the bare spellings still belong to DC, untouched.
    expect(lookupField("reason").entry?.descriptionKey).toBe("dc.reason");
  });

  it("still flags an upstream field nobody described", () => {
    const report = catalogCoverage({
      upstreams: [{ a_field_from_a_future_telemt: 1 }],
    });
    expect(report.undescribed).toEqual(["upstreams[0].a_field_from_a_future_telemt"]);
  });
});

// The Connections domain (§6, §17).
describe("field catalog coverage: Connections domain", () => {
  const context = connectionsPagePayload(summary, connectionsSummary, 987_654_321);

  it("describes every leaf of the production connections payload", () => {
    const report = catalogCoverage(context);
    // 5 summary scalars + 2 x 3 class pairs + the traffic total + 4 totals +
    // 3 cache + 2 telemetry + top.limit + 2 x 10 x 3 ranking fields.
    expect(report.total).toBe(88);
    expect(
      report.undescribed,
      `undescribed connection paths:\n${report.undescribed.join("\n")}`,
    ).toEqual([]);
  });

  it("never falls back to a counters-family guess or to the neutral text", () => {
    const sources = new Set(catalogCoverage(context).rows.map((row) => row.source));
    expect(sources.has("fallback")).toBe(false);
    expect(sources.has("family")).toBe(false);
  });

  it("describes the same ranking column under both criteria", () => {
    // `by_connections` and `by_throughput` rank the SAME record shape; a
    // sentence written once for the column would be lost under the other
    // scope, so both spellings resolve exactly.
    for (const scope of ["by_connections", "by_throughput"]) {
      expect(lookupField(`top.${scope}[0].total_octets`).entry?.descriptionKey).toBe(
        "connections.top.total_octets",
      );
    }
  });

  it("still flags a connections field nobody described", () => {
    const report = catalogCoverage({ totals: { a_field_from_a_future_telemt: 1 } });
    expect(report.undescribed).toEqual(["totals.a_field_from_a_future_telemt"]);
  });
});

// The NAT/STUN domain (§15). Two fixtures, because the leaf schema really
// does differ between two healthy proxies.
describe("field catalog coverage: NAT/STUN domain", () => {
  it.each([
    ["13 configured, 10 live", natStunLive10, 31],
    ["13 configured, none live", natStunLive0, 20],
  ] as const)("describes every leaf: %s", (_name, context, total) => {
    const report = catalogCoverage(context);
    expect(report.total).toBe(total);
    expect(report.undescribed, `undescribed NAT paths:\n${report.undescribed.join("\n")}`).toEqual(
      [],
    );
    const sources = new Set(report.rows.map((row) => row.source));
    expect(sources.has("fallback")).toBe(false);
    expect(sources.has("family")).toBe(false);
  });

  it("still flags a NAT field nobody described", () => {
    const report = catalogCoverage({ flags: { a_field_from_a_future_telemt: 1 } });
    expect(report.undescribed).toEqual(["flags.a_field_from_a_future_telemt"]);
  });
});

// The Events domain (§18).
describe("field catalog coverage: Events domain", () => {
  it("describes every leaf of the fifty-record payload", () => {
    const report = catalogCoverage(eventsPagePayload(events));
    // 50 records x 4 fields + capacity + dropped_total.
    expect(report.total).toBe(202);
    expect(report.undescribed, `undescribed event paths:\n${report.undescribed.join("\n")}`).toEqual(
      [],
    );
    const sources = new Set(report.rows.map((row) => row.source));
    expect(sources.has("fallback")).toBe(false);
    expect(sources.has("family")).toBe(false);
  });

  it("keeps the timestamp a timestamp under both spellings", () => {
    // The alias exists for EntityListSection's highlight lookup; without it
    // the `_secs` family would call an epoch a duration.
    for (const path of ["events.ts_epoch_secs", "events[0].ts_epoch_secs"]) {
      expect(lookupField(path).entry?.unit, path).toBe("timestamp");
    }
  });

  it("still flags an event field nobody described", () => {
    const report = catalogCoverage({ events: [{ a_field_from_a_future_telemt: 1 }] });
    expect(report.undescribed).toEqual(["events[0].a_field_from_a_future_telemt"]);
  });
});

// L1 (task-8 review): the catalog's exact step is ONE global namespace
// (§8.2), and `summary.` is a bare prefix owned by three domains at once —
// ME, Upstreams and Connections. Nothing collides today, and the danger is
// precisely that a collision would pass every other test in this file:
// both sides stay described, `report.undescribed` stays empty, and one
// domain simply starts explaining the other's number.
describe("field catalog: the shared global prefixes", () => {
  it("never lets two entries claim one path with different sentences", () => {
    const byPath = new Map<string, Set<string>>();
    for (const entry of DEFAULT_FIELD_CATALOG.entries) {
      const keys = byPath.get(entry.path) ?? new Set<string>();
      keys.add(entry.descriptionKey ?? entry.path);
      byPath.set(entry.path, keys);
    }
    const collisions = [...byPath]
      .filter(([, keys]) => keys.size > 1)
      .map(([path, keys]) => `${path} -> ${[...keys].join(" | ")}`);
    expect(
      collisions,
      `two domains describe one path differently:\n${collisions.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps `summary.*` unambiguous across the three domains that share it", () => {
    // Named on its own because the compiled catalog resolves an exact path
    // with a Map: a second `summary.x` would not error, it would WIN, and
    // the loser's page would carry a sentence about somebody else's field.
    const seen = new Map<string, number>();
    for (const entry of DEFAULT_FIELD_CATALOG.entries) {
      if (!entry.path.startsWith("summary.")) continue;
      seen.set(entry.path, (seen.get(entry.path) ?? 0) + 1);
    }
    // The prefix is real — this is not a test that passes on an empty set.
    expect(seen.size).toBeGreaterThan(20);
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([path]) => path);
    expect(duplicated, `duplicated summary.* paths:\n${duplicated.join("\n")}`).toEqual([]);
  });
});

// The WEB domain (M4 task 8b), ENDPOINT-scoped for the same reason the TLS
// one is (R9): `manager`, `budget`, `streams`, `limits`, `permits`, `state`,
// `attempt`, `host`, `user` and `reason` all mean something else somewhere
// else in Telemt's API.
describe("field catalog coverage: WEB domain (endpoint-scoped, ruling R9)", () => {
  const context = webPagePayload(webStatusRunning, [webSessionsAll])!;

  it("describes every leaf of the recorded status plus a full session page", () => {
    const report = catalogCoverage(context, { endpoint: WEB_ENDPOINT });
    // Pinned exactly, like DC and TLS: a bound cannot tell a Telemt release
    // that ADDED fields apart from one that dropped them. 46 [web.limits]
    // keys + 8 permits x 5 + 10 capture-policy keys + the six planes' own
    // fields + 24 session rows + the envelope, totals and scan fields.
    expect(report.total).toBe(750);
    expect(report.undescribed, `undescribed WEB paths:\n${report.undescribed.join("\n")}`).toEqual(
      [],
    );
  });

  it("describes NONE of them through a WEB entry without the endpoint scope", () => {
    // The proof that the scoping is real: unscoped, `runtime.manager.sessions`
    // and friends must not resolve to a WEB sentence.
    for (const path of [
      "runtime.manager.sessions",
      "runtime.limits.max_sessions_global",
      "sessions.rows[0].carrier",
      "lifecycle",
    ]) {
      expect(lookupField(path).entry?.descriptionKey ?? "", path).not.toMatch(/^web\./);
      expect(
        lookupField(path, { endpoint: WEB_ENDPOINT }).entry?.descriptionKey,
        path,
      ).toMatch(/^web\./);
    }
  });

  it("never falls back to a counters-family guess or to the neutral text", () => {
    const sources = new Set(
      catalogCoverage(context, { endpoint: WEB_ENDPOINT }).rows.map((row) => row.source),
    );
    expect(sources.has("fallback")).toBe(false);
    expect(sources.has("family")).toBe(false);
  });

  it("keeps a busy-plane payload described too", () => {
    // A contended plane arrives as null. The path disappears from the walk,
    // so this proves nothing NEW appears — the shape must not grow leaves
    // the catalog has never seen.
    const busy = webPagePayload(
      { ...webStatusRunning, runtime: { ...webStatusRunning.runtime!, manager: null, partial: ["manager"] } },
      null,
    )!;
    expect(catalogCoverage(busy, { endpoint: WEB_ENDPOINT }).undescribed).toEqual([]);
  });

  it("describes the highlight spelling as well as the indexed one (§8.3)", () => {
    // EntityListSection looks a highlight up as `sessions.rows.<field>`
    // (no index) while the surface uses `sessions.rows[0].<field>`. Both
    // must land on the same sentence, or a row's headline value would be
    // described as an unknown parameter.
    for (const field of ["streams", "age_ms"]) {
      const bare = lookupField(`sessions.rows.${field}`, { endpoint: WEB_ENDPOINT });
      const indexed = lookupField(`sessions.rows[0].${field}`, { endpoint: WEB_ENDPOINT });
      expect(bare.entry?.descriptionKey, field).toBe(indexed.entry?.descriptionKey);
      expect(bare.entry?.descriptionKey, field).toBe(`web.session.${field}`);
    }
  });

  it("still flags a WEB field nobody described", () => {
    const report = catalogCoverage(
      { runtime: { manager: { a_field_from_a_future_telemt: 1 } } },
      { endpoint: WEB_ENDPOINT },
    );
    expect(report.undescribed).toEqual(["runtime.manager.a_field_from_a_future_telemt"]);
  });
});
