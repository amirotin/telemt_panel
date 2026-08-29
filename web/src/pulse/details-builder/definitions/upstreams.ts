// The Upstreams Details page (spec §23.5), as a declarative definition.
//
// What it replaces: `upstreamsGroups` + `flattenToRows` rendered the SAME
// upstream twice — once as «Апстримы #0» from `GET /v1/stats/upstreams` and
// again as «Качество апстрима #0» from `GET /v1/runtime/upstream-quality`,
// with the nested `dc[]` flattened into rows under both. §7 of
// TELEMT_LIVE_API_DATA says why that is wrong: the two endpoints describe
// one entity, and «Stats и Quality данные логично объединять по
// `upstream_id`». §23.5 turns the result into ONE EntityListSection whose
// nested `dc[]` keeps a block of its own (§10.4).
//
// The context is nested on purpose. Both halves carry `enabled`, `reason`
// and `generated_at_epoch_secs`, and the field catalog's exact step (§8.2)
// is GLOBAL: the bare spellings already belong to the DC domain, where they
// mean something else. Naming the two response envelopes `stats` and
// `upstream_quality` — the hub's own field names for them — is what lets
// each keep its own sentence instead of borrowing the DC page's.

import type {
  RuntimeUpstreamQualityPolicy,
  UpstreamStatus,
  UpstreamSummary,
  ZeroUpstream,
} from "../../../realtime/topics";
import type { DetailPageDefinition, SummaryTone } from "../model";

/** The response envelope both upstream endpoints share (§7). */
export interface UpstreamsResponseMeta {
  enabled: boolean;
  reason?: string;
  generated_at_epoch_secs: number;
}

export interface UpstreamQualityMeta extends UpstreamsResponseMeta {
  policy: RuntimeUpstreamQualityPolicy;
}

export interface UpstreamsPagePayload {
  /** One row per configured upstream, merged across the two endpoints. */
  upstreams?: UpstreamStatus[];
  /** Route totals; the stats copy, or quality's when stats is absent. */
  summary?: UpstreamSummary;
  /**
   * The sixteen connect counters of `GET /v1/stats/upstreams`. Partial
   * because the quality endpoint carries the first FOUR of them under its
   * own name, and that copy is what a build with no stats half falls back
   * to (see the adapter) — the remaining twelve then read «не пришло в
   * ответе» rather than silently reading zero.
   */
  zero?: Partial<ZeroUpstream>;
  stats?: UpstreamsResponseMeta;
  upstream_quality?: UpstreamQualityMeta;
}

export const UPSTREAMS_PAGE_ID = "pulse.upstreams";

const upstreamOf = (item: unknown) => item as UpstreamStatus;

/** Stable semantic key (§5.3): Telemt's own upstream id, never the index. */
export function upstreamKey(upstream: Pick<UpstreamStatus, "upstream_id">): string {
  return `u${upstream.upstream_id}`;
}

// upstreamStatusLine is the compact row's second line: Telemt's own words
// for what this upstream IS and whether it is usable. All three are field
// values printed verbatim (§11.2) — what gets translated is the description
// beside them in the surface.
export function upstreamStatusLine(upstream: UpstreamStatus): string {
  return [upstream.route_kind, upstream.address, upstream.healthy ? "healthy" : "unhealthy"].join(
    " · ",
  );
}

export function unhealthyUpstreams(
  upstreams: readonly UpstreamStatus[] | undefined,
): number | null {
  if (upstreams === undefined) return null;
  return upstreams.filter((u) => !u.healthy).length;
}

/**
 * The best round trip any upstream currently reports. `effective_latency_ms`
 * is nullable — Telemt has not measured that route yet — and a page with no
 * measurement at all shows «—» rather than a confident 0 (§13.1).
 */
export function bestLatencyMs(upstreams: readonly UpstreamStatus[] | undefined): number | null {
  const measured = (upstreams ?? [])
    .map((u) => u.effective_latency_ms)
    .filter((ms): ms is number => ms !== null && ms !== undefined);
  return measured.length === 0 ? null : Math.min(...measured);
}

/**
 * The share of connect attempts that succeeded, as a percentage. Null until
 * the proxy has attempted one: a rate over zero attempts is not 100 %, it is
 * unknown.
 */
