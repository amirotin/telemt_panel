// Page definitions for the DEV-only /dev/details route.
//
// DC and Security/TLS are the PRODUCTION definitions
// (details-builder/definitions/), rendered here over the Task 1 fixtures so
// the renderers can be exercised and screenshotted against
// production-sized payloads — including the REST source states
// (`unsupported`, `stale`, …) that no live stand reproduces on demand. The
// remaining pages are still drafts for the domains Tasks 7–8 own.
//
// This module is only ever reached through routes/dev/details.tsx's
// `import.meta.env.DEV` guard, which is what makes importing the test
// fixtures here legitimate: Vite replaces the constant with `false` in a
// production build and Rollup drops the whole graph.

import type {
  DcEndpointWriters,
  DcStatusData,
  RuntimeEdgeEventRecord,
  RuntimeEdgeEvents,
} from "../realtime/topics";
import type { TlsFingerprintRow, ZeroAllData } from "../lib/api/generated/types.gen";
import type {
  DetailPageDefinition,
  RankingSectionDefinition,
  SectionDefinition,
} from "../pulse/details-builder";
import { mePagePayload } from "../pulse/diag/me.helpers";
import {
  countersPageDefinition,
  dcPageDefinition,
  mePageDefinition,
  securityPageDefinition,
  type DcPageContext,
  type DcPagePayload,
  type MePagePayload,
  type SecurityPageData,
} from "../pulse/details-builder/definitions";
import {
  dcs,
  events,
  gates,
  initialization,
  mePoolState,
  meQuality,
  meRuntime,
  meSelftest,
  meWriters,
  tlsFingerprints,
  zeroAll,
} from "../pulse/details-builder/__fixtures__";

// Re-exported so the harness and the production page cannot key entities
// two different ways.
export { dcEntityKey as dcKey } from "../pulse/details-builder/definitions";

// --- DC: the PRODUCTION definition, with one harness-only override ------

// Since M4 task 6 the DC page is real (pulse/diag/DcPage.tsx renders
// definitions/dc.ts), so the harness renders the same definition rather
// than a parallel copy that could drift away from it.
//
// The single override is `endpoint_writers`: §23.1 makes it an ArraySection
// and production follows the spec, but it is also the ONLY DC array whose
// rows are records — and therefore the only way to put a §17 detail surface
// on a page that ALSO carries an entity selector, which is what
// "a swipe does nothing while a surface is open" and "a rotation keeps the
// open surface" need in order to be driven end to end
// (e2e/details.spec.ts). The harness swaps that one section to §9.3.
const endpointWritersAsEntityList: SectionDefinition<DcPageContext> = {
  kind: "entityList",
  id: "endpoint_writers",
  title: () => "endpoint_writers[]",
  path: "endpoint_writers",
  itemKey: (item, i) => `ew-${(item as DcEndpointWriters).endpoint}-${i}`,
  identity: (item) => (item as DcEndpointWriters).endpoint,
  highlights: ["active_writers"],
};

export const devDcPage: DetailPageDefinition<DcPagePayload, DcPageContext> = {
  ...dcPageDefinition,
  id: "dev.dc",
  sections: dcPageDefinition.sections.map((section) =>
    section.id === "endpoint_writers" ? endpointWritersAsEntityList : section,
  ),
};

// --- ME: the PRODUCTION definition over the composed fixture (§23.2) -----
//
// Since M4 task 7 the ME page is real (pulse/diag/MePage.tsx renders
// definitions/me.ts) and the harness renders the same definition rather
// than the two drafts it used to carry — an "ME quality" page and an
// "ME init" page, both of which are now tabs of this one.

export const devMePayload = mePagePayload({
  meWriters,
  gates,
  initialization,
  pool: mePoolState,
  quality: meQuality,
  selftest: meSelftest,
  meRuntime,
}) as MePagePayload;

export const devMePage: DetailPageDefinition<MePagePayload, MePagePayload> = {
  ...mePageDefinition,
  id: "dev.me",
};

// --- Events: the timeline kind over 50 sequenced records (§23.6) ---------

const eventOf = (item: unknown) => item as RuntimeEdgeEventRecord;

export const devEventsPage: DetailPageDefinition<RuntimeEdgeEvents, RuntimeEdgeEvents> = {
  id: "dev.events",
  title: () => "Events",
  sources: [{ id: "runtime", topic: "runtime", required: true }],
  sections: [
    {
      kind: "timeline",
      id: "events",
      title: () => "events[]",
      path: "events",
      defaultExpanded: true,
      itemKey: (item) => String(eventOf(item).seq),
      status: (item) => eventOf(item).event_type,
      step: (item) => eventOf(item).context ?? "",
      details: (item) => `seq ${eventOf(item).seq}`,
      atEpochMs: (item) => eventOf(item).ts_epoch_secs * 1000,
    },
  ],
  unknownFields: { minMode: "extended", rawJson: true },
};

// --- Security / TLS: four RANKINGS over 4×50 records (§23.3) -------------

const rowOf = (item: unknown) => item as TlsFingerprintRow;

// RECENT_SINCE — "seen within the last hour" against the fixed dev clock.
// A domain-relevant state (§18.2 permits filters only for those), and one
// the fixture genuinely splits on, so the shortcut has visible work to do.
export const RECENT_SINCE_EPOCH_SECS = 1_755_996_525;
export const RECENT_FILTER_KEY = "tls.recent";

const isRecent = (item: unknown) => rowOf(item).last_seen_epoch_secs >= RECENT_SINCE_EPOCH_SECS;

