// The field catalog (spec §8) — what a parameter MEANS, kept apart from
// what a page shows.
//
// Owner decision 2026-08-26 (06-ui.md): the descriptions live in the repo
// with a coverage test and a checklist item on every Telemt bump, precisely
// so a new Telemt field shows up as a failing test rather than as an
// undescribed row nobody notices. This module is the structure and the
// lookup; the prose lives in i18n/{ru,en}.ts under `details.fields`, so a
// description is bilingual by construction and cannot be pinned to Russian
// by a helper that forgot to take `s: Dict`.
//
// §8.2's resolution order, implemented literally:
//
//   1. exact normalized path            dcs[0].rtt_ms  -> "dc.rtt_ms"
//   2. endpoint-specific path           (entries scoped to a source id)
//   3. wildcard path                    dcs.*.rtt_ms
//   4. known counters family            *_total, *_bytes, *_pct, …
//   5. neutral fallback text            "Параметр Telemt; описания пока нет"
//
// Steps 2 and 3 are swapped relative to the spec's own list, by controller
// ruling R9: most specific wins, so a rule written for ONE endpoint beats a
// catalog-wide wildcard rather than losing to it.
//
// Step 5 is a hard stop: the builder MUST NOT invent business meaning for a
// field it has never seen (§8.2).
//
// Seeded here: DC (Task 2), Security and TLS (Task 6), ME and Counters
// (Task 7), Upstreams, Connections, NAT and Events (Task 8) — every
// domain the panel draws. `fieldCatalog.coverage.test.ts` is what tells
// the next Telemt bump which paths went missing.

import type { Dict } from "../../i18n";
import type { DisplayMode } from "../../display-mode/mode";
import type { FormatterName } from "./formatting";
import type { FieldDefinition, FieldUnit } from "./model";
import { matchesPattern, patternSpecificity, walkLeafPaths } from "./paths";

/**
 * One catalog row. `path` may be exact or wildcarded; `descriptionKey`
 * indexes `Dict["details"]["fields"]["descriptions"]` and defaults to the
 * pattern itself, which is why most entries only need two properties.
 */
export interface FieldCatalogEntry {
  path: string;
  descriptionKey?: string;
  /** Label override; by default a renderer humanizes the last path segment. */
  label?: string;
  /**
   * Dictionary key of a SHORT human name, read by the summary tiles alone —
   * indexes `Dict["details"]["fields"]["shortLabels"]`. A §8.1 row is not
   * affected: it keeps showing Telemt's own field name.
   */
  shortLabelKey?: string;
  format?: FormatterName;
  unit?: FieldUnit;
  sensitive?: boolean;
  /** Text shown INSTEAD of an em dash when the value is null (§13.1). */
  nullMeaningKey?: string;
  /** Hint shown beside a real 0 (§13.1) — never instead of it. */
  zeroMeaningKey?: string;
  minMode?: DisplayMode;
}

/** Which of the five steps produced a match — asserted by the priority tests. */
export type FieldLookupSource = "exact" | "wildcard" | "endpoint" | "family" | "fallback";

export interface FieldLookupResult {
  source: FieldLookupSource;
  entry: FieldCatalogEntry | null;
  /** Set when step 4 matched: which counters family. */
  family?: CounterFamilyId;
}

export type CounterFamilyId =
  | "errorsTotal"
  | "total"
  | "bytes"
  | "milliseconds"
  | "seconds"
  | "percent"
  | "count";

interface CounterFamily {
  id: CounterFamilyId;
  /** Tested against the LAST path segment only — a family is a key-naming convention. */
  test: RegExp;
  format?: FormatterName;
  unit?: FieldUnit;
}

// Ordered most specific first: `handshake_errors_total` is an error counter,
// not merely a total, and `*_errors_total` must win over `*_total`.
const COUNTER_FAMILIES: CounterFamily[] = [
  { id: "errorsTotal", test: /_(errors?|failures?|drops?|timeouts?)_total$/, format: "integer" },
  { id: "total", test: /_total$/, format: "integer" },
  { id: "bytes", test: /_(bytes|octets)$/, unit: "bytes" },
  { id: "milliseconds", test: /_ms$/, unit: "milliseconds" },
  { id: "seconds", test: /_(secs|seconds)$/, unit: "seconds" },
  { id: "percent", test: /_pct$/, unit: "percent" },
  { id: "count", test: /_(count|current|gauge)$/, format: "integer" },
];

export interface FieldCatalog {
  /** Global entries, exact and wildcard alike. */
  entries: FieldCatalogEntry[];
  /** Entries scoped to one source/endpoint id — step 3. */
  byEndpoint: Record<string, FieldCatalogEntry[]>;
}

// --- the seeded catalog --------------------------------------------------

// The DC domain, keyed by BOTH spellings a page can be looking at: the
// payload-rooted `dcs.*.x` (the whole DcStatusData) and the entity-rooted
// bare `x` (one DcStatus, which is what the DC Details page's context is
// once an entity is selected). Both point at the same description key, so
// there is exactly one sentence per concept.
function dcField(field: string, extra: Omit<FieldCatalogEntry, "path" | "descriptionKey"> = {}) {
  const key = `dc.${field}`;
  return [
    { path: `dcs.*.${field}`, descriptionKey: key, ...extra },
    { path: field, descriptionKey: key, ...extra },
  ];
}

const DC_ENTRIES: FieldCatalogEntry[] = [
  { path: "middle_proxy_enabled", descriptionKey: "dc.middle_proxy_enabled", format: "boolean" },
  { path: "reason", descriptionKey: "dc.reason", format: "enum" },
  {
    path: "generated_at_epoch_secs",
    descriptionKey: "dc.generated_at_epoch_secs",
    unit: "timestamp",
  },
  { path: "dcs", descriptionKey: "dc.dcs" },
  ...dcField("dc", { format: "integer" }),
  ...dcField("endpoints"),
  { path: "dcs.*.endpoints.*", descriptionKey: "dc.endpoint", format: "address" },
  { path: "endpoints.*", descriptionKey: "dc.endpoint", format: "address" },
  ...dcField("endpoint_writers"),
  {
    path: "dcs.*.endpoint_writers.*.endpoint",
    descriptionKey: "dc.endpoint",
    format: "address",
  },
  { path: "endpoint_writers.*.endpoint", descriptionKey: "dc.endpoint", format: "address" },
  {
    path: "dcs.*.endpoint_writers.*.active_writers",
    descriptionKey: "dc.endpoint_writers.active_writers",
    format: "integer",
  },
  {
    path: "endpoint_writers.*.active_writers",
    descriptionKey: "dc.endpoint_writers.active_writers",
    format: "integer",
  },
  ...dcField("available_endpoints", { format: "integer", shortLabelKey: "dc.available_endpoints" }),
  ...dcField("available_pct", { unit: "percent" }),
  ...dcField("required_writers", { format: "integer" }),
  ...dcField("floor_min", { format: "integer" }),
  ...dcField("floor_target", { format: "integer" }),
  ...dcField("floor_max", { format: "integer" }),
  ...dcField("floor_capped", { format: "boolean" }),
  ...dcField("alive_writers", { format: "integer", zeroMeaningKey: "dc.alive_writers" }),
  ...dcField("coverage_pct", { unit: "percent", shortLabelKey: "dc.coverage_pct" }),
  ...dcField("fresh_alive_writers", { format: "integer" }),
  ...dcField("fresh_coverage_pct", { unit: "percent", shortLabelKey: "dc.fresh_coverage_pct" }),
  // rtt_ms is the §13.1 poster child: null means "never measured", which is
  // NOT the same as "no data" — the catalog says so instead of an em dash.
  ...dcField("rtt_ms", {
    unit: "milliseconds",
    nullMeaningKey: "dc.rtt_ms",
    shortLabelKey: "dc.rtt_ms",
  }),
  ...dcField("load", { format: "decimal", shortLabelKey: "dc.load" }),
  { path: "network_path.dc", descriptionKey: "dc.network_path.dc", format: "integer" },
  {
    path: "network_path.ip_preference",
    descriptionKey: "dc.network_path.ip_preference",
    format: "enum",
  },
  {
    path: "network_path.selected_addr_v4",
    descriptionKey: "dc.network_path.selected_addr_v4",
    format: "address",
  },
  {
    path: "network_path.selected_addr_v6",
    descriptionKey: "dc.network_path.selected_addr_v6",
    format: "address",
  },
];

