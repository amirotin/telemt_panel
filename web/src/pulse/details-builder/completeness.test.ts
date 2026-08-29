// Checkpoint R1 — the completeness guarantee (ruling R7, spec §27.4).
//
// From this task onwards, "ничего не теряется" lives here and nowhere else:
// for EVERY Task 1 fixture, with a page definition attached,
//
//     all normalized leaf paths
//   − explicitly consumed paths
//   − explicitly ignored paths (each with a reason)
//   = paths rendered in the unknown fallback
//
// and the remainder MUST be empty. A field can only disappear through one
// of §24.2's three outcomes; a fourth — silently — is what this test makes
// impossible, before a single renderer exists to look at.
//
// The unknown tail is ALLOWED to be non-empty for a fixture with no page
// definition — a raw topic snapshot, an edge shape nobody renders whole.
// Every fixture that HAS one drives it to zero, which since Task 8 is every
// production domain; the counts are reported per fixture below.

import { describe, expect, it } from "vitest";
import { resolveSections } from "./resolveSections";
import { emptyDefinition, richContexts, richDefinitions } from "./__fixtures__/definitions";
import type { AnyDefinition } from "./__fixtures__/definitions";
import {
  connectionsPageDefinition,
  eventsPageDefinition,
  natPageDefinition,
  upstreamsPageDefinition,
  webPageDefinition,
} from "./definitions";
import { webPagePayload } from "../diag/web.helpers";
import { connectionsPagePayload } from "../diag/connections.helpers";
import { eventsPagePayload } from "../diag/events.helpers";
import { upstreamsPagePayload } from "../diag/upstreams.helpers";
import {
  connectionsSummary,
  dcAllFalsy,
  dcEndpointVariants,
  dcEndpointWriterVariants,
  dcs,
  effectiveLimits,
  events,
  gatedOff,
  gatedUnavailable,
  initialization,
  mePoolState,
  meQuality,
  meSelftest,
  meWriterVariants,
  meWriters,
  minimalAll,
  natStunLive0,
  natStunLive7,
  natStunLive10,
  natStunNoReflection,
  posture,
  runtimeSnapshot,
  securitySnapshot,
  selftestAllNullable,
  statsSnapshot,
  stunLiveVariants,
  summary,
  tlsByFingerprintVariants,
  tlsFingerprints,
  tlsRowLongIdentifiers,
  upstreamQuality,
  upstreams,
  upstreamsSnapshot,
  whitelist,
  writerAllNull,
  zeroAll,
  webSessionsAll,
  webSessionsManagerBusy,
  webStatusNoListener,
  webStatusPartialPlanes,
  webStatusRunning,
} from "./__fixtures__";

interface Case {
  name: string;
  definition: AnyDefinition;
  context: unknown;
}

function plain(name: string, context: unknown): Case {
  return { name, definition: emptyDefinition(name), context };
}

function defined(name: string, definition: unknown, context: unknown): Case {
  return { name, definition: definition as AnyDefinition, context };
}

