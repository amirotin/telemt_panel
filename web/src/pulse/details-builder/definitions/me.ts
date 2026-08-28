// The ME ("Middle End") Details page (spec §23.2), as a declarative
// definition.
//
// What it replaces: `meGroups` turned five independently gated payloads into
// thirteen KV groups and ~1 091 flat rows on one screen — the single worst
// case the whole M4 wave exists to fix (TELEMT_LIVE_API_DATA §22). §23.2
// splits the same data into five tabs, each answering one question:
//
//   Overview        how much of the pool is up at all
//   Writers         which of the 44–47 writers is unhealthy (EntityList,
//                   grouped and filtered by DC and state, §23.2)
//   Quality         RTT and drop shapes, as charts and breakdowns
//   Initialization  the sixteen startup steps as a timeline, not 141 rows
//   Runtime         the stable scalar groups plus the self-test branches
//
// FOUR sources, deliberately independent (§14): me-writers rides the
// always-on `upstreams` topic, gates/initialization the always-on half of
// `runtime`, pool/quality/self-test the runtime_edge-gated half, and the
// ~55 tuning knobs the separately gated `minimal` payload. Any of the last
// three going away degrades the page to `partial` and leaves every other tab
// working — a switched-off gate must never blank the writers list.

import type {
  MeWriterStatus,
  MeWritersSummary,
  RuntimeGates,
  RuntimeInitialization,
  RuntimeInitializationComponent,
  RuntimeMePoolState,
  RuntimeMeQuality,
  RuntimeMeQualityDcRtt,
  RuntimeMeSelftest,
  RuntimeMinimalMeRuntime,
} from "../../../realtime/topics";
import { QUALITY_CHART_RENDERER } from "../renderers/customRenderers";
import type {
  DetailPageDefinition,
  ScalarFieldBinding,
  SectionDefinition,
  SummaryTone,
} from "../model";

export interface MePagePayload {
  // --- me-writers (`upstreams` topic), spread flat --------------------
  middle_proxy_enabled?: boolean;
  reason?: string;
  generated_at_epoch_secs?: number;
  summary?: MeWritersSummary;
  writers?: MeWriterStatus[];
  // --- runtime --------------------------------------------------------
  gates?: RuntimeGates;
  initialization?: RuntimeInitialization;
  pool?: RuntimeMePoolState;
  quality?: RuntimeMeQuality;
  selftest?: RuntimeMeSelftest;
  me_runtime?: RuntimeMinimalMeRuntime;
}

export const ME_PAGE_ID = "pulse.me";

const writerOf = (item: unknown) => item as MeWriterStatus;
const componentOf = (item: unknown) => item as RuntimeInitializationComponent;

/** Stable semantic key (§5.3): Telemt's own writer id, never the index. */
export function meWriterKey(writer: Pick<MeWriterStatus, "writer_id">): string {
  return `w${writer.writer_id}`;
}

/**
 * Group id for the DC chip row. Negative DC ids are real
 * (TELEMT_LIVE_API_DATA §9), so the id is never parsed back as a number —
 * `meDcOrder` reads the writer instead.
 */
export function meDcGroupKey(dc: number | null): string {
  return dc === null ? "dc-none" : `dc${dc}`;
}

/**
 * The DC label shown on a chip, a group heading and in the Overview
 * breakdown. A writer Telemt has not mapped to a data center yet carries
 * `dc: null`, which is a state of its own (§13.1) and gets an em dash rather
 * than being silently folded into DC 0.
 */
export function meDcLabel(dc: number | null): string {
  return dc === null ? "DC —" : `DC ${dc}`;
}

// meDcGroupOrder sorts the chips the way the DC rail is sorted: production
// data centers first ascending, then the test sites by id magnitude.
export function meDcGroupOrder(a: string, b: string): number {
  const parse = (id: string) => (id === "dc-none" ? Number.POSITIVE_INFINITY : Number(id.slice(2)));
  const na = parse(a);
  const nb = parse(b);
  if (na === nb) return 0;
  if (!Number.isFinite(na)) return 1;
  if (!Number.isFinite(nb)) return -1;
  if (na >= 0 && nb >= 0) return na - nb;
  if (na < 0 && nb < 0) return nb - na;
  return na >= 0 ? -1 : 1;
}