// The ME domain (TELEMT_LIVE_API_DATA §8, §10, §13–16; Telemt's own
// docs/Architecture/API/API.md for every sentence below). Every path is
// prefixed by the block it arrives under on the ME page's context
// (`summary.`, `writers.`, `gates.`, `initialization.`, `pool.`,
// `quality.`, `selftest.`, `me_runtime.`), which is what keeps a bare
// `total`, `state` or `degraded` from describing some other domain's field.
//
// The three response-level fields the me-writers payload shares with the DC
// one (`middle_proxy_enabled`, `reason`, `generated_at_epoch_secs`) are
// deliberately NOT repeated here: they are the same concepts and already
// carry one sentence each in DC_ENTRIES (§8.3 — one sentence per concept).
const ME_ENTRIES: FieldCatalogEntry[] = [
  {
    path: "summary.configured_dc_groups",
    descriptionKey: "me.summary.configured_dc_groups",
    format: "integer",
  },
  {
    path: "summary.configured_endpoints",
    descriptionKey: "me.summary.configured_endpoints",
    format: "integer",
  },
  {
    path: "summary.available_endpoints",
    descriptionKey: "me.summary.available_endpoints",
    format: "integer",
  },
  { path: "summary.available_pct", descriptionKey: "me.summary.available_pct", unit: "percent" },
  {
    path: "summary.required_writers",
    descriptionKey: "me.summary.required_writers",
    format: "integer",
  },
  { path: "summary.alive_writers", descriptionKey: "me.summary.alive_writers", format: "integer" },
  { path: "summary.coverage_pct", descriptionKey: "me.summary.coverage_pct", unit: "percent" },
  {
    path: "summary.fresh_alive_writers",
    descriptionKey: "me.summary.fresh_alive_writers",
    format: "integer",
  },
  {
    path: "summary.fresh_coverage_pct",
    descriptionKey: "me.summary.fresh_coverage_pct",
    unit: "percent",
  },
  { path: "writers", descriptionKey: "me.writers" },
  { path: "writers.*.writer_id", descriptionKey: "me.writers.writer_id", format: "identifier" },
  { path: "writers.*.dc", descriptionKey: "me.writers.dc", format: "integer" },
  { path: "writers.*.endpoint", descriptionKey: "me.writers.endpoint", format: "address" },
  { path: "writers.*.generation", descriptionKey: "me.writers.generation", format: "integer" },
  { path: "writers.*.state", descriptionKey: "me.writers.state", format: "enum" },
  { path: "writers.*.draining", descriptionKey: "me.writers.draining", format: "boolean" },
  { path: "writers.*.degraded", descriptionKey: "me.writers.degraded", format: "boolean" },
  {
    path: "writers.*.bound_clients",
    descriptionKey: "me.writers.bound_clients",
    format: "integer",
  },
  { path: "writers.*.idle_for_secs", descriptionKey: "me.writers.idle_for_secs", unit: "seconds" },
  { path: "writers.*.rtt_ema_ms", descriptionKey: "me.writers.rtt_ema_ms", unit: "milliseconds" },
  {
    path: "writers.*.matches_active_generation",
    descriptionKey: "me.writers.matches_active_generation",
    format: "boolean",
  },
  {
    path: "writers.*.in_desired_map",
    descriptionKey: "me.writers.in_desired_map",
    format: "boolean",
  },
  {
    path: "writers.*.allow_drain_fallback",
    descriptionKey: "me.writers.allow_drain_fallback",
    format: "boolean",
  },
  {
    path: "writers.*.drain_started_at_epoch_secs",
    descriptionKey: "me.writers.drain_started_at_epoch_secs",
    unit: "timestamp",
  },
  {
    path: "writers.*.drain_deadline_epoch_secs",
    descriptionKey: "me.writers.drain_deadline_epoch_secs",
    unit: "timestamp",
  },
  {
    path: "writers.*.drain_over_ttl",
    descriptionKey: "me.writers.drain_over_ttl",
    format: "boolean",
  },
  {
    path: "gates.accepting_new_connections",
    descriptionKey: "me.gates.accepting_new_connections",
    format: "boolean",
  },
  {
    path: "gates.conditional_cast_enabled",
    descriptionKey: "me.gates.conditional_cast_enabled",
    format: "boolean",
  },
  {
    path: "gates.me_runtime_ready",
    descriptionKey: "me.gates.me_runtime_ready",
    format: "boolean",
  },
  {
    path: "gates.me2dc_fallback_enabled",
    descriptionKey: "me.gates.me2dc_fallback_enabled",
    format: "boolean",
  },
  {
    path: "gates.me2dc_fast_enabled",
    descriptionKey: "me.gates.me2dc_fast_enabled",
    format: "boolean",
  },
  {
    path: "gates.use_middle_proxy",
    descriptionKey: "me.gates.use_middle_proxy",
    format: "boolean",
  },
  { path: "gates.route_mode", descriptionKey: "me.gates.route_mode", format: "enum" },
  { path: "gates.reroute_active", descriptionKey: "me.gates.reroute_active", format: "boolean" },
  {
    path: "gates.reroute_to_direct_at_epoch_secs",
    descriptionKey: "me.gates.reroute_to_direct_at_epoch_secs",
    unit: "timestamp",
  },
  { path: "gates.reroute_reason", descriptionKey: "me.gates.reroute_reason", format: "enum" },
  { path: "gates.startup_status", descriptionKey: "me.gates.startup_status", format: "enum" },
  { path: "gates.startup_stage", descriptionKey: "me.gates.startup_stage", format: "enum" },
  {
    path: "gates.startup_progress_pct",
    descriptionKey: "me.gates.startup_progress_pct",
    unit: "percent",
  },
  { path: "initialization.status", descriptionKey: "me.init.status", format: "enum" },
  { path: "initialization.degraded", descriptionKey: "me.init.degraded", format: "boolean" },
  { path: "initialization.current_stage", descriptionKey: "me.init.current_stage", format: "enum" },
  { path: "initialization.progress_pct", descriptionKey: "me.init.progress_pct", unit: "percent" },
  {
    path: "initialization.started_at_epoch_secs",
    descriptionKey: "me.init.started_at_epoch_secs",
    unit: "timestamp",
  },
  {
    path: "initialization.ready_at_epoch_secs",
    descriptionKey: "me.init.ready_at_epoch_secs",
    unit: "timestamp",
  },
  {
    path: "initialization.total_elapsed_ms",
    descriptionKey: "me.init.total_elapsed_ms",
    unit: "milliseconds",
  },
  {
    path: "initialization.transport_mode",
    descriptionKey: "me.init.transport_mode",
    format: "enum",
  },
  { path: "initialization.components", descriptionKey: "me.init.components" },
  { path: "initialization.me.status", descriptionKey: "me.init.me.status", format: "enum" },
  {
    path: "initialization.me.current_stage",
    descriptionKey: "me.init.me.current_stage",
    format: "enum",
  },
  {
    path: "initialization.me.progress_pct",
    descriptionKey: "me.init.me.progress_pct",
    unit: "percent",
  },
  {
    path: "initialization.me.init_attempt",
    descriptionKey: "me.init.me.init_attempt",
    format: "integer",
  },
  { path: "initialization.me.retry_limit", descriptionKey: "me.init.me.retry_limit" },
  { path: "initialization.me.last_error", descriptionKey: "me.init.me.last_error" },
  {
    path: "initialization.components.*.id",
    descriptionKey: "me.init.component.id",
    format: "identifier",
  },
  { path: "initialization.components.*.title", descriptionKey: "me.init.component.title" },
  {
    path: "initialization.components.*.status",
    descriptionKey: "me.init.component.status",
    format: "enum",
  },
  {
    path: "initialization.components.*.started_at_epoch_ms",
    descriptionKey: "me.init.component.started_at_epoch_ms",
    unit: "timestamp",
  },
  {
    path: "initialization.components.*.finished_at_epoch_ms",
    descriptionKey: "me.init.component.finished_at_epoch_ms",
    unit: "timestamp",
  },
  {
    path: "initialization.components.*.duration_ms",
    descriptionKey: "me.init.component.duration_ms",
    unit: "milliseconds",
  },
  {
    path: "initialization.components.*.attempts",
    descriptionKey: "me.init.component.attempts",
    format: "integer",
  },
  { path: "initialization.components.*.details", descriptionKey: "me.init.component.details" },
  {
    path: "pool.generations.active_generation",
    descriptionKey: "me.pool.generations.active_generation",
    format: "integer",
  },
  {
    path: "pool.generations.warm_generation",
    descriptionKey: "me.pool.generations.warm_generation",
    format: "integer",
  },
  {
    path: "pool.generations.pending_hardswap_generation",
    descriptionKey: "me.pool.generations.pending_hardswap_generation",
    format: "integer",
  },
  {
    path: "pool.generations.pending_hardswap_age_secs",
    descriptionKey: "me.pool.generations.pending_hardswap_age_secs",
    unit: "seconds",
  },
  {
    path: "pool.generations.draining_generations",
    descriptionKey: "me.pool.generations.draining_generations",
  },
  {
    path: "pool.generations.draining_generations.*",
    descriptionKey: "me.pool.generations.draining_generations.*",
    format: "integer",
  },
  { path: "pool.hardswap.enabled", descriptionKey: "me.pool.hardswap.enabled", format: "boolean" },
  { path: "pool.hardswap.pending", descriptionKey: "me.pool.hardswap.pending", format: "boolean" },
  { path: "pool.writers.total", descriptionKey: "me.pool.writers.total", format: "integer" },
  {
    path: "pool.writers.alive_non_draining",
    descriptionKey: "me.pool.writers.alive_non_draining",
    format: "integer",
  },
  { path: "pool.writers.draining", descriptionKey: "me.pool.writers.draining", format: "integer" },
  { path: "pool.writers.degraded", descriptionKey: "me.pool.writers.degraded", format: "integer" },
  {
    path: "pool.writers.contour.warm",
    descriptionKey: "me.pool.writers.contour.warm",
    format: "integer",
  },
  {
    path: "pool.writers.contour.active",
    descriptionKey: "me.pool.writers.contour.active",
    format: "integer",
  },
  {
    path: "pool.writers.contour.draining",
    descriptionKey: "me.pool.writers.contour.draining",
    format: "integer",
  },
  {
    path: "pool.writers.health.healthy",
    descriptionKey: "me.pool.writers.health.healthy",
    format: "integer",
  },
  {
    path: "pool.writers.health.degraded",
    descriptionKey: "me.pool.writers.health.degraded",
    format: "integer",
  },
  {
    path: "pool.writers.health.draining",
    descriptionKey: "me.pool.writers.health.draining",
    format: "integer",
  },
  {
    path: "pool.refill.inflight_endpoints_total",
    descriptionKey: "me.pool.refill.inflight_endpoints_total",
    format: "integer",
  },
  {
    path: "pool.refill.inflight_dc_total",
    descriptionKey: "me.pool.refill.inflight_dc_total",
    format: "integer",
  },
  { path: "pool.refill.by_dc", descriptionKey: "me.pool.refill.by_dc" },
  {
    path: "pool.refill.by_dc.*.family",
    descriptionKey: "me.pool.refill.by_dc.*.family",
    format: "enum",
  },
  {
    path: "pool.refill.by_dc.*.inflight",
    descriptionKey: "me.pool.refill.by_dc.*.inflight",
    format: "integer",
  },
  { path: "pool.refill.by_dc.*.dc", descriptionKey: "dc.dc", format: "integer" },
  {
    path: "quality.counters.idle_close_by_peer_total",
    descriptionKey: "me.quality.counters.idle_close_by_peer_total",
    format: "integer",
  },
  {
    path: "quality.counters.reader_eof_total",
    descriptionKey: "me.quality.counters.reader_eof_total",
    format: "integer",
  },
  {
    path: "quality.counters.kdf_drift_total",
    descriptionKey: "me.quality.counters.kdf_drift_total",
    format: "integer",
  },
  {
    path: "quality.counters.kdf_port_only_drift_total",
    descriptionKey: "me.quality.counters.kdf_port_only_drift_total",
    format: "integer",
  },
  {
    path: "quality.counters.reconnect_attempt_total",
    descriptionKey: "me.quality.counters.reconnect_attempt_total",
    format: "integer",
  },
  {
    path: "quality.counters.reconnect_success_total",
    descriptionKey: "me.quality.counters.reconnect_success_total",
    format: "integer",
  },
  {
    path: "quality.route_drops.no_conn_total",
    descriptionKey: "me.quality.route_drops.no_conn_total",
    format: "integer",
  },
  {
    path: "quality.route_drops.channel_closed_total",
    descriptionKey: "me.quality.route_drops.channel_closed_total",
    format: "integer",
  },
  {
    path: "quality.route_drops.queue_full_total",
    descriptionKey: "me.quality.route_drops.queue_full_total",
    format: "integer",
  },
  {
    path: "quality.route_drops.queue_full_base_total",
    descriptionKey: "me.quality.route_drops.queue_full_base_total",
    format: "integer",
  },
  {
    path: "quality.route_drops.queue_full_high_total",
    descriptionKey: "me.quality.route_drops.queue_full_high_total",
    format: "integer",
  },
  { path: "quality.family_states", descriptionKey: "me.quality.family_states" },
  {
    path: "quality.family_states.*.family",
    descriptionKey: "me.quality.family_states.*.family",
    format: "enum",
  },
  {
    path: "quality.family_states.*.state",
    descriptionKey: "me.quality.family_states.*.state",
    format: "enum",
  },
  {
    path: "quality.family_states.*.state_since_epoch_secs",
    descriptionKey: "me.quality.family_states.*.state_since_epoch_secs",
    unit: "timestamp",
  },
  {
    path: "quality.family_states.*.suppressed_until_epoch_secs",
    descriptionKey: "me.quality.family_states.*.suppressed_until_epoch_secs",
    unit: "timestamp",
  },
  {
    path: "quality.family_states.*.fail_streak",
    descriptionKey: "me.quality.family_states.*.fail_streak",
    format: "integer",
  },
  {
    path: "quality.family_states.*.recover_success_streak",
    descriptionKey: "me.quality.family_states.*.recover_success_streak",
    format: "integer",
  },
  {
    path: "quality.drain_gate.route_quorum_ok",
    descriptionKey: "me.quality.drain_gate.route_quorum_ok",
    format: "boolean",
  },
  {
    path: "quality.drain_gate.redundancy_ok",
    descriptionKey: "me.quality.drain_gate.redundancy_ok",
    format: "boolean",
  },
  {
    path: "quality.drain_gate.block_reason",
    descriptionKey: "me.quality.drain_gate.block_reason",
    format: "enum",
  },
  {
    path: "quality.drain_gate.updated_at_epoch_secs",
    descriptionKey: "me.quality.drain_gate.updated_at_epoch_secs",
    unit: "timestamp",
  },
  { path: "quality.dc_rtt", descriptionKey: "me.quality.dc_rtt" },
  { path: "quality.dc_rtt.*.dc", descriptionKey: "dc.dc", format: "integer" },
  {
    path: "quality.dc_rtt.*.rtt_ema_ms",
    descriptionKey: "me.dc_rtt.rtt_ema_ms",
    unit: "milliseconds",
  },
  {
    path: "quality.dc_rtt.*.alive_writers",
    descriptionKey: "me.dc_rtt.alive_writers",
    format: "integer",
  },
  {
    path: "quality.dc_rtt.*.required_writers",
    descriptionKey: "me.dc_rtt.required_writers",
    format: "integer",
  },
  {
    path: "quality.dc_rtt.*.coverage_pct",
    descriptionKey: "me.dc_rtt.coverage_pct",
    unit: "percent",
  },
  { path: "selftest.kdf.state", descriptionKey: "me.selftest.kdf.state", format: "enum" },
  {
    path: "selftest.kdf.ewma_errors_per_min",
    descriptionKey: "me.selftest.kdf.ewma_errors_per_min",
    format: "decimal",
  },
  {
    path: "selftest.kdf.threshold_errors_per_min",
    descriptionKey: "me.selftest.kdf.threshold_errors_per_min",
    format: "decimal",
  },
  {
    path: "selftest.kdf.errors_total",
    descriptionKey: "me.selftest.kdf.errors_total",
    format: "integer",
  },
  { path: "selftest.timeskew.state", descriptionKey: "me.selftest.timeskew.state", format: "enum" },
  {
    path: "selftest.timeskew.max_skew_secs_15m",
    descriptionKey: "me.selftest.timeskew.max_skew_secs_15m",
    unit: "seconds",
  },
  {
    path: "selftest.timeskew.samples_15m",
    descriptionKey: "me.selftest.timeskew.samples_15m",
    format: "integer",
  },
  {
    path: "selftest.timeskew.last_skew_secs",
    descriptionKey: "me.selftest.timeskew.last_skew_secs",
    unit: "seconds",
  },
  {
    path: "selftest.timeskew.last_source",
    descriptionKey: "me.selftest.timeskew.last_source",
    format: "enum",
  },
  {
    path: "selftest.timeskew.last_seen_age_secs",
    descriptionKey: "me.selftest.timeskew.last_seen_age_secs",
    unit: "seconds",
  },
  { path: "selftest.ip", descriptionKey: "me.selftest.ip" },
  { path: "selftest.ip.v4.addr", descriptionKey: "me.selftest.ip.v4.addr", format: "address" },
  { path: "selftest.ip.v4.state", descriptionKey: "me.selftest.ip.v4.state", format: "enum" },
  { path: "selftest.ip.v6.addr", descriptionKey: "me.selftest.ip.v6.addr", format: "address" },
  { path: "selftest.ip.v6.state", descriptionKey: "me.selftest.ip.v6.state", format: "enum" },
  { path: "selftest.pid.pid", descriptionKey: "me.selftest.pid.pid", format: "integer" },
  { path: "selftest.pid.state", descriptionKey: "me.selftest.pid.state", format: "enum" },
  { path: "selftest.bnd", descriptionKey: "me.selftest.bnd" },
  { path: "selftest.bnd.addr_state", descriptionKey: "me.selftest.bnd.addr_state", format: "enum" },
  { path: "selftest.bnd.port_state", descriptionKey: "me.selftest.bnd.port_state", format: "enum" },
  {
    path: "selftest.bnd.last_addr",
    descriptionKey: "me.selftest.bnd.last_addr",
    format: "address",
  },
  {
    path: "selftest.bnd.last_seen_age_secs",
    descriptionKey: "me.selftest.bnd.last_seen_age_secs",
    unit: "seconds",
  },
  { path: "selftest.upstreams", descriptionKey: "me.selftest.upstreams" },
  {
    path: "selftest.upstreams.*.upstream_id",
    descriptionKey: "me.selftest.upstreams.*.upstream_id",
    format: "integer",
  },
  {
    path: "selftest.upstreams.*.route_kind",
    descriptionKey: "me.selftest.upstreams.*.route_kind",
    format: "enum",
  },
  {
    path: "selftest.upstreams.*.address",
    descriptionKey: "me.selftest.upstreams.*.address",
    format: "address",
  },
  {
    path: "selftest.upstreams.*.ip",
    descriptionKey: "me.selftest.upstreams.*.ip",
    format: "address",
  },
  {
    path: "selftest.upstreams.*.bnd.addr_state",
    descriptionKey: "me.selftest.bnd.addr_state",
    format: "enum",
  },
  {
    path: "selftest.upstreams.*.bnd.port_state",
    descriptionKey: "me.selftest.bnd.port_state",
    format: "enum",
  },
  {
    path: "selftest.upstreams.*.bnd.last_addr",
    descriptionKey: "me.selftest.bnd.last_addr",
    format: "address",
  },
  {
    path: "selftest.upstreams.*.bnd.last_seen_age_secs",
    descriptionKey: "me.selftest.bnd.last_seen_age_secs",
    unit: "seconds",
  },
  { path: "selftest.upstreams.*.bnd", descriptionKey: "me.selftest.bnd" },
  {
    path: "me_runtime.active_generation",
    descriptionKey: "me.runtime.active_generation",
    format: "integer",
  },
  {
    path: "me_runtime.warm_generation",
    descriptionKey: "me.runtime.warm_generation",
    format: "integer",
  },
  {
    path: "me_runtime.pending_hardswap_generation",
    descriptionKey: "me.runtime.pending_hardswap_generation",
    format: "integer",
  },
  {
    path: "me_runtime.pending_hardswap_age_secs",
    descriptionKey: "me.runtime.pending_hardswap_age_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.hardswap_enabled",
    descriptionKey: "me.runtime.hardswap_enabled",
    format: "boolean",
  },
  { path: "me_runtime.floor_mode", descriptionKey: "me.runtime.floor_mode", format: "enum" },
  {
    path: "me_runtime.adaptive_floor_idle_secs",
    descriptionKey: "me.runtime.adaptive_floor_idle_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.adaptive_floor_min_writers_single_endpoint",
    descriptionKey: "me.runtime.adaptive_floor_min_writers_single_endpoint",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_min_writers_multi_endpoint",
    descriptionKey: "me.runtime.adaptive_floor_min_writers_multi_endpoint",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_recover_grace_secs",
    descriptionKey: "me.runtime.adaptive_floor_recover_grace_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.adaptive_floor_writers_per_core_total",
    descriptionKey: "me.runtime.adaptive_floor_writers_per_core_total",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_cpu_cores_override",
    descriptionKey: "me.runtime.adaptive_floor_cpu_cores_override",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_max_extra_writers_single_per_core",
    descriptionKey: "me.runtime.adaptive_floor_max_extra_writers_single_per_core",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_max_extra_writers_multi_per_core",
    descriptionKey: "me.runtime.adaptive_floor_max_extra_writers_multi_per_core",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_max_active_writers_per_core",
    descriptionKey: "me.runtime.adaptive_floor_max_active_writers_per_core",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_max_warm_writers_per_core",
    descriptionKey: "me.runtime.adaptive_floor_max_warm_writers_per_core",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_max_active_writers_global",
    descriptionKey: "me.runtime.adaptive_floor_max_active_writers_global",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_max_warm_writers_global",
    descriptionKey: "me.runtime.adaptive_floor_max_warm_writers_global",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_cpu_cores_detected",
    descriptionKey: "me.runtime.adaptive_floor_cpu_cores_detected",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_cpu_cores_effective",
    descriptionKey: "me.runtime.adaptive_floor_cpu_cores_effective",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_global_cap_raw",
    descriptionKey: "me.runtime.adaptive_floor_global_cap_raw",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_global_cap_effective",
    descriptionKey: "me.runtime.adaptive_floor_global_cap_effective",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_target_writers_total",
    descriptionKey: "me.runtime.adaptive_floor_target_writers_total",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_active_cap_configured",
    descriptionKey: "me.runtime.adaptive_floor_active_cap_configured",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_active_cap_effective",
    descriptionKey: "me.runtime.adaptive_floor_active_cap_effective",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_warm_cap_configured",
    descriptionKey: "me.runtime.adaptive_floor_warm_cap_configured",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_warm_cap_effective",
    descriptionKey: "me.runtime.adaptive_floor_warm_cap_effective",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_active_writers_current",
    descriptionKey: "me.runtime.adaptive_floor_active_writers_current",
    format: "integer",
  },
  {
    path: "me_runtime.adaptive_floor_warm_writers_current",
    descriptionKey: "me.runtime.adaptive_floor_warm_writers_current",
    format: "integer",
  },
  {
    path: "me_runtime.me_keepalive_enabled",
    descriptionKey: "me.runtime.me_keepalive_enabled",
    format: "boolean",
  },
  {
    path: "me_runtime.me_keepalive_interval_secs",
    descriptionKey: "me.runtime.me_keepalive_interval_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.me_keepalive_jitter_secs",
    descriptionKey: "me.runtime.me_keepalive_jitter_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.me_keepalive_payload_random",
    descriptionKey: "me.runtime.me_keepalive_payload_random",
    format: "boolean",
  },
  {
    path: "me_runtime.rpc_proxy_req_every_secs",
    descriptionKey: "me.runtime.rpc_proxy_req_every_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.me_reconnect_max_concurrent_per_dc",
    descriptionKey: "me.runtime.me_reconnect_max_concurrent_per_dc",
    format: "integer",
  },
  {
    path: "me_runtime.me_reconnect_backoff_base_ms",
    descriptionKey: "me.runtime.me_reconnect_backoff_base_ms",
    unit: "milliseconds",
  },
  {
    path: "me_runtime.me_reconnect_backoff_cap_ms",
    descriptionKey: "me.runtime.me_reconnect_backoff_cap_ms",
    unit: "milliseconds",
  },
  {
    path: "me_runtime.me_reconnect_fast_retry_count",
    descriptionKey: "me.runtime.me_reconnect_fast_retry_count",
    format: "integer",
  },
  {
    path: "me_runtime.me_pool_drain_ttl_secs",
    descriptionKey: "me.runtime.me_pool_drain_ttl_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.me_pool_force_close_secs",
    descriptionKey: "me.runtime.me_pool_force_close_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.me_pool_min_fresh_ratio",
    descriptionKey: "me.runtime.me_pool_min_fresh_ratio",
    format: "decimal",
  },
  {
    path: "me_runtime.me_bind_stale_mode",
    descriptionKey: "me.runtime.me_bind_stale_mode",
    format: "enum",
  },
  {
    path: "me_runtime.me_bind_stale_ttl_secs",
    descriptionKey: "me.runtime.me_bind_stale_ttl_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.me_single_endpoint_shadow_writers",
    descriptionKey: "me.runtime.me_single_endpoint_shadow_writers",
    format: "integer",
  },
  {
    path: "me_runtime.me_single_endpoint_outage_mode_enabled",
    descriptionKey: "me.runtime.me_single_endpoint_outage_mode_enabled",
    format: "boolean",
  },
  {
    path: "me_runtime.me_single_endpoint_outage_disable_quarantine",
    descriptionKey: "me.runtime.me_single_endpoint_outage_disable_quarantine",
    format: "boolean",
  },
  {
    path: "me_runtime.me_single_endpoint_outage_backoff_min_ms",
    descriptionKey: "me.runtime.me_single_endpoint_outage_backoff_min_ms",
    unit: "milliseconds",
  },
  {
    path: "me_runtime.me_single_endpoint_outage_backoff_max_ms",
    descriptionKey: "me.runtime.me_single_endpoint_outage_backoff_max_ms",
    unit: "milliseconds",
  },
  {
    path: "me_runtime.me_single_endpoint_shadow_rotate_every_secs",
    descriptionKey: "me.runtime.me_single_endpoint_shadow_rotate_every_secs",
    unit: "seconds",
  },
  {
    path: "me_runtime.me_deterministic_writer_sort",
    descriptionKey: "me.runtime.me_deterministic_writer_sort",
    format: "boolean",
  },
  {
    path: "me_runtime.me_writer_pick_mode",
    descriptionKey: "me.runtime.me_writer_pick_mode",
    format: "enum",
  },
  {
    path: "me_runtime.me_writer_pick_sample_size",
    descriptionKey: "me.runtime.me_writer_pick_sample_size",
    format: "integer",
  },
  {
    path: "me_runtime.me_socks_kdf_policy",
    descriptionKey: "me.runtime.me_socks_kdf_policy",
    format: "enum",
  },
  {
    path: "me_runtime.quarantined_endpoints_total",
    descriptionKey: "me.runtime.quarantined_endpoints_total",
    format: "integer",
  },
  { path: "me_runtime.quarantined_endpoints", descriptionKey: "me.runtime.quarantined_endpoints" },
  {
    path: "me_runtime.quarantined_endpoints.*.endpoint",
    descriptionKey: "me.runtime.quarantined_endpoints.*.endpoint",
    format: "address",
  },
  {
    path: "me_runtime.quarantined_endpoints.*.remaining_ms",
    descriptionKey: "me.runtime.quarantined_endpoints.*.remaining_ms",
    unit: "milliseconds",
  },
  // The BARE `dc_rtt.*` spelling, kept alongside the page-rooted
  // `quality.dc_rtt.*` above: §8.3 asks both spellings of a path to resolve
  // to one sentence, and this is the one a context rooted at the ME quality
  // payload itself uses. It is also criterion (c) of classifyValue — a
  // described key makes these per-DC rows a typed record rather than a
  // verbatim-key counters map.
  { path: "dc_rtt.*.dc", descriptionKey: "dc.dc", format: "integer" },
  { path: "dc_rtt.*.rtt_ema_ms", descriptionKey: "me.dc_rtt.rtt_ema_ms", unit: "milliseconds" },
  { path: "dc_rtt.*.alive_writers", descriptionKey: "me.dc_rtt.alive_writers", format: "integer" },
  {
    path: "dc_rtt.*.required_writers",
    descriptionKey: "me.dc_rtt.required_writers",
    format: "integer",
  },
  { path: "dc_rtt.*.coverage_pct", descriptionKey: "me.dc_rtt.coverage_pct", unit: "percent" },
];