export function connectSuccessPct(zero: Partial<ZeroUpstream> | undefined): number | null {
  const attempts = zero?.connect_attempt_total;
  const successes = zero?.connect_success_total;
  if (attempts === undefined || successes === undefined || attempts === 0) return null;
  return (successes / attempts) * 100;
}

function successTone(payload: UpstreamsPagePayload): SummaryTone {
  const pct = connectSuccessPct(payload.zero);
  if (pct === null) return "neutral";
  if (pct < 90) return "bad";
  if (pct < 99) return "warn";
  return "good";
}

function healthTone(payload: UpstreamsPagePayload): SummaryTone {
  const unhealthy = unhealthyUpstreams(payload.upstreams);
  if (unhealthy === null) return "neutral";
  if (unhealthy === 0) return "good";
  return (payload.summary?.healthy_total ?? 0) === 0 ? "bad" : "warn";
}

/** §18.2's one domain-relevant state for this page: a route that is down. */
export const UPSTREAMS_FILTER_UNHEALTHY = "upstreams.unhealthy";

const ZERO_TOTALS = [
  "connect_attempt_total",
  "connect_success_total",
  "connect_fail_total",
  "connect_failfast_hard_error_total",
];

const ZERO_ATTEMPT_BUCKETS = [
  "connect_attempts_bucket_1",
  "connect_attempts_bucket_2",
  "connect_attempts_bucket_3_4",
  "connect_attempts_bucket_gt_4",
];

const ZERO_DURATION_SUCCESS = [
  "connect_duration_success_bucket_le_100ms",
  "connect_duration_success_bucket_101_500ms",
  "connect_duration_success_bucket_501_1000ms",
  "connect_duration_success_bucket_gt_1000ms",
];

const ZERO_DURATION_FAIL = [
  "connect_duration_fail_bucket_le_100ms",
  "connect_duration_fail_bucket_101_500ms",
  "connect_duration_fail_bucket_501_1000ms",
  "connect_duration_fail_bucket_gt_1000ms",
];

/** Every `zero` counter this page places, in section order — pinned by the test. */
export const UPSTREAMS_ZERO_FIELDS = [
  ...ZERO_TOTALS,
  ...ZERO_ATTEMPT_BUCKETS,
  ...ZERO_DURATION_SUCCESS,
  ...ZERO_DURATION_FAIL,
];

function zeroFields(names: readonly string[]) {
  return names.map((name) => ({ path: `zero.${name}` }));
}

export const upstreamsPageDefinition: DetailPageDefinition<
  UpstreamsPagePayload,
  UpstreamsPagePayload
