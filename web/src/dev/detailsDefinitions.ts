// Page definitions for the DEV-only /dev/details route.
//
// These are NOT the production definitions — those land with the domain
// migrations (Tasks 6–8) under details-builder/definitions/. These exist so
// the base renderers can be exercised, screenshotted and reviewed against
// production-sized fixtures before any real page is migrated, including the
// REST source states (`unsupported`, `stale`, …) that no live stand
// reproduces on demand.
//
// This module is only ever reached through routes/dev/details.tsx's
// `import.meta.env.DEV` guard, which is what makes importing the test
// fixtures here legitimate: Vite replaces the constant with `false` in a
// production build and Rollup drops the whole graph.

import type { DcStatus, DcStatusData, RuntimeMeQuality } from "../realtime/topics";
import type {
  TlsFingerprintRow,
  TlsFingerprints,
  ZeroAllData,
} from "../lib/api/generated/types.gen";
import type { DetailPageDefinition } from "../pulse/details-builder";
import { dcs, meQuality, tlsFingerprints, zeroAll } from "../pulse/details-builder/__fixtures__";

export const dcKey = (dc: DcStatus): string => `dc${dc.dc}`;

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

// --- ME quality: scalars + record array + two counters maps (§23.2) ------

export const devMeQualityPage: DetailPageDefinition<RuntimeMeQuality, RuntimeMeQuality> = {
  id: "dev.me-quality",
  title: (s) => s.diag.domains.me,
  sources: [{ id: "runtime", topic: "runtime", required: true }],
  sections: [
    {
      kind: "scalars",
      id: "drain_gate",
      title: (s) => s.diag.groups.drainGate,
      defaultExpanded: true,
      fields: [
        { path: "drain_gate.route_quorum_ok" },
        { path: "drain_gate.redundancy_ok" },
        { path: "drain_gate.block_reason" },
        { path: "drain_gate.updated_at_epoch_secs", format: "relativeAge" },
      ],
    },
    {
      kind: "array",
      id: "family_states",
      title: (s) => s.diag.groups.familyStates,
      path: "family_states",
    },
    { kind: "array", id: "dc_rtt", title: (s) => s.diag.groups.dcRtt, path: "dc_rtt" },
    {
      kind: "dynamicMap",
      id: "counters",
      title: (s) => s.diag.domains.counters,
      path: "",
      defaultExpanded: true,
      supportsDelta: true,
      groups: [
        { id: "counters", title: (s) => s.diag.groups.qualityCounters, path: "counters" },
        { id: "route_drops", title: (s) => s.diag.groups.routeDrops, path: "route_drops" },
      ],
    },
  ],
  unknownFields: { minMode: "extended", rawJson: true },
};

// --- Security / TLS: an EntityList that opens the adaptive surface -------

const tlsIdentity = (row: TlsFingerprintRow): string => row.ja4;

export const devTlsPage: DetailPageDefinition<TlsFingerprints, TlsFingerprints> = {
  id: "dev.tls",
  title: (s) => s.diag.domains.security,
  sources: [{ id: "tls", endpoint: "/api/telemt/tls-fingerprints", required: true }],
  // The TLS domain is not in the catalog yet (Task 8), so these four tiles
  // demonstrate the other half of the rule: no catalog entry, no invented
  // name — the raw key stands in until Task 8 describes the fields.
  summary: [
    { id: "limit", value: (p) => p.limit, format: "integer" },
    { id: "capacity", value: (p) => p.capacity, format: "integer" },
    { id: "dropped", path: "dropped_total", value: (p) => p.dropped_total, format: "integer" },
    {
      id: "parse_errors",
      path: "parse_error_total",
      value: (p) => p.parse_error_total,
      format: "integer",
    },
  ],
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
    {
      kind: "entityList",
      id: "by_fingerprint",
      title: (s) => s.diag.groups.tlsByFingerprint,
      path: "by_fingerprint",
      defaultExpanded: true,
      itemKey: (item, index) => `${tlsIdentity(item as TlsFingerprintRow)}#${index}`,
      identity: (item) => tlsIdentity(item as TlsFingerprintRow),
      status: (item) => `total ${(item as TlsFingerprintRow).total}`,
      highlights: ["total", "auth_success"],
    },
    {
      kind: "entityList",
      id: "by_ip",
      title: (s) => s.diag.groups.tlsByIp,
      path: "by_ip",
      itemKey: (item, index) => `${(item as TlsFingerprintRow).scope ?? ""}#${index}`,
      identity: (item) => (item as TlsFingerprintRow).scope ?? tlsIdentity(item as TlsFingerprintRow),
      status: (item) => `total ${(item as TlsFingerprintRow).total}`,
      highlights: ["total"],
    },
  ],
  unknownFields: { minMode: "extended", rawJson: true },
};

// --- Counters: the five zero/all groups as one dynamic map (§23.4) -------

export const devCountersPage: DetailPageDefinition<ZeroAllData, ZeroAllData> = {
  id: "dev.counters",
  title: (s) => s.diag.domains.counters,
  sources: [{ id: "stats", topic: "stats", required: true }],
  sections: [
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
  tls: tlsFingerprints,
  counters: zeroAll,
};