/** The REST endpoint the TLS-fingerprint rankings read (Task 1). */
export const TLS_FINGERPRINTS_ENDPOINT = "/api/telemt/tls-fingerprints";

// The TLS domain is ENDPOINT-SCOPED, not global, and deliberately so: its
// record fields are named `total`, `limit`, `capacity`, `scope` — words
// every other Telemt payload also uses for something else. A global entry
// for `limit` would describe some future page's unrelated limit as a TLS
// capture bound. R9's endpoint scope exists for exactly this, and the
// ranking rows below are the first consumer of it.
//
// The four groups carry the same record, so one description serves all
// four spellings (§8.3: both spellings of a path resolve to one sentence).
const TLS_SCOPES = ["by_fingerprint", "by_ip", "by_cidr", "by_user"] as const;

function tlsRowField(
  field: string,
  extra: Omit<FieldCatalogEntry, "path" | "descriptionKey"> = {},
): FieldCatalogEntry[] {
  const key = `tls.${field}`;
  return TLS_SCOPES.map((scope) => ({
    path: `${scope}.*.${field}`,
    descriptionKey: key,
    ...extra,
  }));
}

const TLS_ENTRIES: FieldCatalogEntry[] = [
  { path: "limit", descriptionKey: "tls.limit", format: "integer" },
  { path: "retention_secs", descriptionKey: "tls.retention_secs", unit: "seconds" },
  { path: "capacity", descriptionKey: "tls.capacity", format: "integer" },
  { path: "dropped_total", descriptionKey: "tls.dropped_total", format: "integer" },
  { path: "parse_error_total", descriptionKey: "tls.parse_error_total", format: "integer" },
  ...TLS_SCOPES.map((scope) => ({ path: scope, descriptionKey: `tls.${scope}` })),
  ...tlsRowField("scope", { format: "identifier" }),
  ...tlsRowField("ja3", { format: "identifier" }),
  ...tlsRowField("ja3_raw", { format: "identifier" }),
  ...tlsRowField("ja4", { format: "identifier" }),
  ...tlsRowField("ja4_raw", { format: "identifier" }),
  ...tlsRowField("total", { format: "integer" }),
  ...tlsRowField("auth_success", { format: "integer" }),
  ...tlsRowField("bad_or_probe", { format: "integer" }),
  // An epoch MOMENT, not a duration: without the unit the counters family
  // reads the `_secs` suffix as a span and prints "20 322 дн."
  ...tlsRowField("first_seen_epoch_secs", { unit: "timestamp" }),
  ...tlsRowField("last_seen_epoch_secs", { unit: "timestamp" }),
];