// Since M4 task 6 the four rankings are the production ones
// (definitions/security.ts). The harness keeps two things the real page
// deliberately does NOT have:
//
//   * §18.2's interactive summary shortcut, and the domain-relevant filter
//     it aims at. Live Telemt reports `bad_or_probe: 0` everywhere and a
//     fixed dev clock is the only way to make "recently seen" split a list,
//     so the demonstration lives here rather than on a page where the
//     control would never have anything to do;
//   * a four-tab navigation without the posture tab, because the harness
//     feeds this definition a bare TLS payload with no `security` topic
//     behind it.
const RANKING_IDS = ["by_fingerprint", "by_ip", "by_cidr", "by_user"] as const;

function withRecentFilter(section: SectionDefinition<SecurityPageData>) {
  if (section.kind !== "ranking") return section;
  const ranking = section as RankingSectionDefinition<SecurityPageData, unknown>;
  return {
    ...ranking,
    scoreLabel: () => "observed",
    filters: [{ key: RECENT_FILTER_KEY, label: () => "Recently seen", predicate: isRecent }],
  };
}

const totalOf = (rows: TlsFingerprintRow[] | undefined, pick: (r: TlsFingerprintRow) => number) =>
  (rows ?? []).reduce((sum, row) => sum + pick(row), 0);

export const devTlsPage: DetailPageDefinition<SecurityPageData, SecurityPageData> = {
  ...securityPageDefinition,
  id: "dev.tls",
  summary: [
    ...(securityPageDefinition.summary ?? []).filter((m) => m.id !== "whitelist_size"),
    // §18.2: the tile applies the same filter the chip under each ranking
    // toggles, and sorts the fingerprint ranking by recency.
    {
      id: "recent",
      label: () => "Recently seen",
      value: (p) => (p.by_fingerprint ?? []).filter(isRecent).length,
      format: "integer",
      tone: "good",
      shortcut: {
        filter: { key: RECENT_FILTER_KEY, value: true },
        sort: {
          key: "last_seen_epoch_secs",
          direction: "desc",
          sectionId: "by_fingerprint",
        },
      },
    },
  ],
  navigation: {
    tabs: [
      { id: "fingerprints", label: () => "Fingerprints", sections: ["capture", "by_fingerprint"] },
      { id: "ip", label: () => "IP", sections: ["by_ip"] },
      { id: "cidr", label: () => "CIDR", sections: ["by_cidr"] },
      { id: "users", label: () => "Users", sections: ["by_user"] },
    ],
  },
  sections: securityPageDefinition.sections
    .filter((section) => section.id === "capture" || RANKING_IDS.includes(section.id as never))
    .map(withRecentFilter),
};

export { totalOf as devTlsTotalOf };

// --- Counters: the PRODUCTION definition (§23.4) -------------------------
//
// Also real since M4 task 7. The harness keeps rendering it over the
// fixture so the five groups, the search and the non-zero filter can be
// screenshotted at production volume without a Telemt behind them; the
// client-side deltas (R4) need two consecutive answers and therefore only
// exist on the live page.

export const devCountersPage: DetailPageDefinition<ZeroAllData, ZeroAllData> = {
  ...countersPageDefinition,
  id: "dev.counters",
};

// dcsWithAttention degrades the LAST data center of the rail on purpose.
//
// The shared fixture is uniformly healthy, so nothing in it raises an
// attention marker — and the marker on the RIGHTMOST chip is exactly the
// shape that broke /pulse/diag/dc against live data: its `sr-only` reason
// is `position: absolute`, so without a positioned ancestor it is laid out
// at the chip's static position, escapes the strip's overflow clip and
// widens the document (286 px on the live twelve). The Go mock serves a
// single DC, so this harness is the only stand where the horizontal
// overflow e2e guard can reproduce the failure at all.
const dcsWithAttention: DcStatusData = {
  ...dcs,
  dcs: dcs.dcs.map((dc, i) =>
    i === dcs.dcs.length - 1 ? { ...dc, coverage_pct: 62, fresh_coverage_pct: 41 } : dc,
  ),
};

export const devPayloads = {
  dc: dcsWithAttention,
  me: devMePayload,
  events,
  tls: tlsFingerprints,
  counters: zeroAll,
};

export type DevPayloads = typeof devPayloads;

// pushRevision is the DEV route's stand-in for a realtime frame.
//
// The §19.1 invariants ("an update MUST NOT close an accordion, reset a
// search, close a surface, scroll to the top…") are the ones a fixture
// page cannot demonstrate on its own: the fixtures never change. This
// produces the Nth version of every payload — new object identities, moved
// numbers, and for the TLS ranking a record that overtakes the leader, so
// a frame that WOULD reshuffle the list under the reader's finger actually
// exists to be tested against.
//
// Deterministic in `revision`: the same press always produces the same
// numbers, which is what lets a screenshot or an e2e assertion name them.
function bumpNumbers(
  group: Record<string, unknown>,
  bump: number,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(group).map(([key, value]) => [
      key,
      typeof value === "number" ? value + bump : value,
    ]),
  );
}

export function pushRevision(revision: number): DevPayloads {
  if (revision === 0) return devPayloads;
  const bump = revision * 7;
  return {
    dc: {
      ...dcsWithAttention,
      dcs: dcsWithAttention.dcs.map((dc) => ({ ...dc, load: dc.load + bump, rtt_ms: dc.rtt_ms })),
    },
    me: devMePayload,
    events,
    tls: {
      ...tlsFingerprints,
      by_fingerprint: tlsFingerprints.by_fingerprint.map((row, i) => ({
        ...row,
        // The LAST record overtakes every other one: the most disruptive
        // reorder a ranking can receive.
        total: i === tlsFingerprints.by_fingerprint.length - 1 ? 10_000 + bump : row.total,
      })),
    },
    counters: { ...zeroAll, core: bumpNumbers(zeroAll.core, bump) },
  };
}
