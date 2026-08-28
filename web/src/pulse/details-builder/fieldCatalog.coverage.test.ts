// The catalog coverage harness (owner decision 2026-08-26: "каталог
// описаний полей в репо с тестом покрытия и пунктом чек-листа при бампе
// Telemt").
//
// This is the test that turns "a new Telemt release added a field" into a
// red CI run instead of an undescribed row nobody notices. Asserted on the
// five migrated domains: DC (Task 2), TLS and Security (Task 6), ME and
// Counters (Task 7). Task 8 adds its own fixtures as it migrates the rest,
// and the Telemt-bump checklist points at this file.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIELD_CATALOG,
  catalogCoverage,
  lookupField,
  TLS_FINGERPRINTS_ENDPOINT,
} from "./fieldCatalog";
import { mePagePayload } from "../diag/me.helpers";
import {
  dcs,
  effectiveLimits,
  gates,
  initialization,
  mePoolState,
  meQuality,
  meRuntime,
  meSelftest,
  meWriters,
  minimalAll,
  posture,
  tlsFingerprints,
  whitelist,
  zeroAll,
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