// The Security domain (TELEMT_LIVE_API_DATA §12, §20) — posture, whitelist
// and effective limits, as the `security` topic delivers them.
//
// Global rather than endpoint-scoped, unlike TLS: every path here is
// already prefixed by the topic field it arrives under (`posture.`,
// `whitelist.`, `effective_limits.`), so none of them can collide with a
// bare `total`/`limit`/`scope` somewhere else the way the TLS record fields
// would have.
const SECURITY_POSTURE_ENTRIES: FieldCatalogEntry[] = [
  { path: "posture.api_read_only", descriptionKey: "security.posture.api_read_only", format: "boolean" },
  {
    path: "posture.api_whitelist_enabled",
    descriptionKey: "security.posture.api_whitelist_enabled",
    format: "boolean",
  },
  {
    path: "posture.api_whitelist_entries",
    descriptionKey: "security.posture.api_whitelist_entries",
    format: "integer",
  },
  {
    path: "posture.api_auth_header_enabled",
    descriptionKey: "security.posture.api_auth_header_enabled",
    format: "boolean",
  },
  {
    path: "posture.proxy_protocol_enabled",
    descriptionKey: "security.posture.proxy_protocol_enabled",
    format: "boolean",
  },
  { path: "posture.log_level", descriptionKey: "security.posture.log_level", format: "enum" },
  {
    path: "posture.telemetry_core_enabled",
    descriptionKey: "security.posture.telemetry_core_enabled",
    format: "boolean",
  },
  {
    path: "posture.telemetry_user_enabled",
    descriptionKey: "security.posture.telemetry_user_enabled",
    format: "boolean",
  },
  {
    path: "posture.telemetry_me_level",
    descriptionKey: "security.posture.telemetry_me_level",
    format: "enum",
  },
];

const SECURITY_WHITELIST_ENTRIES: FieldCatalogEntry[] = [
  // A generation MOMENT, not a duration — without the unit the counters
  // family reads the `_secs` suffix as a span (Task 3 review carry-over).
  {
    path: "whitelist.generated_at_epoch_secs",
    descriptionKey: "security.whitelist.generated_at_epoch_secs",
    unit: "timestamp",
  },
  { path: "whitelist.enabled", descriptionKey: "security.whitelist.enabled", format: "boolean" },
  {
    path: "whitelist.entries_total",
    descriptionKey: "security.whitelist.entries_total",
    format: "integer",
  },
  { path: "whitelist.entries", descriptionKey: "security.whitelist.entries" },
  // R6: an admin's own allow-list addresses are shown, not masked — the
  // masking policy covers secrets, and this is the operator's own data.
  {
    path: "whitelist.entries.*",
    descriptionKey: "security.whitelist.entry",
    format: "address",
  },
];

function limitField(path: string, extra: Omit<FieldCatalogEntry, "path" | "descriptionKey"> = {}) {
  return {
    path: `effective_limits.${path}`,
    descriptionKey: `security.limits.${path}`,
    ...extra,
  };
}