/** The writer states Telemt documents; the filter offers exactly these. */
export const ME_WRITER_STATES = ["warm", "active", "draining"] as const;

export const ME_FILTER_STATE = "me.state";
export const ME_FILTER_DEGRADED = "me.degraded";

// writerStatusLine is the compact row's second line: Telemt's own state word
// plus the two flags that change what the writer is doing. All three are
// FIELD NAMES, printed verbatim (§11.2) — what gets translated is the
// description beside them in the surface.
export function writerStatusLine(writer: MeWriterStatus): string {
  const flags = [writer.state];
  if (writer.draining) flags.push("draining");
  if (writer.degraded) flags.push("degraded");
  return flags.join(" · ");
}

export function degradedWriters(writers: readonly MeWriterStatus[] | undefined): number | null {
  if (writers === undefined) return null;
  return writers.filter((w) => w.degraded).length;
}

export function boundClientsTotal(writers: readonly MeWriterStatus[] | undefined): number | null {
  if (writers === undefined) return null;
  return writers.reduce((sum, w) => sum + w.bound_clients, 0);
}

// rttP95 is the render's «RTT p95» tile. The nearest-rank definition on the
// writers that actually have a sample: a writer whose RTT was never measured
// is not a zero, and averaging it in would understate the tail (§13.1).
export function rttP95(writers: readonly MeWriterStatus[] | undefined): number | null {
  if (writers === undefined) return null;
  const samples = writers
    .map((w) => w.rtt_ema_ms)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  if (samples.length === 0) return null;
  const rank = Math.ceil(samples.length * 0.95);
  return samples[Math.min(samples.length, Math.max(1, rank)) - 1] ?? null;
}

/** Overview's per-DC distribution, as `{class,total}` breakdown pairs. */
export function writersByDc(
  writers: readonly MeWriterStatus[] | undefined,
): Array<{ class: string; total: number }> {
  if (writers === undefined) return [];
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const writer of writers) {
    const id = meDcGroupKey(writer.dc);
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return order
    .sort(meDcGroupOrder)
    .map((id) => ({ class: meDcLabel(idToDc(id)), total: counts.get(id) ?? 0 }));
}

function idToDc(id: string): number | null {
  return id === "dc-none" ? null : Number(id.slice(2));
}

function degradedTone(page: MePagePayload): SummaryTone {
  const degraded = degradedWriters(page.writers);
  if (degraded === null) return "neutral";
  return degraded > 0 ? "warn" : "good";
}

// --- the me_runtime knob groups (§23.2 "stable scalar/object groups") ----
//
// The ~55 tuning fields of `minimal.data.me_runtime` are a documented, typed
// set in Telemt's own API reference, so they get named groups here rather
// than a verbatim-key map: every one of them is described in the catalog,
// and a map would print the keys as if nobody knew what they meant.

const ME_RUNTIME_POOL = [
  "active_generation",
  "warm_generation",
  "pending_hardswap_generation",
  "pending_hardswap_age_secs",
  "hardswap_enabled",
  "floor_mode",
  "me_pool_drain_ttl_secs",
  "me_pool_force_close_secs",
  "me_pool_min_fresh_ratio",
  "me_bind_stale_mode",
  "me_bind_stale_ttl_secs",
];

