// The Пульс hub's eight preview cards, as data (06-ui.md §Информационная
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
// Only two domains cannot reuse their page's tiles as-is. DC's tiles
// describe ONE selected data center, so the card carries three aggregates
// over all of them instead; Security's describe the TLS capture report,
// which is a ~120 KB fetch-on-visit payload (M4 task 1) that a hub of eight
// cards must not pull — the card previews the always-on posture half of the
// `security` topic and leaves the aggregates to the page.

import {
  ME_POOL_RUNTIME_HINTS,
  MINIMAL_STATS_HINTS,
  resolveGateHint,
  RUNTIME_EDGE_HINTS,
  UPSTREAM_STATS_HINTS,
  type GateHintKey,
  type GateHintSpec,
} from "../../caps/gateHints";
import type { Dict } from "../../i18n";
import type {
  DcStatus,
  RuntimeTopic,
  SecurityTopic,
  StatsSnapshot,
  UpstreamsTopic,
  UsersTopic,
} from "../../realtime/topics";
import type { TopicSnapshot } from "../../realtime/types";
import type { ZeroAllData } from "../../lib/api/generated/types.gen";
import type { State } from "../../ui/StatePill";
import { connectionsPagePayload, usersTrafficTotal } from "../diag/connections.helpers";
import { eventsPagePayload } from "../diag/events.helpers";
import { mePagePayload } from "../diag/me.helpers";
import { securityPageData } from "../diag/security.helpers";
import { upstreamsPagePayload } from "../diag/upstreams.helpers";
import { connectionsPageDefinition } from "../details-builder/definitions/connections";
import { countersPageDefinition } from "../details-builder/definitions/counters";
import { eventsPageDefinition } from "../details-builder/definitions/events";
import { mePageDefinition } from "../details-builder/definitions/me";
import { natPageDefinition } from "../details-builder/definitions/nat";
import { upstreamsPageDefinition } from "../details-builder/definitions/upstreams";
import type { SecurityPageData } from "../details-builder/definitions/security";
import type { DetailPageDefinition, SummaryMetricDefinition, SummaryTone } from "../details-builder/model";
import {
  resolveSource,
  sourceStatusShortLabel,
  type DetailSourceInput,
  type QuerySourceInput,
  type SourceStatus,
} from "../details-builder/sources";
import { resolveSummaryMetric } from "../details-builder/summaryMetric";
import { resolveGated } from "../widgets/gated";
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
  /** `GET /api/telemt/zero`, the Счётчики card's only source. */
  counters: QuerySourceInput;
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

// --- DC aggregates -------------------------------------------------------

/**
 * Fleet-wide coverage: alive writers over required writers across every data
 * center, NOT the mean of the per-DC percentages — a DC that needs 40
 * writers and a test site that needs 2 must not weigh the same.
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
  },
];

// --- Security posture ----------------------------------------------------

const SECURITY_HUB_METRICS: SummaryMetricDefinition<SecurityPageData>[] = [
  {
    id: "whitelist_size",
    label: (s) => s.details.pages.security.whitelistSize,
    // The whitelist snapshot is the authoritative count; posture's own
    // figure is the fallback for a poll where only posture came back.
    value: (p) => p.whitelist?.entries_total ?? p.posture?.api_whitelist_entries ?? null,
    format: "integer",
  },
  {
    id: "log_level",
    label: (s) => s.hub.metrics.logLevel,
    value: (p) => p.posture?.log_level ?? null,
    format: "enum",
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

// HUB_DOMAINS is the hub's single ordered list — the eight cards of
// 06-ui.md, in the order the prototype's Пульс reads them. The gates and
// payload adapters are the diag pages' own, imported rather than restated.
export const HUB_DOMAINS: readonly HubDomainSpec[] = [
  {
    domain: "dc",
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
    metrics: ({ upstreams, nowMs }, s) =>
      fromTiles(
        mePageDefinition,
        ["writers", "degraded", "bound_clients"],
        mePagePayload({ meWriters: upstreams.data?.me_writers ?? null }),
        s,
        nowMs,
      ),
  },
  {
    domain: "security",
    source: ({ security }) => ({ kind: "topic", snapshot: security }),
    metrics: ({ security, nowMs }, s) =>
      metricsOf(SECURITY_HUB_METRICS, securityPageData(security.data, undefined), s, nowMs),
  },
  {
    domain: "counters",
    source: ({ counters }) => counters,
    metrics: ({ counters, nowMs }, s) =>
      fromTiles(
        countersPageDefinition,
        ["total", "non_zero", "errors"],
        // QuerySourceInput carries `data` as unknown by design (it resolves
        // states, not payloads); the query this card is handed is the same
        // getTelemtZeroOptions() CountersPage uses, so the shape is known.
        (counters.data as ZeroAllData | undefined) ?? null,
        s,
        nowMs,
      ),
  },
  {
    domain: "connections",
    disabledHint: RUNTIME_EDGE_HINTS,
    source: ({ stats }) => ({
      kind: "topic",
      snapshot: stats,
      gated: stats.data?.connections_summary ?? null,
    }),
    metrics: ({ stats, users, nowMs }, s) => {
      const gated = stats.data ? resolveGated(stats.data.connections_summary) : null;
      return fromTiles(
        connectionsPageDefinition,
        ["current_connections", "active_users", "connections_total"],
        connectionsPagePayload(
          stats.data?.summary,
          gated?.status === "ok" ? gated.data : null,
          usersTrafficTotal(users.data),
        ),
        s,
        nowMs,
      );
    },
  },
  {
    domain: "upstreams",
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
      return fromTiles(
        natPageDefinition,
        ["live_total", "configured", "attempts"],
        nat?.status === "ok" ? nat.data : null,
        s,
        nowMs,
      );
    },
  },
  {
    domain: "events",
    disabledHint: RUNTIME_EDGE_HINTS,
    source: ({ runtime }) => ({
      kind: "topic",
      snapshot: runtime,
      gated: runtime.data?.recent_events ?? null,
    }),
    metrics: ({ runtime, nowMs }, s) => {
      const events = runtime.data ? resolveGated(runtime.data.recent_events) : null;
      return fromTiles(
        eventsPageDefinition,
        ["count", "types", "dropped_total"],
        eventsPagePayload(events?.status === "ok" ? events.data : null),
        s,
        nowMs,
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

    return {
      domain: spec.domain,
      title: s.diag.domains[spec.domain],
      status: state.status,
      pill: PILL_STATE[state.status],
      pillLabel: sourceStatusShortLabel(state.status, s),
      metrics: gate === null && state.hasData ? spec.metrics(inputs, s) : [],
      gate,
    };
  });
}