// Every fixture Task 1 exports, each with a definition. The seven with a
// real definition exercise the consumed side of the equation; the rest
// exercise the tail.
const CASES: Case[] = [
  // --- fixtures with a real (test-only) page definition ---------------
  { name: "dc (defined)", definition: richDefinitions.dc, context: richContexts.dc },
  {
    name: "me-writers (defined)",
    definition: richDefinitions.meWriters,
    context: richContexts.meWriters,
  },
  {
    name: "counters (defined)",
    definition: richDefinitions.counters,
    context: richContexts.counters,
  },
  {
    name: "initialization (defined)",
    definition: richDefinitions.initialization,
    context: richContexts.initialization,
  },
  { name: "tls (defined)", definition: richDefinitions.tls, context: richContexts.tls },
  { name: "summary (defined)", definition: richDefinitions.summary, context: richContexts.summary },
  { name: "minimal (defined)", definition: richDefinitions.minimal, context: richContexts.minimal },

  // --- production-size payloads, no definition yet --------------------
  plain("dcs", dcs),
  plain("me-writers", meWriters),
  plain("initialization", initialization),
  plain("me-pool-state", mePoolState),
  plain("me-quality", meQuality),
  plain("me-selftest", meSelftest),
  plain("summary", summary),
  plain("zero-all", zeroAll),
  plain("minimal-all", minimalAll),
  plain("posture", posture),
  plain("whitelist", whitelist),
  plain("effective-limits", effectiveLimits),
  plain("tls-fingerprints", tlsFingerprints),

  // --- Task 8's four domains, with their production definitions -------
  //
  // Attached here as well as in their own definition tests, so the ONE
  // place that runs the §27.4 equation over every fixture in the repo sees
  // the same zero tail the domain tests assert.
  defined("nat-stun-live-10 (defined)", natPageDefinition, natStunLive10),
  defined("nat-stun-live-7 (defined)", natPageDefinition, natStunLive7),
  defined("nat-stun-live-0 (defined)", natPageDefinition, natStunLive0),
  defined(
    "connections (defined)",
    connectionsPageDefinition,
    connectionsPagePayload(summary, connectionsSummary, 123_456),
  ),
  defined("events (defined)", eventsPageDefinition, eventsPagePayload(events)),
  defined(
    "upstreams (defined)",
    upstreamsPageDefinition,
    upstreamsPagePayload(upstreams, upstreamQuality),
  ),

  // --- Task 8b's WEB domain, on the RECORDED 3.5.5 status ---------------
  defined(
    "web: running + sessions (defined)",
    webPageDefinition,
    webPagePayload(webStatusRunning, [webSessionsAll]),
  ),
  defined(
    "web: no listener (defined)",
    webPageDefinition,
    webPagePayload(webStatusNoListener, null),
  ),
  defined(
    "web: contended planes (defined)",
    webPageDefinition,
    webPagePayload(webStatusPartialPlanes, null),
  ),
  defined(
    "web: manager lock busy (defined)",
    webPageDefinition,
    webPagePayload(webStatusRunning, [webSessionsManagerBusy]),
  ),

  // --- composed topic snapshots (what a page actually receives) -------
  plain("topic: stats", statsSnapshot),
  plain("topic: runtime", runtimeSnapshot),
  plain("topic: upstreams", upstreamsSnapshot),
  plain("topic: security", securitySnapshot),

  // --- edge fixtures (spec §27.2) --------------------------------------
  plain("dc: all falsy", dcAllFalsy),
  plain("writer: all null", writerAllNull),
  plain("selftest: all nullable", selftestAllNullable),
  plain("nat: no reflection", natStunNoReflection),
  plain("tls row: long identifiers", tlsRowLongIdentifiers),
  plain("gated: off", gatedOff()),
  plain("gated: unavailable", gatedUnavailable()),
  ...(["absent", "empty", "one", "many"] as const).flatMap((variant) => [
    plain(`dc endpoints: ${variant}`, dcEndpointVariants[variant]),
    plain(`dc endpoint_writers: ${variant}`, dcEndpointWriterVariants[variant]),
    plain(`me writers: ${variant}`, meWriterVariants[variant]),
    plain(`tls by_fingerprint: ${variant}`, tlsByFingerprintVariants[variant]),
    plain(`stun live: ${variant}`, stunLiveVariants[variant]),
  ]),
];

/** The cases carrying a real page definition from `./definitions`. */
const PRODUCTION_CASES = new Set([
  "nat-stun-live-10 (defined)",
  "nat-stun-live-7 (defined)",
  "nat-stun-live-0 (defined)",
  "connections (defined)",
  "events (defined)",
  "upstreams (defined)",
  "web: running + sessions (defined)",
  "web: no listener (defined)",
  "web: contended planes (defined)",
  "web: manager lock busy (defined)",
]);