const ME_RUNTIME_FLOOR = [
  "adaptive_floor_idle_secs",
  "adaptive_floor_min_writers_single_endpoint",
  "adaptive_floor_min_writers_multi_endpoint",
  "adaptive_floor_recover_grace_secs",
  "adaptive_floor_writers_per_core_total",
  "adaptive_floor_cpu_cores_override",
  "adaptive_floor_cpu_cores_detected",
  "adaptive_floor_cpu_cores_effective",
  "adaptive_floor_max_extra_writers_single_per_core",
  "adaptive_floor_max_extra_writers_multi_per_core",
  "adaptive_floor_max_active_writers_per_core",
  "adaptive_floor_max_warm_writers_per_core",
  "adaptive_floor_max_active_writers_global",
  "adaptive_floor_max_warm_writers_global",
  "adaptive_floor_global_cap_raw",
  "adaptive_floor_global_cap_effective",
  "adaptive_floor_target_writers_total",
  "adaptive_floor_active_cap_configured",
  "adaptive_floor_active_cap_effective",
  "adaptive_floor_warm_cap_configured",
  "adaptive_floor_warm_cap_effective",
  "adaptive_floor_active_writers_current",
  "adaptive_floor_warm_writers_current",
];

const ME_RUNTIME_KEEPALIVE = [
  "me_keepalive_enabled",
  "me_keepalive_interval_secs",
  "me_keepalive_jitter_secs",
  "me_keepalive_payload_random",
  "rpc_proxy_req_every_secs",
];

const ME_RUNTIME_RECONNECT = [
  "me_reconnect_max_concurrent_per_dc",
  "me_reconnect_backoff_base_ms",
  "me_reconnect_backoff_cap_ms",
  "me_reconnect_fast_retry_count",
];

const ME_RUNTIME_SINGLE_ENDPOINT = [
  "me_single_endpoint_shadow_writers",
  "me_single_endpoint_outage_mode_enabled",
  "me_single_endpoint_outage_disable_quarantine",
  "me_single_endpoint_outage_backoff_min_ms",
  "me_single_endpoint_outage_backoff_max_ms",
  "me_single_endpoint_shadow_rotate_every_secs",
];

const ME_RUNTIME_PICKER = [
  "me_deterministic_writer_sort",
  "me_writer_pick_mode",
  "me_writer_pick_sample_size",
  "me_socks_kdf_policy",
];

/** Every me_runtime knob this page places, in section order — pinned by the test. */
export const ME_RUNTIME_FIELDS = [
  ...ME_RUNTIME_POOL,
  ...ME_RUNTIME_FLOOR,
  ...ME_RUNTIME_KEEPALIVE,
  ...ME_RUNTIME_RECONNECT,
  ...ME_RUNTIME_SINGLE_ENDPOINT,
  ...ME_RUNTIME_PICKER,
  "quarantined_endpoints_total",
];

function fields(prefix: string, names: readonly string[]): ScalarFieldBinding<MePagePayload>[] {
  return names.map((name) => ({ path: `${prefix}.${name}` }));
}

function runtimeKnobs(
  id: string,
  title: (s: import("../../../i18n").Dict) => string,
  names: readonly string[],
): SectionDefinition<MePagePayload> {
  return {
    kind: "scalars",
    id,
    title,
    sourceId: "minimal",
    defaultExpanded: false,
    fields: fields("me_runtime", names),
  };
}