const SECURITY_LIMITS_ENTRIES: FieldCatalogEntry[] = [
  limitField("update_every_secs", { unit: "seconds" }),
  limitField("me_reinit_every_secs", { unit: "seconds" }),
  limitField("me_pool_force_close_secs", { unit: "seconds" }),
  limitField("timeouts.client_first_byte_idle_secs", { unit: "seconds" }),
  limitField("timeouts.client_handshake_secs", { unit: "seconds" }),
  limitField("timeouts.tg_connect_secs", { unit: "seconds" }),
  limitField("timeouts.client_keepalive_secs", { unit: "seconds" }),
  limitField("timeouts.client_ack_secs", { unit: "seconds" }),
  limitField("timeouts.me_one_retry", { format: "integer" }),
  limitField("timeouts.me_one_timeout_ms", { unit: "milliseconds" }),
  limitField("upstream.connect_retry_attempts", { format: "integer" }),
  limitField("upstream.connect_retry_backoff_ms", { unit: "milliseconds" }),
  limitField("upstream.connect_budget_ms", { unit: "milliseconds" }),
  limitField("upstream.unhealthy_fail_threshold", { format: "integer" }),
  limitField("upstream.connect_failfast_hard_errors", { format: "boolean" }),
  // ONE honest wildcard for the whole middle_proxy block, on purpose.
  // EffectiveMiddleProxyLimits is `Record<string, unknown>` — a
  // forward-compatible dump of ~21 internal pool knobs whose individual
  // semantics the panel does not know. §8.2 forbids inventing business
  // meaning for a field we have never seen, so the entry says exactly what
  // is true of every key in it rather than 21 guesses.
  {
    path: "effective_limits.middle_proxy.*",
    descriptionKey: "security.limits.middle_proxy",
  },
  limitField("user_ip_policy.global_each", { format: "integer" }),
  limitField("user_ip_policy.mode", { format: "enum" }),
  limitField("user_ip_policy.window_secs", { unit: "seconds" }),
  limitField("user_tcp_policy.global_each", { format: "integer" }),
];

const SECURITY_ENTRIES: FieldCatalogEntry[] = [
  ...SECURITY_POSTURE_ENTRIES,
  ...SECURITY_WHITELIST_ENTRIES,
  ...SECURITY_LIMITS_ENTRIES,
];

// The Counters domain (`GET /v1/stats/zero/all`, TELEMT_LIVE_API_DATA §11).
//
// §8.2's fourth step — the counters FAMILY rule — stays the backstop for
// this domain: a key a future Telemt adds is described by its suffix and
// nothing else, which is what makes the page forward-compatible. The
// entries below are the counters Telemt's own API reference documents
// today, each sentence a translation of that reference rather than a guess
// (§8.2 forbids inventing business meaning).
//
// Every path is prefixed by its zero/all section, so none of these can
// describe a same-named field on another page: `pool.pool_swap_total` here
// versus the ME page's `pool.generations.active_generation`, and
// `upstream.connect_attempt_total` here versus the Upstreams page's
// `zero.connect_attempt_total`.
const COUNTERS_ENTRIES: FieldCatalogEntry[] = [
  { path: "core.uptime_seconds", descriptionKey: "counters.core.uptime_seconds", unit: "seconds" },
  {
    path: "core.connections_total",
    descriptionKey: "counters.core.connections_total",
    format: "integer",
  },
  {
    path: "core.connections_bad_total",
    descriptionKey: "counters.core.connections_bad_total",
    format: "integer",
  },
  {
    path: "core.connections_bad_by_class",
    descriptionKey: "counters.core.connections_bad_by_class",
  },
  {
    path: "core.handshake_failures_by_class",
    descriptionKey: "counters.core.handshake_failures_by_class",
  },
  {
    path: "core.handshake_failures_by_stage",
    descriptionKey: "counters.core.handshake_failures_by_stage",
  },
  {
    path: "core.handshake_timeouts_total",
    descriptionKey: "counters.core.handshake_timeouts_total",
    format: "integer",
  },
  {
    path: "core.accept_permit_timeout_total",
    descriptionKey: "counters.core.accept_permit_timeout_total",
    format: "integer",
  },
  {
    path: "core.configured_users",
    descriptionKey: "counters.core.configured_users",
    format: "integer",
  },
  {
    path: "core.telemetry_core_enabled",
    descriptionKey: "counters.core.telemetry_core_enabled",
    format: "boolean",
  },
  {
    path: "core.telemetry_user_enabled",
    descriptionKey: "counters.core.telemetry_user_enabled",
    format: "boolean",
  },
  {
    path: "core.telemetry_me_level",
    descriptionKey: "counters.core.telemetry_me_level",
    format: "enum",
  },
  {
    path: "core.conntrack_control_enabled",
    descriptionKey: "counters.core.conntrack_control_enabled",
    format: "boolean",
  },
  {
    path: "core.conntrack_control_available",
    descriptionKey: "counters.core.conntrack_control_available",
    format: "boolean",
  },
  {
    path: "core.conntrack_pressure_active",
    descriptionKey: "counters.core.conntrack_pressure_active",
    format: "boolean",
  },
  {
    path: "core.conntrack_event_queue_depth",
    descriptionKey: "counters.core.conntrack_event_queue_depth",
    format: "integer",
  },
  {
    path: "core.conntrack_rule_apply_ok",
    descriptionKey: "counters.core.conntrack_rule_apply_ok",
    format: "boolean",
  },
  {
    path: "core.conntrack_delete_attempt_total",
    descriptionKey: "counters.core.conntrack_delete_attempt_total",
    format: "integer",
  },
  {
    path: "core.conntrack_delete_success_total",
    descriptionKey: "counters.core.conntrack_delete_success_total",
    format: "integer",
  },
  {
    path: "core.conntrack_delete_not_found_total",
    descriptionKey: "counters.core.conntrack_delete_not_found_total",
    format: "integer",
  },
  {
    path: "core.conntrack_delete_error_total",
    descriptionKey: "counters.core.conntrack_delete_error_total",
    format: "integer",
  },
  {
    path: "core.conntrack_close_event_drop_total",
    descriptionKey: "counters.core.conntrack_close_event_drop_total",
    format: "integer",
  },
  {
    path: "upstream.connect_attempt_total",
    descriptionKey: "counters.upstream.connect_attempt_total",
    format: "integer",
  },
  {
    path: "upstream.connect_success_total",
    descriptionKey: "counters.upstream.connect_success_total",
    format: "integer",
  },
  {
    path: "upstream.connect_fail_total",
    descriptionKey: "counters.upstream.connect_fail_total",
    format: "integer",
  },
  {
    path: "upstream.connect_failfast_hard_error_total",
    descriptionKey: "counters.upstream.connect_failfast_hard_error_total",
    format: "integer",
  },
  {
    path: "upstream.connect_attempts_bucket_1",
    descriptionKey: "counters.upstream.connect_attempts_bucket_1",
    format: "integer",
  },
  {
    path: "upstream.connect_attempts_bucket_2",
    descriptionKey: "counters.upstream.connect_attempts_bucket_2",
    format: "integer",
  },
  {
    path: "upstream.connect_attempts_bucket_3_4",
    descriptionKey: "counters.upstream.connect_attempts_bucket_3_4",
    format: "integer",
  },
  {
    path: "upstream.connect_attempts_bucket_gt_4",
    descriptionKey: "counters.upstream.connect_attempts_bucket_gt_4",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_success_bucket_le_100ms",
    descriptionKey: "counters.upstream.connect_duration_success_bucket_le_100ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_success_bucket_101_500ms",
    descriptionKey: "counters.upstream.connect_duration_success_bucket_101_500ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_success_bucket_501_1000ms",
    descriptionKey: "counters.upstream.connect_duration_success_bucket_501_1000ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_success_bucket_gt_1000ms",
    descriptionKey: "counters.upstream.connect_duration_success_bucket_gt_1000ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_fail_bucket_le_100ms",
    descriptionKey: "counters.upstream.connect_duration_fail_bucket_le_100ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_fail_bucket_101_500ms",
    descriptionKey: "counters.upstream.connect_duration_fail_bucket_101_500ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_fail_bucket_501_1000ms",
    descriptionKey: "counters.upstream.connect_duration_fail_bucket_501_1000ms",
    format: "integer",
  },
  {
    path: "upstream.connect_duration_fail_bucket_gt_1000ms",
    descriptionKey: "counters.upstream.connect_duration_fail_bucket_gt_1000ms",
    format: "integer",
  },
  {
    path: "middle_proxy.keepalive_sent_total",
    descriptionKey: "counters.middle_proxy.keepalive_sent_total",
    format: "integer",
  },
  {
    path: "middle_proxy.keepalive_failed_total",
    descriptionKey: "counters.middle_proxy.keepalive_failed_total",
    format: "integer",
  },
  {
    path: "middle_proxy.keepalive_pong_total",
    descriptionKey: "counters.middle_proxy.keepalive_pong_total",
    format: "integer",
  },
  {
    path: "middle_proxy.keepalive_timeout_total",
    descriptionKey: "counters.middle_proxy.keepalive_timeout_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_sent_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_sent_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_failed_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_failed_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_skipped_no_meta_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_skipped_no_meta_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_response_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_response_total",
    format: "integer",
  },
  {
    path: "middle_proxy.rpc_proxy_req_signal_close_sent_total",
    descriptionKey: "counters.middle_proxy.rpc_proxy_req_signal_close_sent_total",
    format: "integer",
  },
  {
    path: "middle_proxy.reconnect_attempt_total",
    descriptionKey: "counters.middle_proxy.reconnect_attempt_total",
    format: "integer",
  },
  {
    path: "middle_proxy.reconnect_success_total",
    descriptionKey: "counters.middle_proxy.reconnect_success_total",
    format: "integer",
  },
  {
    path: "middle_proxy.handshake_reject_total",
    descriptionKey: "counters.middle_proxy.handshake_reject_total",
    format: "integer",
  },
  {
    path: "middle_proxy.handshake_error_codes",
    descriptionKey: "counters.middle_proxy.handshake_error_codes",
  },
  {
    path: "middle_proxy.reader_eof_total",
    descriptionKey: "counters.middle_proxy.reader_eof_total",
    format: "integer",
  },
  {
    path: "middle_proxy.idle_close_by_peer_total",
    descriptionKey: "counters.middle_proxy.idle_close_by_peer_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_no_conn_total",
    descriptionKey: "counters.middle_proxy.route_drop_no_conn_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_channel_closed_total",
    descriptionKey: "counters.middle_proxy.route_drop_channel_closed_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_queue_full_total",
    descriptionKey: "counters.middle_proxy.route_drop_queue_full_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_queue_full_base_total",
    descriptionKey: "counters.middle_proxy.route_drop_queue_full_base_total",
    format: "integer",
  },
  {
    path: "middle_proxy.route_drop_queue_full_high_total",
    descriptionKey: "counters.middle_proxy.route_drop_queue_full_high_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_batches_total",
    descriptionKey: "counters.middle_proxy.d2c_batches_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_batch_frames_total",
    descriptionKey: "counters.middle_proxy.d2c_batch_frames_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_batch_bytes_total",
    descriptionKey: "counters.middle_proxy.d2c_batch_bytes_total",
    unit: "bytes",
  },
  {
    path: "middle_proxy.d2c_flush_reason_queue_drain_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_queue_drain_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_batch_frames_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_batch_frames_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_batch_bytes_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_batch_bytes_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_max_delay_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_max_delay_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_ack_immediate_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_ack_immediate_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_flush_reason_close_total",
    descriptionKey: "counters.middle_proxy.d2c_flush_reason_close_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_data_frames_total",
    descriptionKey: "counters.middle_proxy.d2c_data_frames_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_ack_frames_total",
    descriptionKey: "counters.middle_proxy.d2c_ack_frames_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_payload_bytes_total",
    descriptionKey: "counters.middle_proxy.d2c_payload_bytes_total",
    unit: "bytes",
  },
  {
    path: "middle_proxy.d2c_write_mode_coalesced_total",
    descriptionKey: "counters.middle_proxy.d2c_write_mode_coalesced_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_write_mode_split_total",
    descriptionKey: "counters.middle_proxy.d2c_write_mode_split_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_quota_reject_pre_write_total",
    descriptionKey: "counters.middle_proxy.d2c_quota_reject_pre_write_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_quota_reject_post_write_total",
    descriptionKey: "counters.middle_proxy.d2c_quota_reject_post_write_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_frame_buf_shrink_total",
    descriptionKey: "counters.middle_proxy.d2c_frame_buf_shrink_total",
    format: "integer",
  },
  {
    path: "middle_proxy.d2c_frame_buf_shrink_bytes_total",
    descriptionKey: "counters.middle_proxy.d2c_frame_buf_shrink_bytes_total",
    unit: "bytes",
  },
  {
    path: "middle_proxy.socks_kdf_strict_reject_total",
    descriptionKey: "counters.middle_proxy.socks_kdf_strict_reject_total",
    format: "integer",
  },
  {
    path: "middle_proxy.socks_kdf_compat_fallback_total",
    descriptionKey: "counters.middle_proxy.socks_kdf_compat_fallback_total",
    format: "integer",
  },
  {
    path: "middle_proxy.endpoint_quarantine_total",
    descriptionKey: "counters.middle_proxy.endpoint_quarantine_total",
    format: "integer",
  },
  {
    path: "middle_proxy.kdf_drift_total",
    descriptionKey: "counters.middle_proxy.kdf_drift_total",
    format: "integer",
  },
  {
    path: "middle_proxy.kdf_port_only_drift_total",
    descriptionKey: "counters.middle_proxy.kdf_port_only_drift_total",
    format: "integer",
  },
  {
    path: "middle_proxy.hardswap_pending_reuse_total",
    descriptionKey: "counters.middle_proxy.hardswap_pending_reuse_total",
    format: "integer",
  },
  {
    path: "middle_proxy.hardswap_pending_ttl_expired_total",
    descriptionKey: "counters.middle_proxy.hardswap_pending_ttl_expired_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_outage_enter_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_outage_enter_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_outage_exit_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_outage_exit_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_outage_reconnect_attempt_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_outage_reconnect_attempt_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_outage_reconnect_success_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_outage_reconnect_success_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_quarantine_bypass_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_quarantine_bypass_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_shadow_rotate_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_shadow_rotate_total",
    format: "integer",
  },
  {
    path: "middle_proxy.single_endpoint_shadow_rotate_skipped_quarantine_total",
    descriptionKey: "counters.middle_proxy.single_endpoint_shadow_rotate_skipped_quarantine_total",
    format: "integer",
  },
  {
    path: "middle_proxy.floor_mode_switch_total",
    descriptionKey: "counters.middle_proxy.floor_mode_switch_total",
    format: "integer",
  },
  {
    path: "middle_proxy.floor_mode_switch_static_to_adaptive_total",
    descriptionKey: "counters.middle_proxy.floor_mode_switch_static_to_adaptive_total",
    format: "integer",
  },
  {
    path: "middle_proxy.floor_mode_switch_adaptive_to_static_total",
    descriptionKey: "counters.middle_proxy.floor_mode_switch_adaptive_to_static_total",
    format: "integer",
  },
  {
    path: "pool.pool_swap_total",
    descriptionKey: "counters.pool.pool_swap_total",
    format: "integer",
  },
  {
    path: "pool.pool_drain_active",
    descriptionKey: "counters.pool.pool_drain_active",
    format: "integer",
  },
  {
    path: "pool.pool_force_close_total",
    descriptionKey: "counters.pool.pool_force_close_total",
    format: "integer",
  },
  {
    path: "pool.pool_stale_pick_total",
    descriptionKey: "counters.pool.pool_stale_pick_total",
    format: "integer",
  },
  {
    path: "pool.writer_removed_total",
    descriptionKey: "counters.pool.writer_removed_total",
    format: "integer",
  },
  {
    path: "pool.writer_removed_unexpected_total",
    descriptionKey: "counters.pool.writer_removed_unexpected_total",
    format: "integer",
  },
  {
    path: "pool.refill_triggered_total",
    descriptionKey: "counters.pool.refill_triggered_total",
    format: "integer",
  },
  {
    path: "pool.refill_skipped_inflight_total",
    descriptionKey: "counters.pool.refill_skipped_inflight_total",
    format: "integer",
  },
  {
    path: "pool.refill_failed_total",
    descriptionKey: "counters.pool.refill_failed_total",
    format: "integer",
  },
  {
    path: "pool.writer_restored_same_endpoint_total",
    descriptionKey: "counters.pool.writer_restored_same_endpoint_total",
    format: "integer",
  },
  {
    path: "pool.writer_restored_fallback_total",
    descriptionKey: "counters.pool.writer_restored_fallback_total",
    format: "integer",
  },
  {
    path: "desync.secure_padding_invalid_total",
    descriptionKey: "counters.desync.secure_padding_invalid_total",
    format: "integer",
  },
  {
    path: "desync.desync_total",
    descriptionKey: "counters.desync.desync_total",
    format: "integer",
  },
  {
    path: "desync.desync_full_logged_total",
    descriptionKey: "counters.desync.desync_full_logged_total",
    format: "integer",
  },
  {
    path: "desync.desync_suppressed_total",
    descriptionKey: "counters.desync.desync_suppressed_total",
    format: "integer",
  },
  {
    path: "desync.desync_frames_bucket_0",
    descriptionKey: "counters.desync.desync_frames_bucket_0",
    format: "integer",
  },
  {
    path: "desync.desync_frames_bucket_1_2",
    descriptionKey: "counters.desync.desync_frames_bucket_1_2",
    format: "integer",
  },
  {
    path: "desync.desync_frames_bucket_3_10",
    descriptionKey: "counters.desync.desync_frames_bucket_3_10",
    format: "integer",
  },
  {
    path: "desync.desync_frames_bucket_gt_10",
    descriptionKey: "counters.desync.desync_frames_bucket_gt_10",
    format: "integer",
  },
  {
    path: "core.connections_bad_by_class.*.class",
    descriptionKey: "counters.class",
    format: "enum",
  },
  {
    path: "core.handshake_failures_by_class.*.class",
    descriptionKey: "counters.class",
    format: "enum",
  },
  {
    path: "core.connections_bad_by_class.*.total",
    descriptionKey: "counters.class_total",
    format: "integer",
  },
  {
    path: "core.handshake_failures_by_class.*.total",
    descriptionKey: "counters.class_total",
    format: "integer",
  },
  {
    path: "core.handshake_failures_by_stage.*.stage",
    descriptionKey: "counters.stage",
    format: "enum",
  },
  {
    path: "core.handshake_failures_by_stage.*.total",
    descriptionKey: "counters.stage_total",
    format: "integer",
  },
  {
    path: "middle_proxy.handshake_error_codes.*.code",
    descriptionKey: "counters.error_code",
    format: "integer",
  },
  {
    path: "middle_proxy.handshake_error_codes.*.total",
    descriptionKey: "counters.error_code_total",
    format: "integer",
  },
];

