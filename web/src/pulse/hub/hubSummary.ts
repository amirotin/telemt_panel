import type { Dict } from "../../i18n";
import type { RuntimeNatStun } from "../../realtime/topics";
import { formatValue, type FieldUnit, type FormatterName } from "../formatting";
import type { ConnectionsPagePayload } from "../diag/connections.helpers";
import { reflectionAgeSecs, STUN_REFLECTION_TTL_SECONDS } from "../diag/nat.helpers";
import {
  bestLatencyMs,
  type UpstreamsPagePayload,
} from "../diag/upstreams.helpers";
import type { WebPagePayload } from "../diag/web.helpers";

export type SummaryTone = "neutral" | "good" | "warn" | "bad";

export interface SummaryMetricDefinition<T> {
  id: string;
  label: (s: Dict) => string;
  value: (context: T) => unknown;
  format?: FormatterName;
  unit?: FieldUnit;
  tone?: SummaryTone | ((context: T) => SummaryTone);
}

export interface ResolvedSummaryMetric {
  id: string;
  label: string;
  text: string;
  tone: SummaryTone;
}

export function resolveSummaryMetric<T>(
  metric: SummaryMetricDefinition<T>,
  context: T,
  s: Dict,
  nowMs: number,
): ResolvedSummaryMetric {
  const formatted = formatValue(metric.value(context), s, {
    nowMs,
    ...(metric.format !== undefined ? { formatter: metric.format } : {}),
    ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
  });
  const tone = typeof metric.tone === "function" ? metric.tone(context) : (metric.tone ?? "neutral");
  return { id: metric.id, label: metric.label(s), text: formatted.text, tone };
}

export const CONNECTIONS_HUB_METRICS: readonly SummaryMetricDefinition<ConnectionsPagePayload>[] = [
  {
    id: "current_connections",
    label: (s) => s.details.fields.shortLabels["connections.totals.current_connections"],
    value: (payload) => payload.totals?.current_connections ?? null,
    format: "integer",
  },
  {
    id: "active_users",
    label: (s) => s.details.fields.shortLabels["connections.totals.active_users"],
    value: (payload) => payload.totals?.active_users ?? null,
    format: "integer",
  },
];

function natReflectionTone(nat: RuntimeNatStun): SummaryTone {
  if (!nat.flags?.nat_probe_enabled || nat.flags?.nat_probe_disabled_runtime) return "neutral";
  const age = reflectionAgeSecs(nat);
  const failed =
    (nat.flags?.nat_probe_attempts ?? 0) > 0 || (nat.stun_backoff_remaining_ms ?? 0) > 0;
  if (age !== null && age < STUN_REFLECTION_TTL_SECONDS) return "good";
  if (age !== null) return failed ? "warn" : "neutral";
  return failed ? "bad" : "neutral";
}

export const NAT_HUB_METRICS: readonly SummaryMetricDefinition<RuntimeNatStun>[] = [
  {
    id: "reflection_age",
    label: (s) => s.details.pages.nat.reflectionAgeTile,
    value: reflectionAgeSecs,
    unit: "seconds",
    tone: natReflectionTone,
  },
];

function upstreamHealthTone(payload: UpstreamsPagePayload): SummaryTone {
  if (payload.upstreams === undefined) return "neutral";
  const unhealthy = payload.upstreams.filter((upstream) => !upstream.healthy).length;
  if (unhealthy === 0) return "good";
  return (payload.summary?.healthy_total ?? 0) === 0 ? "bad" : "warn";
}

export const UPSTREAMS_HUB_METRICS: readonly SummaryMetricDefinition<UpstreamsPagePayload>[] = [
  {
    id: "configured",
    label: (s) => s.details.fields.shortLabels["upstreams.summary.configured_total"],
    value: (payload) => payload.summary?.configured_total ?? null,
    format: "integer",
  },
  {
    id: "healthy",
    label: (s) => s.details.fields.shortLabels["upstreams.summary.healthy_total"],
    value: (payload) => payload.summary?.healthy_total ?? null,
    format: "integer",
    tone: upstreamHealthTone,
  },
  {
    id: "latency",
    label: (s) => s.details.pages.upstreams.latencyTile,
    value: (payload) => bestLatencyMs(payload.upstreams),
    unit: "milliseconds",
  },
];

function webLifecycleTone(payload: WebPagePayload): SummaryTone {
  switch (payload.lifecycle) {
    case "running":
      return "good";
    case "starting":
    case "draining":
      return "warn";
    case "deadline_exceeded":
      return "bad";
    default:
      return "neutral";
  }
}

export const WEB_HUB_METRICS: readonly SummaryMetricDefinition<WebPagePayload>[] = [
  {
    id: "lifecycle",
    label: (s) => s.details.fields.shortLabels["web.lifecycle"],
    value: (payload) => payload.lifecycle ?? null,
    format: "enum",
    tone: webLifecycleTone,
  },
  {
    id: "sessions",
    label: (s) => s.details.fields.shortLabels["web.manager.sessions"],
    value: (payload) => payload.runtime?.manager?.sessions ?? null,
    format: "integer",
  },
  {
    id: "streams",
    label: (s) => s.details.fields.shortLabels["web.streams.live"],
    value: (payload) => payload.runtime?.streams?.live ?? null,
    format: "integer",
  },
];