> = {
  id: UPSTREAMS_PAGE_ID,
  title: (s) => s.details.pages.upstreams.title,
  description: (s) => s.details.pages.upstreams.description,

  sources: [
    {
      id: "upstreams",
      topic: "upstreams",
      required: true,
      freshnessPath: "stats.generated_at_epoch_secs",
    },
    // upstream-quality rides the separately gated `minimal` runtime payload.
    // Optional on purpose: with that gate off the page is `partial`, the
    // policy block says so and everything else keeps working (§14).
    { id: "quality", topic: "runtime", required: false },
  ],

  freshness: { atEpochMs: (p) => (p.stats?.generated_at_epoch_secs ?? 0) * 1000 || null },

  summary: [
    { id: "configured", path: "summary.configured_total", value: (p) => p.summary?.configured_total ?? null, format: "integer" },
    {
      id: "healthy",
      path: "summary.healthy_total",
      value: (p) => p.summary?.healthy_total ?? null,
      format: "integer",
      tone: healthTone,
      // §18.2: the tile aims the SAME filter the chip under the list
      // toggles — it can never reach a state the ordinary control cannot.
      shortcut: { filter: { key: UPSTREAMS_FILTER_UNHEALTHY, value: true } },
    },
    {
      id: "connect_success",
      label: (s) => s.details.pages.upstreams.successTile,
      value: (p) => connectSuccessPct(p.zero),
      unit: "percent",
      tone: successTone,
    },
    {
      id: "latency",
      label: (s) => s.details.pages.upstreams.latencyTile,
      value: (p) => bestLatencyMs(p.upstreams),
      unit: "milliseconds",
    },
  ],

  sections: [
    // §23.5: ONE list of upstreams. The nested `dc[]` is not comma-joined
    // and not «N items»: the surface renders it through the same NodeList
    // the unknown tail uses, which gives an array its own child block
    // (§10.4) — asserted by upstreams.test.ts rather than assumed.
    {
      kind: "entityList",
      id: "upstreams",
      // Telemt's own field name for the collection (§11.2).
      title: () => "upstreams[]",
      description: (s) => s.details.pages.upstreams.upstreamsDescription,
      sourceId: "upstreams",
      path: "upstreams",
      defaultExpanded: true,
      itemKey: (item) => upstreamKey(upstreamOf(item)),
      identity: (item) => `upstream #${upstreamOf(item).upstream_id}`,
      status: (item) => upstreamStatusLine(upstreamOf(item)),
      highlights: ["effective_latency_ms", "fails"],
      filters: [
        {
          key: UPSTREAMS_FILTER_UNHEALTHY,
          label: (s) => s.details.pages.upstreams.filterUnhealthy,
          predicate: (item) => !upstreamOf(item).healthy,
        },
      ],
    },
    {
      kind: "scalars",
      id: "routes",
      title: (s) => s.details.pages.upstreams.routes,
      sourceId: "upstreams",
      defaultExpanded: true,
      fields: [
        { path: "summary.configured_total" },
        { path: "summary.healthy_total" },
        { path: "summary.unhealthy_total" },
        { path: "summary.direct_total" },
        { path: "summary.socks4_total" },
        { path: "summary.socks5_total" },
        { path: "summary.shadowsocks_total" },
      ],
    },
    {
      kind: "scalars",
      id: "connect_totals",
      title: (s) => s.details.pages.upstreams.connectTotals,
      sourceId: "upstreams",
      defaultExpanded: true,
      fields: zeroFields(ZERO_TOTALS),
    },
    // The three bucket families are histograms Telemt reports as four flat
    // counters each. They stay scalar rows — a share bar would claim they
    // are parts of one total, and the fail buckets are parts of a different
    // total than the success ones.
    {
      kind: "scalars",
      id: "connect_attempts",
      title: (s) => s.details.pages.upstreams.connectAttempts,
      sourceId: "upstreams",
      fields: zeroFields(ZERO_ATTEMPT_BUCKETS),
    },
    {
      kind: "scalars",
      id: "connect_duration_success",
      title: (s) => s.details.pages.upstreams.connectDurationSuccess,
      sourceId: "upstreams",
      fields: zeroFields(ZERO_DURATION_SUCCESS),
    },
    {
      kind: "scalars",
      id: "connect_duration_fail",
      title: (s) => s.details.pages.upstreams.connectDurationFail,
      sourceId: "upstreams",
      fields: zeroFields(ZERO_DURATION_FAIL),
    },
    {
      kind: "scalars",
      id: "policy",
      title: (s) => s.details.pages.upstreams.policy,
      sourceId: "quality",
      fields: [
        { path: "upstream_quality.policy.connect_retry_attempts" },
        { path: "upstream_quality.policy.connect_retry_backoff_ms" },
        { path: "upstream_quality.policy.connect_budget_ms" },
        { path: "upstream_quality.policy.unhealthy_fail_threshold" },
        { path: "upstream_quality.policy.connect_failfast_hard_errors" },
      ],
    },
    // Two envelopes, two sections, because they are two SOURCES: the route
    // list rides the `upstreams` topic and the quality payload rides
    // `runtime`. Under one `sourceId` the three quality rows said «не пришло
    // в ответе» under a header claiming a healthy source whenever `runtime`
    // was still loading — the section state has to name the source it
    // actually describes.
    {
      kind: "scalars",
      id: "metadata",
      title: (s) => s.details.pages.upstreams.metadata,
      sourceId: "upstreams",
      fields: [
        { path: "stats.enabled" },
        { path: "stats.reason" },
        { path: "stats.generated_at_epoch_secs" },
      ],
    },
    {
      kind: "scalars",
      id: "metadata_quality",
      title: (s) => s.details.pages.upstreams.metadataQuality,
      sourceId: "quality",
      fields: [
        { path: "upstream_quality.enabled" },
        { path: "upstream_quality.reason" },
        { path: "upstream_quality.generated_at_epoch_secs" },
      ],
    },
  ],

  unknownFields: { minMode: "extended", rawJson: true },
};