// The Upstreams domain (`GET /v1/stats/upstreams` +
// `GET /v1/runtime/upstream-quality`, TELEMT_LIVE_API_DATA §7).
//
// The two response envelopes are keyed `stats.*` and `upstream_quality.*`
// rather than bare, because §8.2's exact step is GLOBAL and the bare
// `reason` / `generated_at_epoch_secs` already belong to the DC domain,
// where they say something else entirely. definitions/upstreams.ts nests
// the page context to match.
//
// Two entries are ALIASES for a second spelling of the same field:
// EntityListSection resolves a `highlights` path against
// `<collection>.<field>` (never `<collection>.*.<field>`), so the row's two
// headline numbers would otherwise be described by the counters-family
// guess instead of by their own sentence. Same device the DC domain uses
// for its entity-rooted paths.
/** The sixteen `zero` connect counters of `GET /v1/stats/upstreams` (§7). */
const ZERO_FIELDS = [
  "connect_attempt_total",
  "connect_success_total",
  "connect_fail_total",
  "connect_failfast_hard_error_total",
  "connect_attempts_bucket_1",
  "connect_attempts_bucket_2",
  "connect_attempts_bucket_3_4",
  "connect_attempts_bucket_gt_4",
  "connect_duration_success_bucket_le_100ms",
  "connect_duration_success_bucket_101_500ms",
  "connect_duration_success_bucket_501_1000ms",
  "connect_duration_success_bucket_gt_1000ms",
  "connect_duration_fail_bucket_le_100ms",
  "connect_duration_fail_bucket_101_500ms",
  "connect_duration_fail_bucket_501_1000ms",
  "connect_duration_fail_bucket_gt_1000ms",
] as const;

function upstreamRow(field: string, extra: Omit<FieldCatalogEntry, "path" | "descriptionKey"> = {}) {
  return { path: `upstreams.*.${field}`, descriptionKey: `upstreams.row.${field}`, ...extra };
}

