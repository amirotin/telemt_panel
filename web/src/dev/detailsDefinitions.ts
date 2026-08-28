// Page definitions for the DEV-only /dev/details route.
//
// These are NOT the production definitions — those land with the domain
// migrations (Tasks 6–8) under details-builder/definitions/. These exist so
// the renderers can be exercised, screenshotted and reviewed against
// production-sized fixtures before any real page is migrated, including the
// REST source states (`unsupported`, `stale`, …) that no live stand
// reproduces on demand.
//
// This module is only ever reached through routes/dev/details.tsx's
// `import.meta.env.DEV` guard, which is what makes importing the test
// fixtures here legitimate: Vite replaces the constant with `false` in a
// production build and Rollup drops the whole graph.

import type {
  DcStatus,
  DcStatusData,
  RuntimeEdgeEventRecord,
  RuntimeEdgeEvents,
  RuntimeInitialization,
  RuntimeInitializationComponent,
  RuntimeMeQuality,
} from "../realtime/topics";
import type {
  TlsFingerprintRow,
  TlsFingerprints,
  ZeroAllData,
} from "../lib/api/generated/types.gen";
import type { DetailPageDefinition, FieldCatalog } from "../pulse/details-builder";
import { DEFAULT_FIELD_CATALOG, QUALITY_CHART_RENDERER } from "../pulse/details-builder";
import {
  dcs,
  events,
  initialization,
  meQuality,
  tlsFingerprints,
  zeroAll,
} from "../pulse/details-builder/__fixtures__";

export const dcKey = (dc: DcStatus): string => `dc${dc.dc}`;

// devCatalog — the seeded catalog plus the timestamps these fixtures carry.
//
// A `*_epoch_secs` field is an absolute MOMENT, but the counters family the
// catalog falls back to only sees the `_secs` suffix and reads it as a
// duration, which is how `state_since_epoch_secs` rendered as "20 324 дн.".
// Most of them live inside an array element, where a per-binding `unit`
// cannot reach them, and no binding can correct the DESCRIPTION at all.
// The TLS domain now carries its own endpoint-scoped entries in the seeded
// catalog; what is left here is the ME half, which Task 7 owns.
export const devCatalog: FieldCatalog = {
  ...DEFAULT_FIELD_CATALOG,
  entries: [
    ...DEFAULT_FIELD_CATALOG.entries,
    { path: "drain_gate.updated_at_epoch_secs", unit: "timestamp" },
    { path: "family_states.*.state_since_epoch_secs", unit: "timestamp" },
  ],
};

// --- DC: entity selector + summary + scalars + two arrays (§23.1) --------

export const devDcPage: DetailPageDefinition<DcStatusData, DcStatus> = {
  id: "dev.dc",
  title: (s) => s.diag.domains.dc,
  sources: [{ id: "upstreams", topic: "upstreams", required: true }],
  freshness: { atEpochMs: (p) => p.generated_at_epoch_secs * 1000 },
  navigation: {
    entities: {
      path: "dcs",
      entityKey: (item) => dcKey(item as DcStatus),
      label: (item) => `DC ${(item as DcStatus).dc}`,
    },
    selectEntity: (payload, key) =>
      payload.dcs.find((dc) => dcKey(dc) === key) ?? payload.dcs[0] ?? null,
  },
  // No `label` anywhere: the tiles take their name from the field catalog,
  // which is what a real definition (Tasks 6-8) should do too.
  summary: [
    { id: "load", value: (dc) => dc.load, format: "decimal" },
    {
      id: "coverage",
      path: "coverage_pct",
      value: (dc) => dc.coverage_pct,
      unit: "percent",
      tone: "good",
    },
    { id: "rtt", path: "rtt_ms", value: (dc) => dc.rtt_ms, unit: "milliseconds" },
    {
      id: "endpoints",
      path: "available_endpoints",
      value: (dc) => dc.available_endpoints,
      format: "integer",
    },
  ],
  sections: [
    {
      kind: "scalars",
      id: "routing",
      title: () => "Routing & capacity",
      defaultExpanded: true,
      fields: [
        { path: "dc" },
        { path: "available_endpoints" },
        { path: "available_pct" },
        { path: "required_writers" },
        { path: "floor_min" },
        { path: "floor_target" },
        { path: "floor_max" },
        { path: "floor_capped" },
        { path: "alive_writers" },
        { path: "coverage_pct" },
        { path: "fresh_alive_writers" },
        { path: "fresh_coverage_pct" },
        { path: "rtt_ms" },
        { path: "load" },
      ],
    },
    { kind: "array", id: "endpoints", title: () => "endpoints[]", path: "endpoints" },
    {
      kind: "array",
      id: "endpoint_writers",
      title: () => "endpoint_writers[]",
      path: "endpoint_writers",
    },
  ],
  unknownFields: { minMode: "extended", rawJson: true },
};

