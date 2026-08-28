// The catalog coverage harness (owner decision 2026-08-26: "каталог
// описаний полей в репо с тестом покрытия и пунктом чек-листа при бампе
// Telemt").
//
// This is the test that turns "a new Telemt release added a field" into a
// red CI run instead of an undescribed row nobody notices. Today it is
// asserted on the DC domain only — the worked example Task 2 seeds. Tasks
// 6–8 add their own fixture here as they migrate a domain, and the
// Telemt-bump checklist points at this file.
import { describe, expect, it } from "vitest";
import { catalogCoverage, TLS_FINGERPRINTS_ENDPOINT } from "./fieldCatalog";
import {
  dcs,
  effectiveLimits,
  minimalAll,
  posture,
  tlsFingerprints,
  whitelist,
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
