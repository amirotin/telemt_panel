import type {
  RuntimeUpstreamQualityData,
  UpstreamStatus,
  UpstreamSummary,
  UpstreamsData,
} from "../../realtime/topics";
import type { State } from "../../ui/StatePill";

export type UpstreamsResult =
  | { status: "loading" }
  | { status: "disabled"; reason?: string }
  | { status: "ok"; upstreams: UpstreamStatus[]; healthyTotal: number; unhealthyTotal: number };

// computeUpstreams reads the "upstreams" topic's own upstreams field
// (GET /v1/stats/upstreams) — like DcStatusData, always present once the
// topic loads with its own enabled/reason flag for the underlying feature.
export function computeUpstreams(
  data: { enabled: boolean; reason?: string; summary?: { healthy_total: number; unhealthy_total: number }; upstreams?: UpstreamStatus[] } | null,
): UpstreamsResult {
  if (!data) return { status: "loading" };
  if (!data.enabled) return { status: "disabled", reason: data.reason };
  const upstreams = data.upstreams ?? [];
  return {
    status: "ok",
    upstreams,
    healthyTotal: data.summary?.healthy_total ?? upstreams.filter((u) => u.healthy).length,
    unhealthyTotal: data.summary?.unhealthy_total ?? upstreams.filter((u) => !u.healthy).length,
  };
}

// upstreamQualitySuccessRate computes the compact success-rate figure the
// widget shows in extended mode (0-100, rounded) — null when the
// upstream_quality payload is off/absent or has never attempted a connect
// (division by zero), so the caller can omit the line entirely rather than
// showing a misleading 0%.
export function upstreamQualitySuccessRate(quality: RuntimeUpstreamQualityData | null | undefined): number | null {
  if (!quality?.enabled) return null;
  const { connect_attempt_total, connect_success_total } = quality.counters;
  if (connect_attempt_total === 0) return null;
  return Math.round((connect_success_total / connect_attempt_total) * 100);
}


// --- concept §12's adaptive card ----------------------------------------

/**
 * One protocol in the fleet's composition — «SOCKS5 ×2».
 *
 * `label` is the protocol's own spelling, not a translated word: Telemt
 * writes `socks5` in `route_kind` and every diagnostics page prints it that
 * way, so the card capitalises it and stops there.
 */
export interface UpstreamKindCount {
  label: string;
  count: number;
}

export interface UpstreamsCardView {
  /**
   * Exactly one route and it is direct — concept §12's «Если используется
   * только direct», where «● Direct / Healthy» is the whole card. This is
   * the shape almost every install actually has.
   */
  directOnly: boolean;
  healthy: number;
  total: number;
  tone: State;
  kinds: UpstreamKindCount[];
  /** Mean effective latency over the routes that reported one; null when none did. */
  latencyMs: number | null;
}

// The order the composition is printed in — direct first, then the proxy
// protocols in the order Telemt's own summary lists them.
const KIND_FIELDS: Array<readonly [keyof UpstreamSummary, string]> = [
  ["direct_total", "Direct"],
  ["socks4_total", "SOCKS4"],
  ["socks5_total", "SOCKS5"],
  ["shadowsocks_total", "Shadowsocks"],
];

/**
 * The fleet's composition. Telemt's `summary` is the authority when it is
 * there — it counts every configured route, including ones the `upstreams`
 * array may omit — and the route rows are the fallback for a payload that
 * carried no summary.
 */
export function upstreamKinds(
  summary: UpstreamSummary | undefined,
  upstreams: readonly UpstreamStatus[],
): UpstreamKindCount[] {
  if (summary) {
    return KIND_FIELDS.map(([field, label]) => ({ label, count: summary[field] })).filter(
      (kind) => kind.count > 0,
    );
  }
  const counted = new Map<string, number>();
  for (const upstream of upstreams) {
    const label = upstream.route_kind;
    counted.set(label, (counted.get(label) ?? 0) + 1);
  }
  return [...counted].map(([label, count]) => ({ label, count }));
}

/**
 * The one latency figure the card has room for: the mean of the routes that
 * reported an effective latency. Null rather than zero when none did — a
 * «0 мс» upstream would be a lie about a route nobody has measured yet.
 */
export function upstreamMeanLatency(upstreams: readonly UpstreamStatus[]): number | null {
  const measured = upstreams
    .map((u) => u.effective_latency_ms)
    .filter((ms): ms is number => ms !== null);
  if (measured.length === 0) return null;
  return measured.reduce((a, b) => a + b, 0) / measured.length;
}

/**
 * computeUpstreamsCard — concept §12: the card adapts to the configuration
 * the operator actually has, rather than holding a table open for one they
 * may never build.
 *
 * A direct-only install (one route, `route_kind: "direct"` — the shape of
 * every live proxy this panel has been pointed at) gets «● Direct ·
 * В норме · 103 мс» and nothing else. Add a SOCKS pair and the same card
 * grows the health fraction and the composition on its own, from the same
 * payload, with no second layout to maintain.
 */
export function computeUpstreamsCard(result: UpstreamsResult & { status: "ok" }, data: UpstreamsData): UpstreamsCardView {
  const { upstreams, healthyTotal, unhealthyTotal } = result;
  const total = data.summary?.configured_total ?? healthyTotal + unhealthyTotal;
  const kinds = upstreamKinds(data.summary, upstreams);
  return {
    directOnly: total === 1 && kinds.length === 1 && kinds[0]!.label === "Direct",
    healthy: healthyTotal,
    total,
    // Any route the proxy will not use is a fault of this subsystem, not a
    // warning about it: traffic that would have gone that way is not going.
    tone: healthyTotal >= total && total > 0 ? "ok" : total === 0 ? "muted" : "error",
    kinds,
    latencyMs: upstreamMeanLatency(upstreams),
  };
}