// --- ME quality: the reference CUSTOM chart + two counters maps (§23.2) --

export const devMeQualityPage: DetailPageDefinition<RuntimeMeQuality, RuntimeMeQuality> = {
  id: "dev.me-quality",
  title: (s) => s.diag.domains.me,
  sources: [{ id: "runtime", topic: "runtime", required: true }],
  sections: [
    // §9.8: the one thing the standard kinds cannot express — a per-DC RTT
    // series read as a shape rather than as twelve rows. The definition
    // adapts the domain record into the renderer's {label, value} series,
    // so the chart itself stays domain-free.
    {
      kind: "custom",
      id: "dc-rtt-chart",
      title: () => "RTT · dc_rtt[]",
      renderer: QUALITY_CHART_RENDERER,
      consumes: ["dc_rtt"],
      defaultExpanded: true,
      select: (q) => q.dc_rtt.map((row) => ({ label: `DC ${row.dc}`, value: row.rtt_ema_ms })),
    },
    {
      kind: "scalars",
      id: "drain_gate",
      title: (s) => s.diag.groups.drainGate,
      defaultExpanded: true,
      fields: [
        { path: "drain_gate.route_quorum_ok" },
        { path: "drain_gate.redundancy_ok" },
        { path: "drain_gate.block_reason" },
        { path: "drain_gate.updated_at_epoch_secs" },
      ],
    },
    {
      kind: "array",
      id: "family_states",
      title: (s) => s.diag.groups.familyStates,
      path: "family_states",
    },
    // The same map, twice on purpose: as verbatim counter rows (§9.7) and
    // as a §9.4 breakdown of where routing lost packets.
    {
      kind: "breakdown",
      id: "route_drops_breakdown",
      title: (s) => s.diag.groups.routeDrops,
      path: "route_drops",
      defaultExpanded: true,
    },
    {
      kind: "dynamicMap",
      id: "counters",
      title: (s) => s.diag.domains.counters,
      path: "counters",
      defaultExpanded: true,
      supportsDelta: true,
      groups: [{ id: "counters", title: (s) => s.diag.groups.qualityCounters, path: "counters" }],
    },
  ],
  unknownFields: { minMode: "extended", rawJson: true },
};

// --- ME initialization: the timeline kind over 16 components (§23.2) -----

const componentOf = (item: unknown) => item as RuntimeInitializationComponent;

