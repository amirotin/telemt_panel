// The Пульс hub's nine preview cards, as data (06-ui.md §Информационная
// архитектура: "Пульс — хаб диагностики: карточки-превью ... каждая ведёт на
// Details-страницу").
//
// Two rules shape this module, and both are about not having a second
// source of truth:
//
//   * the numbers on a card are the SAME §6 summary tiles its Details page
//     shows, resolved through details-builder/summaryMetric.ts — a preview
//     that computed its own figures would sooner or later disagree with the
//     page one tap away;
//   * the card's state is the SAME §14 source state the page header shows,
//     resolved through details-builder/sources.ts — including ruling R5's
//     `disabled` (a switch the admin can flip) versus `unsupported` (a build
//     that predates the feature), which is what decides which Gated hint the
//     card offers.
//
// The hub deliberately curates OPERATIONAL signals rather than blindly
// repeating each detail page's first three fields. Detail pages still own
// exhaustive diagnostics; the hub answers the smaller question "is this
// path working now, and what number explains the state?".

import {
  ME_POOL_RUNTIME_HINTS,
  MINIMAL_STATS_HINTS,
  resolveGateHint,
  RUNTIME_EDGE_HINTS,
  UPSTREAM_STATS_HINTS,
  WEB_RUNTIME_HINTS,
  type GateHintKey,
  type GateHintSpec,
} from "../../caps/gateHints";
import { formatNumber, type Dict } from "../../i18n";
import type {
  DcStatus,
  RuntimeTopic,
  SecurityTopic,
  StatsSnapshot,
  UpstreamsTopic,
  UsersTopic,
  WebTopic,
} from "../../realtime/topics";
import type { TopicSnapshot } from "../../realtime/types";
import type { HistorySeries } from "../../lib/api/generated/types.gen";
import { formatDurationApprox } from "../../people/expiry";
import type { State } from "../../ui/StatePill";
import { connectionsPagePayload, usersTrafficTotal } from "../diag/connections.helpers";
import { upstreamsPagePayload } from "../diag/upstreams.helpers";
import { webPagePayload } from "../diag/web.helpers";
import { connectionsPageDefinition } from "../details-builder/definitions/connections";
import { natPageDefinition } from "../details-builder/definitions/nat";
import { upstreamsPageDefinition } from "../details-builder/definitions/upstreams";
import { WEB_ENDPOINT, webPageDefinition } from "../details-builder/definitions/web";
import type { DetailPageDefinition, SummaryMetricDefinition, SummaryTone } from "../details-builder/model";
import {
  resolveSource,
  sourceStatusShortLabel,
  type DetailSourceInput,
  type QuerySourceInput,
  type SourceStatus,
} from "../details-builder/sources";
import { resolveSummaryMetric } from "../details-builder/summaryMetric";
import { dcRttTone } from "../widgets/dc.helpers";
import { resolveGated } from "../widgets/gated";
import { connectionQuality, historyWindowDelta, windowSeries } from "../widgets/statRow.helpers";
import type { DiagDomain } from "../types";

export interface HubCardMetric {
  id: string;
  label: string;
  text: string;
  tone: SummaryTone;
}

export interface HubCardGate {
  variant: "disabled" | "unsupported";
  /** Telemt's own reason token, printed verbatim after a localized prefix. */
  reason?: string;
  hint?: GateHintKey;
}

export interface HubCard {
  domain: DiagDomain;
  title: string;
  status: SourceStatus;
  freshnessMs: number | null;
  health: State;
  healthLabel: string;
  pill: State;
  pillLabel: string;
  /** Empty while the source is loading or gated — the card says so instead. */
  metrics: HubCardMetric[];
  /** Non-null only for `disabled`/`unsupported`, i.e. exactly when GatedNote belongs on the card. */
  gate: HubCardGate | null;
}

