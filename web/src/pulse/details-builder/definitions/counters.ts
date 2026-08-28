// The Counters Details page (spec §23.4), as a declarative definition.
//
// What it replaces: `countersGroups` + `flattenToRows` produced ~115 KV rows
// with one search box over them and nothing else — no description, no
// grouping a reader could collapse, no way to tell a counter that is moving
// from one that has never moved (TELEMT_LIVE_API_DATA §11, §22).
//
// §23.4's page is the same data with five accordions, search over key AND
// description, a non-zero filter, and the client-side deltas of ruling R4.
// Two properties are load-bearing:
//
//   * the KEY IS DATA (§11.2). Every counter name is printed verbatim, and
//     a counter a future Telemt adds appears in its group on its own,
//     described by the catalog's family rule rather than dropped;
//   * the two `{class,total}` arrays and `handshake_error_codes` are
//     BREAKDOWNS, declared before the map so it stops nesting them inside a
//     group — §23.4's "не строка `N items`".

import type { ZeroAllData } from "../../../lib/api/generated/types.gen";
import type { DetailPageDefinition, SummaryTone } from "../model";

export const COUNTERS_PAGE_ID = "pulse.counters";

/** The five sections `GET /v1/stats/zero/all` carries, in the spec's order. */
export const COUNTER_GROUP_PATHS = [
  "core",
  "upstream",
  "middle_proxy",
  "pool",
  "desync",
] as const;

export type CounterGroupPath = (typeof COUNTER_GROUP_PATHS)[number];

/**
 * Key names that mark a counter as a failure rather than as throughput.
 * Deliberately the SAME shapes the catalog's `errorsTotal` family matches,
 * so the «Errors and drops» tile and the description under a row can never
 * disagree about what counts as an error.
 */
const ERROR_KEY = /(errors?|failures?|failed|fail|drops?|drop|reject|timeouts?|invalid)/;

interface CounterLeaf {
  path: string;
  key: string;
  value: unknown;
}

// counterLeaves enumerates the scalar leaves of the five groups. Nested
// containers are skipped: they are breakdowns with sections of their own,
// and counting their elements as counters would inflate every tile.
export function counterLeaves(data: ZeroAllData | null | undefined): CounterLeaf[] {
  if (!data) return [];
  const out: CounterLeaf[] = [];
  for (const group of COUNTER_GROUP_PATHS) {
    const section = (data as unknown as Record<string, unknown>)[group];
    if (section === null || typeof section !== "object" || Array.isArray(section)) continue;
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      if (value !== null && typeof value === "object") continue;
      out.push({ path: `${group}.${key}`, key, value });
    }
  }
  return out;
}

/** Non-zero in the same sense the map's own filter uses it (§23.4). */
function isNonZero(value: unknown): boolean {
  return value !== 0 && value !== null && value !== undefined && value !== false;
}

export function counterTotal(data: ZeroAllData | null | undefined): number | null {
  if (!data) return null;
  return counterLeaves(data).length;
}

export function nonZeroCounters(data: ZeroAllData | null | undefined): number | null {
  if (!data) return null;
  return counterLeaves(data).filter((leaf) => isNonZero(leaf.value)).length;
}

// errorCounters counts the failure counters that have actually fired. A zero
// error counter is good news, not an entry in an "errors" tile.
export function errorCounters(data: ZeroAllData | null | undefined): number | null {
  if (!data) return null;
  return counterLeaves(data).filter(
    (leaf) => ERROR_KEY.test(leaf.key) && typeof leaf.value === "number" && leaf.value > 0,
  ).length;
}

function errorTone(data: ZeroAllData): SummaryTone {
  const errors = errorCounters(data);
  if (errors === null) return "neutral";
  return errors > 0 ? "warn" : "good";
}

