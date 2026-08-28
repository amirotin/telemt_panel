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
// The unknown tail is ALLOWED to be non-empty at this stage: most domains
// have no definition yet, so their whole payload lands in the tail. The
// counts are reported per fixture below (and in task-2-report.md) so Tasks
// 6–8 can watch them fall as each domain gets a real definition.

import { describe, expect, it } from "vitest";
import { resolveSections } from "./resolveSections";
import { emptyDefinition, richContexts, richDefinitions } from "./__fixtures__/definitions";
import type { AnyDefinition } from "./__fixtures__/definitions";
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
} from "./__fixtures__";

interface Case {
  name: string;
  definition: AnyDefinition;
  context: unknown;
}

function plain(name: string, context: unknown): Case {
  return { name, definition: emptyDefinition(name), context };
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
  plain("nat-stun-live-10", natStunLive10),
  plain("nat-stun-live-7", natStunLive7),
  plain("nat-stun-live-0", natStunLive0),
  plain("connections-summary", connectionsSummary),
  plain("events", events),
  plain("summary", summary),
  plain("upstreams", upstreams),
  plain("upstream-quality", upstreamQuality),
  plain("zero-all", zeroAll),
  plain("minimal-all", minimalAll),
  plain("posture", posture),
  plain("whitelist", whitelist),
  plain("effective-limits", effectiveLimits),
  plain("tls-fingerprints", tlsFingerprints),

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

  it("every explicitly ignored path carries a reason (§24.2)", () => {
    for (const testCase of CASES) {
      const result = resolveSections({
        definition: testCase.definition,
        context: testCase.context,
      });
      for (const ignored of result.ignoredPaths) {
        expect(ignored.reason.trim(), `${testCase.name}: ${ignored.path}`).not.toBe("");
      }
    }
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
    expect(report.filter((r) => r.consumed > 0).length).toBeGreaterThanOrEqual(7);
    for (const row of report) {
      expect(row.all).toBe(row.consumed + row.ignored + row.unknown);
    }
  });
});