/** Everything the hub subscribes to, handed in by the page component. */
export interface HubInputs {
  stats: TopicSnapshot<StatsSnapshot>;
  runtime: TopicSnapshot<RuntimeTopic>;
  upstreams: TopicSnapshot<UpstreamsTopic>;
  security: TopicSnapshot<SecurityTopic>;
  users: TopicSnapshot<UsersTopic>;
  web: TopicSnapshot<WebTopic>;
  /** `GET /api/telemt/zero` gates the Счётчики drill-down and supplies freshness. */
  counters: QuerySourceInput;
  history: {
    attempts?: HistorySeries;
    refusals?: HistorySeries;
  };
  nowMs: number;
}

// §14 state -> the app's four-value status vocabulary (06-ui.md: ONE status
// semantics). `empty` is muted rather than warn on purpose: a source that
// answered honestly with nothing is not a fault.
const PILL_STATE: Record<SourceStatus, State> = {
  loading: "muted",
  ready: "ok",
  stale: "warn",
  partial: "warn",
  disabled: "muted",
  unsupported: "muted",
  error: "error",
  empty: "muted",
};

function hubMetric(
  id: string,
  label: string,
  text: string,
  tone: SummaryTone = "neutral",
): HubCardMetric {
  return { id, label, text, tone };
}

function integerText(value: number, s: Dict): string {
  return formatNumber(s, value);
}

function eventTypeText(eventType: string, context: string, s: Dict): string {
  if (eventType === "admission.state") {
    return context.includes("accepting_new_connections=true")
      ? s.hub.values.admissionOpen
      : s.hub.values.admissionClosed;
  }
  if (eventType === "config.reload.applied") return s.hub.values.configReload;
  return eventType;
}

// --- DC aggregates -------------------------------------------------------

/**
 * Fleet-wide coverage: alive writers over required writers across every data
 * center, NOT the mean of the per-DC percentages — a DC that needs 40
 * writers and a media group that needs 2 must not weigh the same.
 *
 * Clamped at 100 because `required_writers` is a FLOOR (`floor_target`), so
 * an over-provisioned pool routinely runs more writers than it needs and the
 * raw ratio exceeds 1. Telemt clamps every per-DC `coverage_pct` the same way
 * (transport/middle_proxy/pool_status.rs::ratio_pct, with its own
 * `ratio_pct_is_capped_at_100` test); recomputing the aggregate here escaped
 * that clamp and put «Покрытие 102,3 %» on the hub beside DC Details tiles
 * that all read 100 %.
 */
export function dcFleetCoverage(dcs: readonly DcStatus[]): number | null {
  const required = dcs.reduce((sum, dc) => sum + dc.required_writers, 0);
  if (required <= 0) return null;
  const alive = dcs.reduce((sum, dc) => sum + dc.alive_writers, 0);
  return Math.min(100, (alive / required) * 100);
}

/** The slowest data center's RTT — the number that decides how the fleet feels. */
export function dcWorstRtt(dcs: readonly DcStatus[]): number | null {
  const known = dcs.map((dc) => dc.rtt_ms).filter((rtt): rtt is number => rtt !== null);
  return known.length === 0 ? null : Math.max(...known);
}

function dcCoverageTone(dcs: readonly DcStatus[]): SummaryTone {
  if (dcs.some((dc) => dc.alive_writers === 0)) return "bad";
  return dcs.some((dc) => dc.coverage_pct < 100) ? "warn" : "good";
}

const DC_HUB_METRICS: SummaryMetricDefinition<readonly DcStatus[]>[] = [
  {
    id: "dc_total",
    label: (s) => s.hub.metrics.dcTotal,
    value: (dcs) => dcs.length,
    format: "integer",
  },
  {
    id: "coverage",
    label: (s) => s.hub.metrics.coverage,
    value: dcFleetCoverage,
    unit: "percent",
    tone: dcCoverageTone,
  },
  {
    id: "rtt_worst",
    label: (s) => s.hub.metrics.rttWorst,
    value: dcWorstRtt,
    unit: "milliseconds",
    // A high value is highlighted locally but does not call the whole fleet
    // degraded while coverage remains intact.
    tone: (dcs) => (dcRttTone(dcWorstRtt(dcs)) === "warn" ? "warn" : "neutral"),
  },
];

// --- per-domain wiring ---------------------------------------------------