const UPSTREAMS_ENTRIES: FieldCatalogEntry[] = [
  { path: "upstreams", descriptionKey: "upstreams.upstreams" },
  upstreamRow("upstream_id", { format: "identifier" }),
  upstreamRow("route_kind", { format: "enum" }),
  upstreamRow("address", { format: "address" }),
  upstreamRow("weight", { format: "integer" }),
  upstreamRow("scopes", { format: "enum" }),
  upstreamRow("healthy", { format: "boolean" }),
  upstreamRow("fails", { format: "integer" }),
  upstreamRow("last_check_age_secs", { unit: "seconds" }),
  upstreamRow("effective_latency_ms", {
    unit: "milliseconds",
    nullMeaningKey: "upstreams.row.effective_latency_ms",
  }),
  upstreamRow("dc"),
  // Aliases for the compact row's two highlights (see the note above).
  {
    path: "upstreams.effective_latency_ms",
    descriptionKey: "upstreams.row.effective_latency_ms",
    unit: "milliseconds",
    shortLabelKey: "upstreams.effective_latency_ms",
  },
  {
    path: "upstreams.fails",
    descriptionKey: "upstreams.row.fails",
    format: "integer",
    shortLabelKey: "upstreams.fails",
  },
  {
    path: "upstreams.*.dc.*.dc",
    descriptionKey: "upstreams.dc.dc",
    format: "integer",
  },
  {
    path: "upstreams.*.dc.*.latency_ema_ms",
    descriptionKey: "upstreams.dc.latency_ema_ms",
    unit: "milliseconds",
    nullMeaningKey: "upstreams.dc.latency_ema_ms",
  },
  {
    path: "upstreams.*.dc.*.ip_preference",
    descriptionKey: "upstreams.dc.ip_preference",
    format: "enum",
  },
  {
    path: "summary.configured_total",
    descriptionKey: "upstreams.summary.configured_total",
    format: "integer",
    shortLabelKey: "upstreams.summary.configured_total",
  },
  {
    path: "summary.healthy_total",
    descriptionKey: "upstreams.summary.healthy_total",
    format: "integer",
    shortLabelKey: "upstreams.summary.healthy_total",
  },
  {
    path: "summary.unhealthy_total",
    descriptionKey: "upstreams.summary.unhealthy_total",
    format: "integer",
  },
  {
    path: "summary.direct_total",
    descriptionKey: "upstreams.summary.direct_total",
    format: "integer",
  },
  {
    path: "summary.socks4_total",
    descriptionKey: "upstreams.summary.socks4_total",
    format: "integer",
  },
  {
    path: "summary.socks5_total",
    descriptionKey: "upstreams.summary.socks5_total",
    format: "integer",
  },
  {
    path: "summary.shadowsocks_total",
    descriptionKey: "upstreams.summary.shadowsocks_total",
    format: "integer",
  },
  ...ZERO_FIELDS.map((field) => ({
    path: `zero.${field}`,
    descriptionKey: `upstreams.zero.${field}`,
    format: "integer" as const,
  })),
  {
    path: "upstream_quality.policy.connect_retry_attempts",
    descriptionKey: "upstreams.policy.connect_retry_attempts",
    format: "integer",
  },
  {
    path: "upstream_quality.policy.connect_retry_backoff_ms",
    descriptionKey: "upstreams.policy.connect_retry_backoff_ms",
    unit: "milliseconds",
  },
  {
    path: "upstream_quality.policy.connect_budget_ms",
    descriptionKey: "upstreams.policy.connect_budget_ms",
    unit: "milliseconds",
  },
  {
    path: "upstream_quality.policy.unhealthy_fail_threshold",
    descriptionKey: "upstreams.policy.unhealthy_fail_threshold",
    format: "integer",
  },
  {
    path: "upstream_quality.policy.connect_failfast_hard_errors",
    descriptionKey: "upstreams.policy.connect_failfast_hard_errors",
    format: "boolean",
  },
  { path: "stats.enabled", descriptionKey: "upstreams.stats.enabled", format: "boolean" },
  { path: "stats.reason", descriptionKey: "upstreams.stats.reason", format: "enum" },
  {
    path: "stats.generated_at_epoch_secs",
    descriptionKey: "upstreams.stats.generated_at_epoch_secs",
    unit: "timestamp",
  },
  {
    path: "upstream_quality.enabled",
    descriptionKey: "upstreams.quality.enabled",
    format: "boolean",
  },
  { path: "upstream_quality.reason", descriptionKey: "upstreams.quality.reason", format: "enum" },
  {
    path: "upstream_quality.generated_at_epoch_secs",
    descriptionKey: "upstreams.quality.generated_at_epoch_secs",
    unit: "timestamp",
  },
];

// The Connections domain (`GET /v1/stats/summary` +
// `GET /v1/runtime/connections/summary`, TELEMT_LIVE_API_DATA §6, §17).
function topRow(
  scope: "by_connections" | "by_throughput",
  field: string,
  extra: Omit<FieldCatalogEntry, "path">,
): FieldCatalogEntry {
  return { path: `top.${scope}.*.${field}`, ...extra };
}

const CONNECTIONS_ENTRIES: FieldCatalogEntry[] = [
  {
    path: "summary.uptime_seconds",
    descriptionKey: "connections.summary.uptime_seconds",
    unit: "seconds",
  },
  {
    path: "summary.connections_total",
    descriptionKey: "connections.summary.connections_total",
    format: "integer",
    shortLabelKey: "connections.summary.connections_total",
  },
  {
    path: "summary.connections_bad_total",
    descriptionKey: "connections.summary.connections_bad_total",
    format: "integer",
    shortLabelKey: "connections.summary.connections_bad_total",
  },
  {
    path: "summary.handshake_timeouts_total",
    descriptionKey: "connections.summary.handshake_timeouts_total",
    format: "integer",
  },
  {
    path: "summary.configured_users",
    descriptionKey: "connections.summary.configured_users",
    format: "integer",
  },
  {
    path: "summary.connections_bad_by_class",
    descriptionKey: "connections.summary.connections_bad_by_class",
  },
  {
    path: "summary.connections_bad_by_class.*.class",
    descriptionKey: "connections.class",
    format: "enum",
  },
  {
    path: "summary.connections_bad_by_class.*.total",
    descriptionKey: "connections.class_total",
    format: "integer",
  },
  {
    path: "summary.handshake_failures_by_class",
    descriptionKey: "connections.summary.handshake_failures_by_class",
  },
  {
    path: "summary.handshake_failures_by_class.*.class",
    descriptionKey: "connections.class",
    format: "enum",
  },
  {
    path: "summary.handshake_failures_by_class.*.total",
    descriptionKey: "connections.class_total",
    format: "integer",
  },
  {
    path: "users_traffic_total",
    descriptionKey: "connections.users_traffic_total",
    unit: "bytes",
  },
  { path: "cache.ttl_ms", descriptionKey: "connections.cache.ttl_ms", unit: "milliseconds" },
  {
    path: "cache.served_from_cache",
    descriptionKey: "connections.cache.served_from_cache",
    format: "boolean",
  },
  {
    path: "cache.stale_cache_used",
    descriptionKey: "connections.cache.stale_cache_used",
    format: "boolean",
  },
  {
    path: "totals.current_connections",
    descriptionKey: "connections.totals.current_connections",
    format: "integer",
    shortLabelKey: "connections.totals.current_connections",
  },
  {
    path: "totals.current_connections_me",
    descriptionKey: "connections.totals.current_connections_me",
    format: "integer",
  },
  {
    path: "totals.current_connections_direct",
    descriptionKey: "connections.totals.current_connections_direct",
    format: "integer",
  },
  {
    path: "totals.active_users",
    descriptionKey: "connections.totals.active_users",
    format: "integer",
    shortLabelKey: "connections.totals.active_users",
  },
  { path: "top.limit", descriptionKey: "connections.top.limit", format: "integer" },
  { path: "top.by_connections", descriptionKey: "connections.top.by_connections" },
  { path: "top.by_throughput", descriptionKey: "connections.top.by_throughput" },
  topRow("by_connections", "username", { descriptionKey: "connections.top.username", format: "identifier" }),
  topRow("by_connections", "current_connections", {
    descriptionKey: "connections.top.current_connections",
    format: "integer",
    shortLabelKey: "connections.top.current_connections",
  }),
  topRow("by_connections", "total_octets", {
    descriptionKey: "connections.top.total_octets",
    unit: "bytes",
    shortLabelKey: "connections.top.total_octets",
  }),
  topRow("by_throughput", "username", { descriptionKey: "connections.top.username", format: "identifier" }),
  topRow("by_throughput", "current_connections", {
    descriptionKey: "connections.top.current_connections",
    format: "integer",
    shortLabelKey: "connections.top.current_connections",
  }),
  topRow("by_throughput", "total_octets", {
    descriptionKey: "connections.top.total_octets",
    unit: "bytes",
    shortLabelKey: "connections.top.total_octets",
  }),
  {
    path: "telemetry.user_enabled",
    descriptionKey: "connections.telemetry.user_enabled",
    format: "boolean",
  },
  {
    path: "telemetry.throughput_is_cumulative",
    descriptionKey: "connections.telemetry.throughput_is_cumulative",
    format: "boolean",
  },
];

// The NAT/STUN domain (`GET /v1/runtime/nat-stun`, TELEMT_LIVE_API_DATA §15).
const NAT_ENTRIES: FieldCatalogEntry[] = [
  {
    path: "flags.nat_probe_enabled",
    descriptionKey: "nat.flags.nat_probe_enabled",
    format: "boolean",
  },
  {
    path: "flags.nat_probe_disabled_runtime",
    descriptionKey: "nat.flags.nat_probe_disabled_runtime",
    format: "boolean",
  },
  {
    path: "flags.nat_probe_attempts",
    descriptionKey: "nat.flags.nat_probe_attempts",
    format: "integer",
    shortLabelKey: "nat.flags.nat_probe_attempts",
  },
  {
    path: "stun_backoff_remaining_ms",
    descriptionKey: "nat.stun_backoff_remaining_ms",
    unit: "milliseconds",
  },
  { path: "servers.configured", descriptionKey: "nat.servers.configured" },
  { path: "servers.configured.*", descriptionKey: "nat.servers.server", format: "address" },
  { path: "servers.live", descriptionKey: "nat.servers.live" },
  { path: "servers.live.*", descriptionKey: "nat.servers.server", format: "address" },
  {
    path: "servers.live_total",
    descriptionKey: "nat.servers.live_total",
    format: "integer",
    shortLabelKey: "nat.servers.live_total",
    zeroMeaningKey: "nat.servers.live_total",
  },
  { path: "reflection", descriptionKey: "nat.reflection" },
  { path: "reflection.v4.addr", descriptionKey: "nat.reflection.v4.addr", format: "address" },
  { path: "reflection.v4.age_secs", descriptionKey: "nat.reflection.age_secs", unit: "seconds" },
  { path: "reflection.v6.addr", descriptionKey: "nat.reflection.v6.addr", format: "address" },
  { path: "reflection.v6.age_secs", descriptionKey: "nat.reflection.age_secs", unit: "seconds" },
];