export const devInitPage: DetailPageDefinition<RuntimeInitialization, RuntimeInitialization> = {
  id: "dev.me-init",
  title: () => "Initialization sequence",
  sources: [{ id: "runtime", topic: "runtime", required: true }],
  summary: [
    { id: "progress", label: () => "Progress", value: (p) => p.progress_pct, unit: "percent" },
    {
      id: "elapsed",
      label: () => "Total elapsed",
      value: (p) => p.total_elapsed_ms,
      unit: "milliseconds",
    },
    {
      id: "components",
      label: () => "Components",
      value: (p) => p.components?.length ?? 0,
      format: "integer",
    },
    { id: "stage", label: () => "Stage", value: (p) => p.current_stage },
  ],
  sections: [
    {
      kind: "timeline",
      id: "components",
      title: () => "components[]",
      path: "components",
      defaultExpanded: true,
      itemKey: (item) => componentOf(item).id,
      status: (item) => componentOf(item).status,
      step: (item) => componentOf(item).title,
      details: (item) => componentOf(item).details ?? null,
      durationMs: (item) => componentOf(item).duration_ms ?? null,
    },
  ],
  unknownFields: { minMode: "extended", rawJson: true },
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

function tlsRanking(
  id: string,
  path: "by_fingerprint" | "by_ip" | "by_cidr" | "by_user",
  title: string,
  identity: (row: TlsFingerprintRow) => string,
) {
  return {
    kind: "ranking" as const,
    id,
    title: () => title,
    path,
    defaultExpanded: true,
    // The honest semantic key, duplicates and all: `by_user` and `by_cidr`
    // really do name several records with one scope, and RankingSection
    // disambiguates them from the record itself. An index here would change
    // every key a Telemt re-sort moved and turn the frozen order into an
    // append-everything.
    itemKey: (item: unknown) => identity(rowOf(item)),
    identity: (item: unknown) => identity(rowOf(item)),
    score: (item: unknown) => rowOf(item).total,
    scoreKey: "total",
    scoreLabel: () => "observed",
    meta: (item: unknown) => `bad/probe ${rowOf(item).bad_or_probe}`,
    search: { terms: (item: unknown) => [rowOf(item).ja3, rowOf(item).ja4, rowOf(item).scope ?? ""] },
    filters: [
      { key: RECENT_FILTER_KEY, label: () => "Recently seen", predicate: isRecent },
    ],
  };
}

const totalOf = (rows: TlsFingerprintRow[] | undefined, pick: (r: TlsFingerprintRow) => number) =>
  (rows ?? []).reduce((sum, row) => sum + pick(row), 0);

export const devTlsPage: DetailPageDefinition<TlsFingerprints, TlsFingerprints> = {
  id: "dev.tls",
  title: (s) => s.diag.domains.security,
  sources: [{ id: "tls", endpoint: "/api/telemt/tls-fingerprints", required: true }],
  summary: [
    {
      id: "observed",
      label: () => "ClientHello observed",
      value: (p) => totalOf(p.by_fingerprint, (r) => r.total),
      format: "integer",
    },
    {
      id: "bad",
      label: () => "Bad / probe",
      value: (p) => totalOf(p.by_fingerprint, (r) => r.bad_or_probe),
      format: "integer",
      tone: "warn",
    },
    {
      id: "keys",
      label: () => "Unique keys",
      value: (p) =>
        (p.by_fingerprint?.length ?? 0) +
        (p.by_ip?.length ?? 0) +
        (p.by_cidr?.length ?? 0) +
        (p.by_user?.length ?? 0),
      format: "integer",
    },
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
  sections: [
    {
      kind: "scalars",
      id: "capture",
      title: (s) => s.diag.groups.telemetry,
      defaultExpanded: true,
      fields: [
        { path: "limit" },
        { path: "retention_secs" },
        { path: "capacity" },
        { path: "dropped_total" },
        { path: "parse_error_total" },
      ],
    },
    tlsRanking("by_fingerprint", "by_fingerprint", "Ranked records · ja4", (r) => r.ja4),
    tlsRanking("by_ip", "by_ip", "Ranked records · ip", (r) => r.scope ?? r.ja4),
    tlsRanking("by_cidr", "by_cidr", "Ranked records · cidr", (r) => r.scope ?? r.ja4),
    tlsRanking("by_user", "by_user", "Ranked records · user", (r) => r.scope ?? r.ja4),
  ],
  unknownFields: { minMode: "extended", rawJson: true },
};

// --- Counters: the five zero/all groups + three breakdowns (§23.4) -------

export const devCountersPage: DetailPageDefinition<ZeroAllData, ZeroAllData> = {
  id: "dev.counters",
  title: (s) => s.diag.domains.counters,
  sources: [{ id: "stats", topic: "stats", required: true }],
  sections: [
    // Declared BEFORE the map they live inside: an explicit section owns
    // its path, and DynamicMapSection stops showing the same array nested
    // in its group.
    {
      kind: "breakdown",
      id: "connections_bad_by_class",
      title: () => "connections_bad_by_class[]",
      path: "core.connections_bad_by_class",
      defaultExpanded: true,
    },
    {
      kind: "breakdown",
      id: "handshake_failures_by_class",
      title: () => "handshake_failures_by_class[]",
      path: "core.handshake_failures_by_class",
      defaultExpanded: true,
    },
    // Empty on every VPS: the section stays visible and says so, which is
    // §10.3's "пустой массив ≠ отсутствующее поле".
    {
      kind: "breakdown",
      id: "handshake_error_codes",
      title: () => "handshake_error_codes[]",
      path: "middle_proxy.handshake_error_codes",
      defaultExpanded: true,
    },
    {
      kind: "dynamicMap",
      id: "all",
      title: (s) => s.diag.domains.counters,
      path: "",
      defaultExpanded: true,
      supportsDelta: true,
      groups: [
        { id: "core", title: (s) => s.diag.groups.core, path: "core" },
        { id: "upstream", title: (s) => s.diag.groups.upstream, path: "upstream" },
        { id: "middle_proxy", title: (s) => s.diag.groups.middleProxy, path: "middle_proxy" },
        { id: "pool", title: (s) => s.diag.groups.pool, path: "pool" },
        { id: "desync", title: (s) => s.diag.groups.desync, path: "desync" },
      ],
    },
  ],
  unknownFields: { minMode: "extended", rawJson: true },
};

export const devPayloads = {
  dc: dcs,
  meQuality,
  initialization,
  events,
  tls: tlsFingerprints,
  counters: zeroAll,
};