interface HubDomainSpec {
  domain: DiagDomain;
  /**
   * "как включить" follow-up for a `disabled` source (R5 picks it for
   * `unsupported`). Resolved per (endpoint, reason) — see caps/gateHints.ts.
   */
  disabledHint?: GateHintSpec;
  source: (i: HubInputs) => DetailSourceInput;
  /** Resolved only when the source actually has data — see buildHubCards. */
  metrics: (i: HubInputs, s: Dict) => HubCardMetric[];
  /** Only these metrics can promote the whole domain to attention/error. */
  healthMetricIds?: readonly string[];
  /** A partial value is informational, while a `bad` one stays actionable. */
  ignoreMetricWarnings?: boolean;
}

/**
 * `tiles` picks the preview subset of a page's own summary metrics, by id and
 * in the order the card shows them. Two or three: a card is a glance, and the
 * fourth tile is what the Details page is for.
 */
function fromTiles<TPayload, TContext>(
  definition: DetailPageDefinition<TPayload, TContext>,
  ids: readonly string[],
  context: TContext | null,
  s: Dict,
  nowMs: number,
  endpoint?: string,
): HubCardMetric[] {
  if (context === null) return [];
  const summary = definition.summary ?? [];
  return ids
    .map((id) => summary.find((metric) => metric.id === id))
    .filter((metric): metric is SummaryMetricDefinition<TContext> => metric !== undefined)
    .map((metric) =>
      resolveSummaryMetric(metric, context, s, {
        nowMs,
        ...(endpoint !== undefined ? { lookup: { endpoint } } : {}),
      }),
    );
}

function metricsOf<T>(
  metrics: readonly SummaryMetricDefinition<T>[],
  context: T | null,
  s: Dict,
  nowMs: number,
): HubCardMetric[] {
  if (context === null) return [];
  return metrics.map((metric) => resolveSummaryMetric(metric, context, s, { nowMs }));
}