describe("checkpoint R1: no field is ever silently lost (spec §27.4)", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    const result = resolveSections({
      definition: testCase.definition,
      context: testCase.context,
    });

    // The equation itself. `lostPaths` is the remainder; it MUST be empty.
    expect(
      result.lostPaths,
      `paths accounted for by no section, no ignore rule and no unknown tail:\n${result.lostPaths.join("\n")}`,
    ).toEqual([]);

    // …and the three terms must partition the whole, with no path counted
    // twice (which would hide a loss elsewhere).
    const union = new Set([
      ...result.consumedPaths,
      ...result.ignoredPaths.map((p) => p.path),
      ...result.unknownPaths,
    ]);
    expect(union.size).toBe(result.allPaths.length);
    expect(
      result.consumedPaths.length + result.ignoredPaths.length + result.unknownPaths.length,
    ).toBe(result.allPaths.length);
  });

  it("every explicitly ignored path carries a non-empty path and a reason (§24.2)", () => {
    for (const testCase of CASES) {
      const rules = testCase.definition.unknownFields?.ignore ?? [];
      for (const rule of rules) {
        // An empty path is "under" every path, so ONE such rule would mark
        // the whole payload intentionally dropped and leave this checkpoint
        // passing on an empty remainder. resolveSections rejects it; this
        // asserts no definition in the repo tries.
        expect(rule.path.trim(), `${testCase.name}: ignore rule with an empty path`).not.toBe("");
        expect(rule.reason.trim(), `${testCase.name}: ${rule.path}`).not.toBe("");
      }
      const result = resolveSections({
        definition: testCase.definition,
        context: testCase.context,
      });
      for (const ignored of result.ignoredPaths) {
        expect(ignored.reason.trim(), `${testCase.name}: ${ignored.path}`).not.toBe("");
      }
      // …and no definition may ignore its way out of the checkpoint: an
      // ignore list that covers most of a payload is not a policy decision,
      // it is the guarantee being switched off.
      expect(result.ignoredPaths.length, testCase.name).toBeLessThan(
        Math.max(1, result.allPaths.length * 0.1),
      );
    }
  });

  it("refuses a definition that would ignore the entire payload", () => {
    const swallowEverything = {
      id: "dev.malicious",
      title: () => "t",
      sources: [],
      sections: [],
      unknownFields: { ignore: [{ path: "", reason: "looks legitimate" }] },
    };
    expect(() =>
      resolveSections({ definition: swallowEverything, context: { a: 1, b: { c: 2 } } }),
    ).toThrow(/empty path/);
  });

  it("refuses an ignore rule with no reason (§24.2)", () => {
    const noReason = {
      id: "dev.no-reason",
      title: () => "t",
      sources: [],
      sections: [],
      unknownFields: { ignore: [{ path: "a", reason: "  " }] },
    };
    expect(() => resolveSections({ definition: noReason, context: { a: 1 } })).toThrow(/no reason/);
  });

  it("no array ever reaches a scalar row, on any fixture (§12.7)", () => {
    for (const testCase of CASES) {
      const result = resolveSections({
        definition: testCase.definition,
        context: testCase.context,
      });
      for (const section of result.sections) {
        if (section.kind !== "scalars") continue;
        for (const row of section.rows) {
          expect(Array.isArray(row.value), `${testCase.name}: ${row.path}`).toBe(false);
          expect(row.value === null || typeof row.value !== "object").toBe(true);
        }
      }
    }
  });

  it("reports the unknown-fields tail size per fixture", () => {
    // Not an assertion about the numbers — a printed inventory. Tasks 6–8
    // drive these toward zero one domain at a time; task-2-report.md
    // records today's values.
    const report = CASES.map((testCase) => {
      const result = resolveSections({
        definition: testCase.definition,
        context: testCase.context,
      });
      return {
        fixture: testCase.name,
        all: result.allPaths.length,
        consumed: result.consumedPaths.length,
        ignored: result.ignoredPaths.length,
        unknown: result.unknownPaths.length,
      };
    });
    // Every fixture accounted for, and at least the seven defined ones
    // actually consume something.
    expect(report.length).toBe(CASES.length);
    expect(report.filter((r) => r.consumed > 0).length).toBeGreaterThanOrEqual(13);
    // Every case built from a PRODUCTION definition leaves nothing in the
    // tail — the promise Task 8 was measured against. (The older
    // "(defined)" cases are Task 2's test-only drafts, which deliberately
    // exercise a NON-empty tail.)
    for (const row of report.filter((r) => PRODUCTION_CASES.has(r.fixture))) {
      expect(row.unknown, row.fixture).toBe(0);
    }
    for (const row of report) {
      expect(row.all).toBe(row.consumed + row.ignored + row.unknown);
    }
  });
});