export const countersPageDefinition: DetailPageDefinition<ZeroAllData, ZeroAllData> = {
  id: COUNTERS_PAGE_ID,
  title: (s) => s.details.pages.counters.title,
  description: (s) => s.details.pages.counters.description,

  // Fetch-on-visit REST rather than an SSE topic: the dump is a diagnostic
  // snapshot, and R4's deltas come from polling it, not from a topic.
  sources: [{ id: "zero", endpoint: "/api/telemt/zero", required: true }],

  freshness: { atEpochMs: (p) => (p.generated_at_epoch_secs ?? 0) * 1000 || null },

  summary: [
    {
      id: "total",
      label: (s) => s.details.pages.counters.totalTile,
      value: counterTotal,
      format: "integer",
    },
    {
      id: "non_zero",
      label: (s) => s.details.pages.counters.nonZeroTile,
      value: nonZeroCounters,
      format: "integer",
    },
    {
      id: "errors",
      label: (s) => s.details.pages.counters.errorsTile,
      value: errorCounters,
      format: "integer",
      tone: errorTone,
    },
    {
      id: "groups",
      label: (s) => s.details.pages.counters.groupsTile,
      value: () => COUNTER_GROUP_PATHS.length,
      format: "integer",
    },
  ],

  sections: [
    // Declared BEFORE the map: an explicitly configured section owns its
    // path, and SectionList then stops DynamicMapSection from showing the
    // same array nested inside its group.
    {
      kind: "breakdown",
      id: "connections_bad_by_class",
      title: () => "connections_bad_by_class[]",
      description: (s) => s.details.pages.counters.connectionsBadByClass,
      sourceId: "zero",
      path: "core.connections_bad_by_class",
      defaultExpanded: true,
    },
    {
      kind: "breakdown",
      id: "handshake_failures_by_class",
      title: () => "handshake_failures_by_class[]",
      description: (s) => s.details.pages.counters.handshakeFailuresByClass,
      sourceId: "zero",
      path: "core.handshake_failures_by_class",
      defaultExpanded: true,
    },
    // Empty on every VPS of the live snapshot: the section stays visible and
    // says so, which is §10.3's "пустой массив ≠ отсутствующее поле".
    {
      kind: "breakdown",
      id: "handshake_error_codes",
      title: () => "handshake_error_codes[]",
      description: (s) => s.details.pages.counters.handshakeErrorCodes,
      sourceId: "zero",
      path: "middle_proxy.handshake_error_codes",
      defaultExpanded: true,
    },
    // The response's own generation stamp. It is NOT a counter, so it is a
    // row of its own rather than a sixth group — and declaring it is what
    // keeps the map (which owns the whole context) from consuming a field
    // nothing would then draw.
    {
      kind: "scalars",
      id: "metadata",
      title: (s) => s.details.pages.counters.metadata,
      sourceId: "zero",
      defaultExpanded: false,
      fields: [{ path: "generated_at_epoch_secs" }],
    },
    {
      kind: "dynamicMap",
      id: "all",
      title: (s) => s.details.pages.counters.all,
      description: (s) => s.details.pages.counters.allDescription,
      sourceId: "zero",
      path: "",
      defaultExpanded: true,
      supportsDelta: true,
      groups: [
        { id: "core", title: (s) => s.details.pages.counters.groups.core, path: "core" },
        {
          id: "upstream",
          title: (s) => s.details.pages.counters.groups.upstream,
          path: "upstream",
        },
        {
          id: "middle_proxy",
          title: (s) => s.details.pages.counters.groups.middleProxy,
          path: "middle_proxy",
        },
        { id: "pool", title: (s) => s.details.pages.counters.groups.pool, path: "pool" },
        { id: "desync", title: (s) => s.details.pages.counters.groups.desync, path: "desync" },
      ],
    },
  ],

  // Ruling R2: the deep dump of anything the five groups did not cover is
  // extended-mode only, closed by default, and last.
  unknownFields: { minMode: "extended", rawJson: true },
};

// generated_at_epoch_secs is the one field the catalog reaches through the
// DC domain's entry for the same concept; re-exported here so the page's
// test can name it without importing the DC module.
export const COUNTERS_METADATA_PATH = "generated_at_epoch_secs";