// HUB_DOMAINS is the hub's single ordered list — the nine cards of
// 06-ui.md plus WEB (M4 task 8b), in the order the prototype's Пульс reads
// them; WEB goes last because it is the domain most installations do not
// run at all, and a card that reads «включите [web]» on most servers has no
// business sitting above the ones that always have data. The gates and
// payload adapters are the diag pages' own, imported rather than restated.
export const HUB_DOMAINS: readonly HubDomainSpec[] = [
  {
    domain: "dc",
    healthMetricIds: ["coverage"],
    // /v1/stats/dcs: the flag really gates it, but the ME pool being down
    // closes it too — and only one of the two is a setting to flip.
    disabledHint: MINIMAL_STATS_HINTS,
    source: ({ upstreams }) => {
      const dcs = upstreams.data?.dcs ?? null;
      return {
        kind: "topic",
        snapshot: upstreams,
        ...(dcs
          ? {
              gated: {
                enabled: dcs.middle_proxy_enabled,
                ...(dcs.reason !== undefined ? { reason: dcs.reason } : {}),
                data: dcs.dcs,
              },
            }
          : {}),
        generatedAt: dcs?.generated_at_epoch_secs ?? null,
      };
    },
    metrics: ({ upstreams, nowMs }, s) =>
      metricsOf(DC_HUB_METRICS, upstreams.data?.dcs?.dcs ?? null, s, nowMs),
  },
  {
    domain: "me",
    healthMetricIds: ["degraded"],
    // /v1/stats/me-writers — same pair of causes as the DC card.
    disabledHint: MINIMAL_STATS_HINTS,
    source: ({ upstreams }) => {
      const writers = upstreams.data?.me_writers ?? null;
      return {
        kind: "topic",
        snapshot: upstreams,
        ...(writers
          ? {
              gated: {
                enabled: writers.middle_proxy_enabled,
                ...(writers.reason !== undefined ? { reason: writers.reason } : {}),
                data: writers.writers,
              },
            }
          : {}),
        generatedAt: writers?.generated_at_epoch_secs ?? null,
      };
    },
    metrics: ({ upstreams }, s) => {
      const writers = upstreams.data?.me_writers?.writers;
      if (!writers) return [];
      const degraded = writers.filter((writer) => writer.degraded).length;
      const healthy = writers.length - degraded;
      const clients = writers.reduce((sum, writer) => sum + writer.bound_clients, 0);
      return [
        hubMetric(
          "healthy_writers",
          s.hub.cardMetrics.healthy,
          `${integerText(healthy, s)} / ${integerText(writers.length, s)}`,
          degraded > 0 ? "warn" : "good",
        ),
        hubMetric(
          "degraded",
          s.hub.cardMetrics.degraded,
          integerText(degraded, s),
          degraded > 0 ? "warn" : "good",
        ),
        hubMetric("bound_clients", s.hub.cardMetrics.clients, integerText(clients, s)),
      ];
    },
  },
  {
    domain: "security",
    healthMetricIds: ["whitelist_state"],
    source: ({ security }) => ({ kind: "topic", snapshot: security }),
    metrics: ({ security }, s) => {
      const posture = security.data?.posture;
      const whitelist = security.data?.whitelist;
      if (!posture && !whitelist) return [];
      const enabled = whitelist?.enabled ?? posture?.api_whitelist_enabled ?? false;
      const entries = whitelist?.entries_total ?? posture?.api_whitelist_entries ?? 0;
      return [
        hubMetric(
          "whitelist_state",
          s.hub.cardMetrics.access,
          enabled ? s.hub.values.restricted : s.hub.values.unrestricted,
          enabled ? "good" : "warn",
        ),
        hubMetric("whitelist_size", s.hub.cardMetrics.whitelist, integerText(entries, s)),
        hubMetric(
          "api_mode",
          s.hub.cardMetrics.apiMode,
          posture?.api_read_only ? s.hub.values.readOnly : s.hub.values.readWrite,
        ),
      ];
    },
  },
  {
    domain: "counters",
    // The detail page remains the full lifetime counter dump. The hub uses
    // the panel's monotonic history pair to answer a CURRENT 15-minute
    // question instead of alarming on old non-zero buckets.
    healthMetricIds: ["quality"],
    source: ({ counters }) => counters,
    metrics: ({ history }, s) => {
      const quality = connectionQuality(history.attempts, history.refusals);
      const attempts = historyWindowDelta(windowSeries(history.attempts));
      const refusals = historyWindowDelta(windowSeries(history.refusals));
      const qualityTone: SummaryTone = quality.percent === null
        ? "neutral"
        : quality.percent < 90
          ? "bad"
          : quality.percent < 98
            ? "warn"
            : "good";
      return [
        hubMetric(
          "quality",
          s.hub.cardMetrics.quality,
          quality.percent === null
            ? s.hub.values.collecting
            : `${formatNumber(s, Math.round(quality.percent * 10) / 10)} %`,
          qualityTone,
        ),
        hubMetric(
          "refusals_15m",
          s.hub.cardMetrics.refusals15m,
          refusals === null ? s.hub.values.collecting : integerText(refusals, s),
        ),
        hubMetric(
          "attempts_15m",
          s.hub.cardMetrics.attempts15m,
          attempts === null ? s.hub.values.collecting : integerText(attempts, s),
        ),
      ];
    },
  },
  {
    domain: "connections",
    healthMetricIds: ["admission"],
    disabledHint: RUNTIME_EDGE_HINTS,
    source: ({ stats }) => ({
      kind: "topic",
      snapshot: stats,
      gated: stats.data?.connections_summary ?? null,
    }),
    metrics: ({ stats, users, nowMs }, s) => {
      const gated = stats.data ? resolveGated(stats.data.connections_summary) : null;
      const load = fromTiles(
        connectionsPageDefinition,
        ["current_connections", "active_users"],
        connectionsPagePayload(
          stats.data?.summary,
          gated?.status === "ok" ? gated.data : null,
          usersTrafficTotal(users.data),
        ),
        s,
        nowMs,
      );
      const readiness = stats.data?.ready;
      if (!readiness) return load;
      const available = readiness.ready && readiness.admission_open;
      return [
        ...load,
        hubMetric(
          "admission",
          s.hub.cardMetrics.admission,
          !readiness.ready
            ? s.hub.values.notReady
            : readiness.admission_open
              ? s.hub.values.open
              : s.hub.values.closed,
          available ? "good" : "bad",
        ),
      ];
    },
  },
  {
    domain: "upstreams",
    healthMetricIds: ["healthy"],
    // /v1/stats/upstreams — gated by minimal_runtime_enabled, but its
    // `source_unavailable` is a lost `try_read` on the upstream manager,
    // not a switch.
    disabledHint: UPSTREAM_STATS_HINTS,
    source: ({ upstreams }) => {
      const data = upstreams.data?.upstreams ?? null;
      return {
        kind: "topic",
        snapshot: upstreams,
        ...(data
          ? {
              gated: {
                enabled: data.enabled,
                ...(data.reason !== undefined ? { reason: data.reason } : {}),
                data,
              },
            }
          : {}),
        generatedAt: data?.generated_at_epoch_secs ?? null,
      };
    },
    metrics: ({ upstreams, runtime, nowMs }, s) =>
      fromTiles(
        upstreamsPageDefinition,
        ["configured", "healthy", "latency"],
        upstreamsPagePayload(upstreams.data?.upstreams, runtime.data?.upstream_quality),
        s,
        nowMs,
      ),
  },
  {
    domain: "nat",
    // `servers.live` is a diagnostic snapshot, not a quorum: Telemt may
    // clear it on a runtime reset while continuing to use a fresh reflection
    // cache. Reflection freshness is the actionable NAT signal.
    healthMetricIds: ["reflection_age"],
    // NO config flag gates this card. `/v1/runtime/nat-stun` is registered
    // and dispatched unconditionally (07-telemt-sdk.md §57) and
    // runtime_min.rs::build_runtime_nat_stun_data takes no ApiConfig at all:
    // its one closed path is `shared.me_pool` being None, reported as
    // `source_unavailable`. Naming either runtime_edge or
    // minimal_runtime_enabled here sends an operator to a setting that
    // cannot change this payload.
    disabledHint: ME_POOL_RUNTIME_HINTS,
    source: ({ runtime }) => ({
      kind: "topic",
      snapshot: runtime,
      gated: runtime.data?.nat_stun ?? null,
    }),
    metrics: ({ runtime, nowMs }, s) => {
      const nat = runtime.data ? resolveGated(runtime.data.nat_stun) : null;
      if (nat?.status !== "ok") return [];
      const reflection = fromTiles(
        natPageDefinition,
        ["reflection_age"],
        nat.data,
        s,
        nowMs,
      );
      const v4 = Boolean(nat.data.reflection?.v4);
      const v6 = Boolean(nat.data.reflection?.v6);
      const families = v4 && v6 ? s.hub.values.ipv4And6 : v4 ? "IPv4" : v6 ? "IPv6" : s.hub.values.none;
      const attempts = nat.data.flags?.nat_probe_attempts ?? 0;
      return [
        ...reflection,
        hubMetric("reflection_families", s.hub.cardMetrics.reflection, families),
        hubMetric(
          "probe_attempts",
          s.hub.cardMetrics.retries,
          integerText(attempts, s),
          attempts > 0 ? "warn" : "good",
        ),
      ];
    },
  },
  {
    domain: "events",
    // dropped_total is ring-history eviction, not live event loss.
    healthMetricIds: [],
    disabledHint: RUNTIME_EDGE_HINTS,
    source: ({ runtime }) => ({
      kind: "topic",
      snapshot: runtime,
      gated: runtime.data?.recent_events ?? null,
    }),
    metrics: ({ runtime, nowMs }, s) => {
      const events = runtime.data ? resolveGated(runtime.data.recent_events) : null;
      if (events?.status !== "ok") return [];
      const records = events.data.events ?? [];
      const latest = records.reduce<(typeof records)[number] | null>(
        (current, event) => (!current || event.ts_epoch_secs > current.ts_epoch_secs ? event : current),
        null,
      );
      const dayAgo = nowMs / 1000 - 24 * 60 * 60;
      const count24h = records.filter((event) => event.ts_epoch_secs >= dayAgo).length;
      return [
        hubMetric(
          "last_event",
          s.hub.cardMetrics.lastEvent,
          latest
            ? formatDurationApprox(Math.max(0, nowMs - latest.ts_epoch_secs * 1000), s)
            : s.hub.values.noEvents,
        ),
        hubMetric(
          "event_type",
          s.hub.cardMetrics.event,
          latest ? eventTypeText(latest.event_type, latest.context, s) : s.hub.values.none,
        ),
        hubMetric("events_24h", s.hub.cardMetrics.events24h, integerText(count24h, s)),
      ];
    },
  },
  {
    domain: "web",
    healthMetricIds: ["lifecycle"],
    // No config FLAG gates /v1/runtime/web/*: the routes are registered
    // unconditionally on 3.5.3+ and close only because the WEB runtime is
    // not running. On an older build the hub's own R5 rule takes over and
    // offers "update Telemt" instead.
    disabledHint: WEB_RUNTIME_HINTS,
    source: ({ web }) => ({
      kind: "topic",
      snapshot: web,
      gated: web.data?.status ?? null,
    }),
    metrics: ({ web, nowMs }, s) => {
      const status = web.data ? resolveGated(web.data.status) : null;
      return fromTiles(
        webPageDefinition,
        ["lifecycle", "sessions", "streams"],
        // The card previews the STATUS half only: the sessions are a
        // fetch-on-visit request the page owns, and a hub of nine cards
        // must not pull a page of session rows to show three numbers.
        webPagePayload(status?.status === "ok" ? status.data : null, null),
        s,
        nowMs,
        WEB_ENDPOINT,
      );
    },
  },
];

