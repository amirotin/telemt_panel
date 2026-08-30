import type {
  RuntimeGates,
  RuntimeMeQuality,
  RuntimeMePoolState,
} from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { fill, formatNumber, type Dict } from "../../i18n";

/** Concept §10's three words for the subsystem's state. */
export type MeCardState = "healthy" | "degraded" | "fallback";

/**
 * Why the card is not «Healthy» — one machine-readable reason, rendered by
 * meReasonText. A discriminated union rather than a finished sentence so
 * the helper stays testable without a dictionary and the numbers stay
 * numbers until the locale formats them.
 */
export type MeReason =
  | { kind: "fallback"; detail?: string }
  | { kind: "coverage"; pct: number }
  | { kind: "writersLost"; missing: number }
  | { kind: "draining"; count: number }
  | { kind: "degradedWriters"; count: number }
  | { kind: "family"; family: string; state: string };

export interface MeCardView {
  state: MeCardState;
  tone: State;
  writersAlive: number;
  writersTotal: number;
  /** null when me_quality is gated off — the whole «Coverage · RTT» line goes with it. */
  coveragePct: number | null;
  rttMs: number | null;
  refillInflight: number;
  draining: number;
  /** null while healthy: concept §17's compact card has no reason line. */
  reason: MeReason | null;
}

// Route mode as the ME card reads it: middle-proxy IS configured but the
// relay is sending traffic direct. Same two gate fields healthHero's
// routeModeValue reads — real operational state, not the config flag.
function isFallback(gates: RuntimeGates | null | undefined): boolean {
  if (!gates || !gates.use_middle_proxy) return false;
  return gates.reroute_active || gates.route_mode === "direct";
}

/**
 * Pool-wide coverage and latency, aggregated from ME quality's per-DC rows:
 * Telemt reports both per data center, and the card shows one number for
 * the subsystem (concept §10's «Coverage 100% · RTT 38 ms»).
 *
 * Coverage is alive-over-required across the pool rather than a mean of the
 * per-DC percentages — a data center needing ten writers must not weigh the
 * same as one needing three. RTT is a plain mean of the DCs that reported
 * one, which is the summary figure the card has room for; the per-DC spread
 * is on the ME diagnostics page.
 */
export function meQualitySummary(quality: RuntimeMeQuality | undefined): {
  coveragePct: number | null;
  rttMs: number | null;
} {
  if (!quality || quality.dc_rtt.length === 0) return { coveragePct: null, rttMs: null };
  let required = 0;
  let alive = 0;
  const rtts: number[] = [];
  for (const dc of quality.dc_rtt) {
    required += dc.required_writers;
    alive += dc.alive_writers;
    if (dc.rtt_ema_ms !== null) rtts.push(dc.rtt_ema_ms);
  }
  return {
    // Capped at the full circle, as Telemt's own me-writers summary caps
    // it: a pool can carry more writers than its floor demands, and
    // «Покрытие 102 %» reads as an error rather than as spare capacity.
    coveragePct: required > 0 ? Math.min((alive / required) * 100, 100) : null,
    rttMs: rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
  };
}

// The reason ladder, worst first: traffic bypassing ME entirely outranks a
// coverage shortfall, which outranks writers that are merely missing, which
// outranks the ones that are on their way out or unwell. The first match
// wins — the card has room for ONE line, and the ME page has the rest.
function firstReason(
  pool: RuntimeMePoolState,
  quality: RuntimeMeQuality | undefined,
  gates: RuntimeGates | null | undefined,
  coveragePct: number | null,
): MeReason | null {
  if (isFallback(gates)) {
    const detail = gates?.reroute_reason;
    return { kind: "fallback", ...(detail ? { detail } : {}) };
  }
  if (coveragePct !== null && coveragePct < 100) return { kind: "coverage", pct: coveragePct };
  if (pool.writers.alive_non_draining < pool.writers.total) {
    return { kind: "writersLost", missing: pool.writers.total - pool.writers.alive_non_draining };
  }
  if (pool.writers.draining > 0) return { kind: "draining", count: pool.writers.draining };
  if (pool.writers.degraded > 0) return { kind: "degradedWriters", count: pool.writers.degraded };
  const unhealthy = quality?.family_states.find((f) => f.state !== "healthy");
  if (unhealthy) return { kind: "family", family: unhealthy.family, state: unhealthy.state };
  return null;
}

/**
 * computeMeCard — concept §10's subsystem card: a state word, the writer
 * count, one line of coverage and latency, one line of pool churn, and —
 * only when something is wrong (§17) — the reason.
 *
 * `quality` and `gates` are optional because each arrives behind its own
 * gate: with ME quality off the card still knows its writers, it just has
 * no coverage or RTT to show.
 */
export function computeMeCard(
  pool: RuntimeMePoolState,
  quality?: RuntimeMeQuality,
  gates?: RuntimeGates | null,
): MeCardView {
  const { coveragePct, rttMs } = meQualitySummary(quality);
  const reason = firstReason(pool, quality, gates, coveragePct);
  const state: MeCardState =
    reason === null ? "healthy" : reason.kind === "fallback" ? "fallback" : "degraded";
  return {
    state,
    // Traffic bypassing the middle proxy is a failure of the subsystem this
    // card is about; everything else is a degradation of a working one.
    tone: state === "healthy" ? "ok" : state === "fallback" ? "error" : "warn",
    writersAlive: pool.writers.alive_non_draining,
    writersTotal: pool.writers.total,
    coveragePct,
    rttMs,
    refillInflight: pool.refill.inflight_endpoints_total,
    draining: pool.writers.draining,
    reason,
  };
}

/** The reason line, in the reader's language. */
export function meReasonText(reason: MeReason, s: Dict): string {
  const t = s.pulse.mePool.reason;
  switch (reason.kind) {
    case "fallback":
      return reason.detail ? `${t.fallback} (${reason.detail})` : t.fallback;
    case "coverage":
      return fill(t.coverage, { pct: formatNumber(s, Math.round(reason.pct)) });
    case "writersLost":
      return fill(t.writersLost, { count: formatNumber(s, reason.missing) });
    case "draining":
      return fill(t.draining, { count: formatNumber(s, reason.count) });
    case "degradedWriters":
      return fill(t.degradedWriters, { count: formatNumber(s, reason.count) });
    case "family":
      return fill(t.family, { family: reason.family, state: reason.state });
  }
}