// The Events domain (`GET /v1/runtime/events/recent`,
// TELEMT_LIVE_API_DATA §18). `events.ts_epoch_secs` is the highlight alias
// described in the Upstreams note above: without it the compact row would
// print an epoch as «1 755 996 000 с» through the seconds family.
//
// The ring buffer's two numbers are keyed `buffer.*`, and the adapter nests
// them to match. On the wire they are the bare `capacity` and
// `dropped_total`, which the TLS domain ALSO uses for something else — and
// a global exact entry would describe a TLS capture bound as an event
// buffer whenever the endpoint scope is missing (ruling R9 settles the
// scoped read; this keeps the unscoped one honest too).
const EVENTS_ENTRIES: FieldCatalogEntry[] = [
  {
    path: "buffer.capacity",
    descriptionKey: "events.capacity",
    format: "integer",
    shortLabelKey: "events.capacity",
  },
  {
    path: "buffer.dropped_total",
    descriptionKey: "events.dropped_total",
    format: "integer",
    shortLabelKey: "events.dropped_total",
    zeroMeaningKey: "events.dropped_total",
  },
  { path: "events", descriptionKey: "events.events" },
  { path: "events.*.seq", descriptionKey: "events.seq", format: "identifier" },
  { path: "events.*.ts_epoch_secs", descriptionKey: "events.ts_epoch_secs", unit: "timestamp" },
  { path: "events.*.event_type", descriptionKey: "events.event_type", format: "enum" },
  { path: "events.*.context", descriptionKey: "events.context" },
  { path: "events.ts_epoch_secs", descriptionKey: "events.ts_epoch_secs", unit: "timestamp" },
];

export const DEFAULT_FIELD_CATALOG: FieldCatalog = {
  entries: [
    ...DC_ENTRIES,
    ...ME_ENTRIES,
    ...SECURITY_ENTRIES,
    ...COUNTERS_ENTRIES,
    ...UPSTREAMS_ENTRIES,
    ...CONNECTIONS_ENTRIES,
    ...NAT_ENTRIES,
    ...EVENTS_ENTRIES,
  ],
  byEndpoint: { [TLS_FINGERPRINTS_ENDPOINT]: TLS_ENTRIES },
};

// --- lookup --------------------------------------------------------------

interface CompiledCatalog {
  exact: Map<string, FieldCatalogEntry>;
  wildcard: FieldCatalogEntry[];
  endpointExact: Map<string, Map<string, FieldCatalogEntry>>;
  endpointWildcard: Map<string, FieldCatalogEntry[]>;
  cache: Map<string, FieldLookupResult>;
}

// compile splits the flat entry list into the three tables the lookup walks,
// sorting wildcards most-specific-first so the result never depends on the
// order somebody happened to type the entries in.
function compile(catalog: FieldCatalog): CompiledCatalog {
  const exact = new Map<string, FieldCatalogEntry>();
  const wildcard: FieldCatalogEntry[] = [];
  for (const entry of catalog.entries) {
    if (entry.path.includes("*")) wildcard.push(entry);
    else exact.set(entry.path, entry);
  }
  wildcard.sort((a, b) => patternSpecificity(b.path) - patternSpecificity(a.path));

  const endpointExact = new Map<string, Map<string, FieldCatalogEntry>>();
  const endpointWildcard = new Map<string, FieldCatalogEntry[]>();
  for (const [endpoint, entries] of Object.entries(catalog.byEndpoint)) {
    const ex = new Map<string, FieldCatalogEntry>();
    const wc: FieldCatalogEntry[] = [];
    for (const entry of entries) {
      if (entry.path.includes("*")) wc.push(entry);
      else ex.set(entry.path, entry);
    }
    wc.sort((a, b) => patternSpecificity(b.path) - patternSpecificity(a.path));
    endpointExact.set(endpoint, ex);
    endpointWildcard.set(endpoint, wc);
  }
  return { exact, wildcard, endpointExact, endpointWildcard, cache: new Map() };
}

// Memoization is per catalog OBJECT, not global: a test builds its own
// catalog and gets its own cache, and the default catalog is compiled once
// for the whole app. A WeakMap so a throwaway catalog is collectable.
const COMPILED = new WeakMap<FieldCatalog, CompiledCatalog>();

function compiled(catalog: FieldCatalog): CompiledCatalog {
  let c = COMPILED.get(catalog);
  if (!c) {
    c = compile(catalog);
    COMPILED.set(catalog, c);
  }
  return c;
}

/** Clears the memo for one catalog — only needed by tests that mutate one in place. */
export function resetFieldCatalogCache(catalog: FieldCatalog = DEFAULT_FIELD_CATALOG): void {
  COMPILED.delete(catalog);
}

export interface FieldLookupContext {
  /** Source/endpoint id for step 3. */
  endpoint?: string;
  catalog?: FieldCatalog;
}

export function counterFamilyFor(path: string): CounterFamily | null {
  const segments = path.split(/[.[\]]+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  for (const family of COUNTER_FAMILIES) {
    if (family.test.test(last)) return family;
  }
  return null;
}

// lookupField walks §8.2's five steps in order and reports WHICH step
// matched, so the priority is a testable fact rather than an implementation
// detail. Memoized per (endpoint, path).
export function lookupField(path: string, ctx: FieldLookupContext = {}): FieldLookupResult {
  const catalog = ctx.catalog ?? DEFAULT_FIELD_CATALOG;
  const c = compiled(catalog);
  const cacheKey = `${ctx.endpoint ?? ""}\u0000${path}`;
  const hit = c.cache.get(cacheKey);
  if (hit) return hit;

  const result = resolve(path, ctx.endpoint, c);
  c.cache.set(cacheKey, result);
  return result;
}

function resolve(path: string, endpoint: string | undefined, c: CompiledCatalog): FieldLookupResult {
  // 1. exact normalized path
  const exact = c.exact.get(path);
  if (exact) return { source: "exact", entry: exact };

  // 2. endpoint-specific path (ruling R9)
  //
  // The spec's §8.2 list reads exact -> wildcard -> endpoint-specific, which
  // would let a broad global pattern such as `writers.*.rtt_ema_ms` outrank a
  // rule written FOR one endpoint. R9 settles it the other way: most specific
  // wins, so a rule scoped to a single endpoint beats a catalog-wide
  // wildcard. Within the endpoint table, exact still beats wildcard.
  if (endpoint) {
    const ex = c.endpointExact.get(endpoint)?.get(path);
    if (ex) return { source: "endpoint", entry: ex };
    for (const entry of c.endpointWildcard.get(endpoint) ?? []) {
      if (matchesPattern(path, entry.path)) return { source: "endpoint", entry };
    }
  }

  // 3. wildcard path
  for (const entry of c.wildcard) {
    if (matchesPattern(path, entry.path)) return { source: "wildcard", entry };
  }

  // 4. known counters family
  const family = counterFamilyFor(path);
  if (family) {
    return {
      source: "family",
      family: family.id,
      entry: { path, format: family.format, unit: family.unit },
    };
  }

  // 5. neutral fallback
  return { source: "fallback", entry: null };
}

// --- resolving to the spec's FieldDefinition ----------------------------

function description(result: FieldLookupResult, s: Dict): string {
  const table = s.details.fields.descriptions as unknown as Record<string, string | undefined>;
  if (result.source === "family" && result.family) {
    const families = s.details.fields.families as unknown as Record<string, string | undefined>;
    return families[result.family] ?? s.details.fields.fallback;
  }
  const key = result.entry?.descriptionKey ?? result.entry?.path;
  if (key) {
    const text = table[key];
    if (text) return text;
  }
  return s.details.fields.fallback;
}

// describeField turns a path into the spec's §8 FieldDefinition with its
// description already in the reader's language — the shape a renderer wants.
// Resolution order is §8.2 as amended by R9: exact -> endpoint-specific ->
// wildcard -> counters family -> neutral fallback.
export function describeField(path: string, s: Dict, ctx: FieldLookupContext = {}): FieldDefinition {
  const result = lookupField(path, ctx);
  const entry = result.entry;
  const nulls = s.details.fields.nullMeanings as unknown as Record<string, string | undefined>;
  const zeros = s.details.fields.zeroMeanings as unknown as Record<string, string | undefined>;
  const shorts = s.details.fields.shortLabels as unknown as Record<string, string | undefined>;
  const nullMeaning = entry?.nullMeaningKey ? nulls[entry.nullMeaningKey] : undefined;
  const zeroMeaning = entry?.zeroMeaningKey ? zeros[entry.zeroMeaningKey] : undefined;
  const shortLabel = entry?.shortLabelKey ? shorts[entry.shortLabelKey] : undefined;
  return {
    path,
    ...(entry?.label !== undefined ? { label: entry.label } : {}),
    ...(shortLabel !== undefined ? { shortLabel } : {}),
    description: description(result, s),
    ...(entry?.format !== undefined ? { format: entry.format } : {}),
    ...(entry?.unit !== undefined ? { unit: entry.unit } : {}),
    ...(entry?.sensitive !== undefined ? { sensitive: entry.sensitive } : {}),
    ...(nullMeaning !== undefined ? { nullMeaning } : {}),
    ...(zeroMeaning !== undefined ? { zeroMeaning } : {}),
    ...(entry?.minMode !== undefined ? { minMode: entry.minMode } : {}),
  };
}

// --- coverage harness (ruling: catalog test + Telemt-bump checklist) -----

export interface CoverageRow {
  path: string;
  source: FieldLookupSource;
}

export interface CoverageReport {
  total: number;
  /** Paths resolved by step 1 or 2 — a real, hand-written description. */
  described: string[];
  /** Paths that only reached a counters family or the neutral fallback. */
  undescribed: string[];
  rows: CoverageRow[];
}

// catalogCoverage walks a whole fixture and reports which of its leaves the
// catalog actually describes. Tasks 6–8 point it at their own fixtures and
// drive `undescribed` to empty for their domain; today it is asserted on
// the DC fixture only.
//
// `pathPrefix` strips a payload-rooted prefix so the same fixture can be
// checked as the page's entity context sees it ("rtt_ms") rather than as
// the wire delivers it ("dcs[0].rtt_ms").
export function catalogCoverage(
  payload: unknown,
  ctx: FieldLookupContext & { pathPrefix?: string } = {},
): CoverageReport {
  const rows: CoverageRow[] = [];
  const seen = new Set<string>();
  for (const leaf of walkLeafPaths(payload, ctx.pathPrefix ?? "")) {
    if (seen.has(leaf.path)) continue;
    seen.add(leaf.path);
    rows.push({ path: leaf.path, source: lookupField(leaf.path, ctx).source });
  }
  const described = rows.filter((r) => r.source !== "fallback" && r.source !== "family");
  const undescribed = rows.filter((r) => r.source === "fallback" || r.source === "family");
  return {
    total: rows.length,
    described: described.map((r) => r.path),
    undescribed: undescribed.map((r) => r.path),
    rows,
  };
}