// buildHubCards resolves every card in one pass. A gated or erroring source
// contributes NO metrics — the card shows the Gated hint or the state pill
// instead, never a row of dashes pretending to be a reading.
function gateHintOf(
  spec: HubDomainSpec,
  reason: string | undefined,
): { hint?: GateHintKey } {
  const hint = resolveGateHint(spec.disabledHint, reason);
  return hint !== undefined ? { hint } : {};
}

function healthLabel(health: State, s: Dict): string {
  switch (health) {
    case "ok":
      return s.hub.states.ok;
    case "warn":
      return s.hub.states.warn;
    case "error":
      return s.hub.states.error;
    default:
      return s.hub.states.muted;
  }
}

function cardHealth(
  spec: HubDomainSpec,
  status: SourceStatus,
  metrics: readonly HubCardMetric[],
): State {
  if (status === "error") return "error";
  if (status === "stale" || status === "partial") return "warn";
  if (status !== "ready") return "muted";

  const ids = spec.healthMetricIds ?? metrics.map((metric) => metric.id);
  const signals = metrics.filter((metric) => ids.includes(metric.id));
  if (signals.some((metric) => metric.tone === "bad")) return "error";
  if (!spec.ignoreMetricWarnings && signals.some((metric) => metric.tone === "warn")) return "warn";
  return "ok";
}

export function buildHubCards(inputs: HubInputs, s: Dict): HubCard[] {
  return HUB_DOMAINS.map((spec) => {
    const state = resolveSource(spec.domain, spec.source(inputs));
    const gate: HubCardGate | null =
      state.status === "disabled" || state.status === "unsupported"
        ? {
            variant: state.status,
            ...(state.reason !== undefined ? { reason: state.reason } : {}),
            // R5: an unsupported source is always the "update Telemt"
            // follow-up — never a setting the operator's binary lacks.
            ...(state.status === "unsupported"
              ? { hint: "telemt_outdated" as GateHintKey }
              : gateHintOf(spec, state.reason)),
          }
        : null;

    const metrics = gate === null && state.hasData ? spec.metrics(inputs, s) : [];
    const health = cardHealth(spec, state.status, metrics);

    return {
      domain: spec.domain,
      title: s.diag.domains[spec.domain],
      status: state.status,
      freshnessMs: state.freshnessMs,
      health,
      healthLabel: healthLabel(health, s),
      pill: PILL_STATE[state.status],
      pillLabel: sourceStatusShortLabel(state.status, s),
      metrics,
      gate,
    };
  });
}