export const mePageDefinition: DetailPageDefinition<MePagePayload, MePagePayload> = {
  id: ME_PAGE_ID,
  title: (s) => s.details.pages.me.title,
  description: (s) => s.details.pages.me.description,

  sources: [
    { id: "upstreams", topic: "upstreams", required: true, freshnessPath: "generated_at_epoch_secs" },
    // Gates and initialization are never gated — they describe the process
    // itself, and Telemt reports them even while ME is still starting.
    { id: "runtime", topic: "runtime", required: false },
    // Pool state, quality and self-test all sit behind runtime_edge, so they
    // fail together and are one source rather than three.
    { id: "runtime_edge", topic: "runtime", required: false },
    { id: "minimal", topic: "runtime", required: false },
  ],

  freshness: {
    atEpochMs: (p) =>
      p.generated_at_epoch_secs === undefined ? null : p.generated_at_epoch_secs * 1000,
  },

  // Four tiles, as in `up-me-desktop.png`. Explicit labels rather than
  // catalog short labels: three of the four are COMPUTED over the writers
  // array (a count, a sum, a percentile) and name no single Telemt field.
  summary: [
    {
      id: "writers",
      label: (s) => s.details.pages.me.writersTile,
      value: (p) => p.writers?.length ?? null,
      format: "integer",
    },
    {
      id: "degraded",
      label: (s) => s.details.pages.me.degradedTile,
      value: (p) => degradedWriters(p.writers),
      format: "integer",
      tone: degradedTone,
      // §18.2: the tile aims the filter the Writers tab already offers as a
      // chip — never a state its own control could not reach.
      shortcut: { filter: { key: ME_FILTER_DEGRADED, value: true } },
    },
    {
      id: "bound_clients",
      label: (s) => s.details.pages.me.boundClientsTile,
      value: (p) => boundClientsTotal(p.writers),
      format: "integer",
    },
    {
      id: "rtt_p95",
      label: (s) => s.details.pages.me.rttTile,
      value: (p) => rttP95(p.writers),
      unit: "milliseconds",
    },
  ],

  navigation: {
    tabs: [
      {
        id: "overview",
        label: (s) => s.details.pages.me.tabs.overview,
        sections: ["coverage", "distribution", "metadata"],
      },
      { id: "writers", label: (s) => s.details.pages.me.tabs.writers, sections: ["writers"] },
      {
        id: "quality",
        label: (s) => s.details.pages.me.tabs.quality,
        sections: [
          "dc_rtt_chart",
          "dc_rtt",
          "quality_counters",
          "route_drops",
          "family_states",
          "drain_gate",
        ],
      },
      {
        id: "initialization",
        label: (s) => s.details.pages.me.tabs.initialization,
        sections: ["initialization", "initialization_me", "initialization_components"],
      },
      {
        id: "runtime",
        label: (s) => s.details.pages.me.tabs.runtime,
        sections: [
          "gates",
          "pool_generations",
          "pool_draining",
          "pool_hardswap",
          "pool_writers",
          "pool_refill",
          "pool_refill_by_dc",
          "selftest_kdf",
          "selftest_timeskew",
          "selftest_ip",
          "selftest_pid",
          "selftest_bnd",
          "selftest_upstreams",
          "me_runtime_pool",
          "me_runtime_floor",
          "me_runtime_keepalive",
          "me_runtime_reconnect",
          "me_runtime_single_endpoint",
          "me_runtime_picker",
          "me_runtime_quarantine",
          "quarantined_endpoints",
          // The §24 tail belongs to a tab too — every other tab lists its
          // sections, so without this it would be resolved and never drawn.
          "unknown-fields",
        ],
      },
    ],
  },

  sections: [
    // --- Overview -------------------------------------------------------
    {
      kind: "scalars",
      id: "coverage",
      title: (s) => s.details.pages.me.coverage,
      sourceId: "upstreams",
      defaultExpanded: true,
      fields: fields("summary", [
        "configured_dc_groups",
        "configured_endpoints",
        "available_endpoints",
        "available_pct",
        "required_writers",
        "alive_writers",
        "coverage_pct",
        "fresh_alive_writers",
        "fresh_coverage_pct",
      ]),
    },
    // The render's «Writer distribution»: one row per data center, with the
    // share bar answering "how much of the pool is here" (§9.4). It is bound
    // to `writers` and computed, so the same array feeds both this and the
    // Writers tab without either owning it exclusively.
    {
      kind: "breakdown",
      id: "distribution",
      title: (s) => s.details.pages.me.distribution,
      description: (s) => s.details.pages.me.distributionDescription,
      sourceId: "upstreams",
      path: "writers",
      defaultExpanded: true,
      select: (p) => writersByDc(p.writers),
    },
    {
      kind: "scalars",
      id: "metadata",
      title: (s) => s.details.pages.me.metadata,
      sourceId: "upstreams",
      fields: [
        { path: "middle_proxy_enabled" },
        { path: "reason" },
        { path: "generated_at_epoch_secs" },
      ],
    },

    // --- Writers --------------------------------------------------------
    {
      kind: "entityList",
      id: "writers",
      // Telemt's own field name for the collection (§11.2); the sentence
      // under it is what gets translated.
      title: () => "writers[]",
      description: (s) => s.details.pages.me.writersDescription,
      sourceId: "upstreams",
      path: "writers",
      defaultExpanded: true,
      itemKey: (item) => meWriterKey(writerOf(item)),
      identity: (item) => `writer #${writerOf(item).writer_id}`,
      status: (item) => writerStatusLine(writerOf(item)),
      highlights: ["bound_clients", "rtt_ema_ms"],
      groupBy: {
        key: (item) => meDcGroupKey(writerOf(item).dc),
        label: (id) => meDcLabel(id === "dc-none" ? null : Number(id.slice(2))),
        compare: meDcGroupOrder,
      },
      // §18.2 allows a control only for domain-relevant states: which
      // writers are unhealthy, and which are on their way out.
      filters: [
        {
          key: ME_FILTER_STATE,
          label: (s) => s.details.pages.me.filterState,
          options: ME_WRITER_STATES.map((state) => ({ value: state, label: () => state })),
          predicate: (item, value) => writerOf(item).state === value,
        },
        {
          key: ME_FILTER_DEGRADED,
          label: (s) => s.details.pages.me.filterDegraded,
          predicate: (item) => writerOf(item).degraded,
        },
        {
          key: "me.draining",
          label: (s) => s.details.pages.me.filterDraining,
          predicate: (item) => writerOf(item).draining,
        },
      ],
    },

    // --- Quality --------------------------------------------------------
    //
    // §9.8's one domain visual: twelve per-DC round trips read as a shape.
    // It consumes NOTHING — the array below owns every leaf, so the chart
    // cannot claim the four fields it does not draw (§27.4).
    {
      kind: "custom",
      id: "dc_rtt_chart",
      title: (s) => s.details.pages.me.dcRttChart,
      sourceId: "runtime_edge",
      renderer: QUALITY_CHART_RENDERER,
      consumes: [],
      defaultExpanded: true,
      select: (p) =>
        (p.quality?.dc_rtt ?? []).map((row: RuntimeMeQualityDcRtt) => ({
          label: meDcLabel(row.dc),
          value: row.rtt_ema_ms,
        })),
    },
    {
      kind: "array",
      id: "dc_rtt",
      title: (s) => s.details.pages.me.dcRtt,
      sourceId: "runtime_edge",
      path: "quality.dc_rtt",
      itemKey: (item, i) => `dc${(item as RuntimeMeQualityDcRtt).dc ?? i}`,
    },
    // Six named lifecycle counters with a real description each — a scalar
    // block, not a breakdown: reconnect attempts and idle closes are not
    // shares of one total, and drawing them as such would invent a
    // relationship Telemt does not report.
    {
      kind: "scalars",
      id: "quality_counters",
      title: (s) => s.details.pages.me.qualityCounters,
      sourceId: "runtime_edge",
      defaultExpanded: true,
      fields: fields("quality.counters", [
        "idle_close_by_peer_total",
        "reader_eof_total",
        "kdf_drift_total",
        "kdf_port_only_drift_total",
        "reconnect_attempt_total",
        "reconnect_success_total",
      ]),
    },
    // Route drops ARE a breakdown: five mutually exclusive reasons one
    // packet can be dropped for, so the share of each is the question.
    {
      kind: "breakdown",
      id: "route_drops",
      title: (s) => s.details.pages.me.routeDrops,
      sourceId: "runtime_edge",
      path: "quality.route_drops",
      defaultExpanded: true,
    },
    {
      kind: "array",
      id: "family_states",
      title: (s) => s.details.pages.me.familyStates,
      sourceId: "runtime_edge",
      path: "quality.family_states",
      itemKey: (item, i) => (item as { family?: string }).family ?? String(i),
    },
    {
      kind: "scalars",
      id: "drain_gate",
      title: (s) => s.details.pages.me.drainGate,
      sourceId: "runtime_edge",
      fields: fields("quality.drain_gate", [
        "route_quorum_ok",
        "redundancy_ok",
        "block_reason",
        "updated_at_epoch_secs",
      ]),
    },

    // --- Initialization -------------------------------------------------
    {
      kind: "scalars",
      id: "initialization",
      title: (s) => s.details.pages.me.init,
      sourceId: "runtime",
      defaultExpanded: true,
      fields: fields("initialization", [
        "status",
        "degraded",
        "current_stage",
        "progress_pct",
        "started_at_epoch_secs",
        "ready_at_epoch_secs",
        "total_elapsed_ms",
        "transport_mode",
      ]),
    },
    {
      kind: "scalars",
      id: "initialization_me",
      title: (s) => s.details.pages.me.initMe,
      sourceId: "runtime",
      fields: fields("initialization.me", [
        "status",
        "current_stage",
        "progress_pct",
        "init_attempt",
        "retry_limit",
        "last_error",
      ]),
    },
    // §23.2: sixteen components as a STEPPER, not 141 independent rows.
    {
      kind: "timeline",
      id: "initialization_components",
      title: (s) => s.details.pages.me.initComponents,
      sourceId: "runtime",
      path: "initialization.components",
      defaultExpanded: true,
      itemKey: (item) => componentOf(item).id,
      status: (item) => componentOf(item).status,
      step: (item) => componentOf(item).title,
      details: (item) => componentOf(item).details ?? null,
      durationMs: (item) => componentOf(item).duration_ms ?? null,
      atEpochMs: (item) => componentOf(item).started_at_epoch_ms ?? null,
    },

    // --- Runtime + self-test --------------------------------------------
    {
      kind: "scalars",
      id: "gates",
      title: (s) => s.details.pages.me.gates,
      sourceId: "runtime",
      defaultExpanded: true,
      fields: fields("gates", [
        "accepting_new_connections",
        "me_runtime_ready",
        "use_middle_proxy",
        "route_mode",
        "conditional_cast_enabled",
        "me2dc_fallback_enabled",
        "me2dc_fast_enabled",
        "reroute_active",
        "reroute_to_direct_at_epoch_secs",
        "reroute_reason",
        "startup_status",
        "startup_stage",
        "startup_progress_pct",
      ]),
    },
    {
      kind: "scalars",
      id: "pool_generations",
      title: (s) => s.details.pages.me.poolGenerations,
      sourceId: "runtime_edge",
      fields: fields("pool.generations", [
        "active_generation",
        "warm_generation",
        "pending_hardswap_generation",
        "pending_hardswap_age_secs",
      ]),
    },
    {
      kind: "array",
      id: "pool_draining",
      title: (s) => s.details.pages.me.poolDraining,
      sourceId: "runtime_edge",
      path: "pool.generations.draining_generations",
    },
    {
      kind: "scalars",
      id: "pool_hardswap",
      title: (s) => s.details.pages.me.poolHardswap,
      sourceId: "runtime_edge",
      fields: fields("pool.hardswap", ["enabled", "pending"]),
    },
    {
      kind: "scalars",
      id: "pool_writers",
      title: (s) => s.details.pages.me.poolWriters,
      sourceId: "runtime_edge",
      fields: fields("pool.writers", [
        "total",
        "alive_non_draining",
        "draining",
        "degraded",
        "contour.warm",
        "contour.active",
        "contour.draining",
        "health.healthy",
        "health.degraded",
        "health.draining",
      ]),
    },
    {
      kind: "scalars",
      id: "pool_refill",
      title: (s) => s.details.pages.me.poolRefill,
      sourceId: "runtime_edge",
      fields: fields("pool.refill", ["inflight_endpoints_total", "inflight_dc_total"]),
    },
    {
      kind: "array",
      id: "pool_refill_by_dc",
      title: (s) => s.details.pages.me.poolRefillByDc,
      sourceId: "runtime_edge",
      path: "pool.refill.by_dc",
    },
    {
      kind: "scalars",
      id: "selftest_kdf",
      title: (s) => s.details.pages.me.selftestKdf,
      sourceId: "runtime_edge",
      fields: fields("selftest.kdf", [
        "state",
        "ewma_errors_per_min",
        "threshold_errors_per_min",
        "errors_total",
      ]),
    },
    {
      kind: "scalars",
      id: "selftest_timeskew",
      title: (s) => s.details.pages.me.selftestTimeskew,
      sourceId: "runtime_edge",
      fields: fields("selftest.timeskew", [
        "state",
        "max_skew_secs_15m",
        "samples_15m",
        "last_skew_secs",
        "last_source",
        "last_seen_age_secs",
      ]),
    },
    // Both nullable branches (§16): `selftest.ip` arrives as `{}` when
    // neither family was probed, and that empty object is a LEAF of its own
    // — `alsoConsumes` is what keeps it out of the unknown tail without
    // pretending a value was rendered.
    {
      kind: "scalars",
      id: "selftest_ip",
      title: (s) => s.details.pages.me.selftestIp,
      sourceId: "runtime_edge",
      alsoConsumes: ["selftest.ip"],
      fields: fields("selftest.ip", ["v4.addr", "v4.state", "v6.addr", "v6.state"]),
    },
    {
      kind: "scalars",
      id: "selftest_pid",
      title: (s) => s.details.pages.me.selftestPid,
      sourceId: "runtime_edge",
      fields: fields("selftest.pid", ["pid", "state"]),
    },
    // `bnd` is nullable at the BLOCK level — the live snapshot had it null
    // while every other self-test branch reported. Same treatment: the null
    // itself is a leaf this section owns.
    {
      kind: "scalars",
      id: "selftest_bnd",
      title: (s) => s.details.pages.me.selftestBnd,
      sourceId: "runtime_edge",
      alsoConsumes: ["selftest.bnd"],
      fields: fields("selftest.bnd", [
        "addr_state",
        "port_state",
        "last_addr",
        "last_seen_age_secs",
      ]),
    },
    {
      kind: "array",
      id: "selftest_upstreams",
      title: (s) => s.details.pages.me.selftestUpstreams,
      sourceId: "runtime_edge",
      path: "selftest.upstreams",
      itemKey: (item, i) => String((item as { upstream_id?: number }).upstream_id ?? i),
    },
    runtimeKnobs("me_runtime_pool", (s) => s.details.pages.me.runtimePool, ME_RUNTIME_POOL),
    runtimeKnobs("me_runtime_floor", (s) => s.details.pages.me.runtimeFloor, ME_RUNTIME_FLOOR),
    runtimeKnobs(
      "me_runtime_keepalive",
      (s) => s.details.pages.me.runtimeKeepalive,
      ME_RUNTIME_KEEPALIVE,
    ),
    runtimeKnobs(
      "me_runtime_reconnect",
      (s) => s.details.pages.me.runtimeReconnect,
      ME_RUNTIME_RECONNECT,
    ),
    runtimeKnobs(
      "me_runtime_single_endpoint",
      (s) => s.details.pages.me.runtimeSingleEndpoint,
      ME_RUNTIME_SINGLE_ENDPOINT,
    ),
    runtimeKnobs("me_runtime_picker", (s) => s.details.pages.me.runtimePicker, ME_RUNTIME_PICKER),
    runtimeKnobs("me_runtime_quarantine", (s) => s.details.pages.me.runtimeQuarantine, [
      "quarantined_endpoints_total",
    ]),
    {
      kind: "array",
      id: "quarantined_endpoints",
      title: (s) => s.details.pages.me.quarantinedEndpoints,
      sourceId: "minimal",
      path: "me_runtime.quarantined_endpoints",
      itemKey: (item, i) => String((item as { endpoint?: string }).endpoint ?? i),
    },
  ],

  unknownFields: { minMode: "extended", rawJson: true },
};
