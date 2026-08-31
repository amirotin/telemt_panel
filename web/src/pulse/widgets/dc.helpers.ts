import type { DcStatus } from "../../realtime/topics";
import type { State } from "../../ui/StatePill";
import { fill, formatNumber, type Dict } from "../../i18n";

export type DcResult =
  | { status: "loading" }
  | { status: "disabled"; reason?: string }
  | { status: "ok"; dcs: DcStatus[] };

// computeDc reads the "upstreams" topic's dcs field (GET /v1/stats/dcs,
// gated behind minimal_runtime_enabled — DcStatusData is always present
// once the topic loads, but its own middle_proxy_enabled flag reports
// whether the underlying feature is on).
export function computeDc(
  dcs: { middle_proxy_enabled: boolean; reason?: string; dcs: DcStatus[] } | null,
): DcResult {
  if (!dcs) return { status: "loading" };
  if (!dcs.middle_proxy_enabled) return { status: "disabled", reason: dcs.reason };
  return { status: "ok", dcs: dcs.dcs };
}

// dcCoverageState maps a DC's coverage_pct to the StatePill semantic set —
// full coverage is ok, any shortfall relative to the floor is a problem
// worth flagging (warn under 100%, error at 0 alive writers). Same rule as
// details-builder's dcAttentionTone, in the widget's own vocabulary.
export function dcCoverageState(dc: DcStatus): "ok" | "warn" | "error" {
  if (dc.alive_writers === 0) return "error";
  if (dc.coverage_pct < 100) return "warn";
  return "ok";
}

/** Coverage drives degradation; high RTT is a separate attention state. */
export function dcRouteState(dc: DcStatus): "ok" | "warn" | "error" {
  const coverage = dcCoverageState(dc);
  if (coverage !== "ok") return coverage;
  return dcRttTone(dc.rtt_ms) === "warn" ? "warn" : "ok";
}

/**
 * A NEGATIVE id is not a test site. In MTProxy's signed target id it selects
 * the media-only route for the same logical DC; test DCs use the separate
 * +10000 convention. Telemt keeps +N and −N as distinct writer groups even
 * when their configured ME endpoints happen to be identical.
 */
export function isMediaDc(dc: Pick<DcStatus, "dc">): boolean {
  return dc.dc < 0;
}

// dcNodeTone is the coverage ring's colour (concept §9's "Цветовая логика
// DC"): the card itself stays dark, the RING carries the state. EVERY node
// is coloured by its state — the muting that used to quiet the negative ids
// rested on reading them as test sites, and a media group of a production DC
// is not a place where a lost writer matters less.
export function dcNodeTone(dc: DcStatus): State {
  return dcCoverageState(dc);
}

/**
 * The RTT above which a data center's latency reads as amber (concept §9:
 * «Если RTT выходит за нормальный диапазон, значение становится amber»).
 *
 * Telemt reports no expected range of its own, so this is the panel's own
 * threshold rather than a rule read off the API. 150 ms is a round number
 * above the round-trip to a Telegram DC on another continent from a
 * European host (the live snapshot spans 19–187 ms) and below the point
 * where a relay hop is visibly slow to a client.
 */
export const DC_RTT_WARN_MS = 150;

export function dcRttTone(rttMs: number | null): "warn" | null {
  if (rttMs === null) return null;
  return rttMs > DC_RTT_WARN_MS ? "warn" : null;
}

// Ids of magnitude >= 100 are the 203-family sites; they close their row
// rather than sorting by number, which would put DC -203 at the head of the
// negative row and DC 203 in the middle of nothing.
const FAR_DC_MAGNITUDE = 100;

export interface DcRouteGroup<T> {
  id: number;
  main?: T;
  media?: T;
}

/** Pair the signed ME routes under the logical DC id an operator scans for. */
export function dcRouteGroups<T extends { dc: number }>(dcs: readonly T[]): DcRouteGroup<T>[] {
  const groups = new Map<number, DcRouteGroup<T>>();
  for (const dc of dcs) {
    const id = Math.abs(dc.dc);
    const group = groups.get(id) ?? { id };
    if (dc.dc < 0) group.media = dc;
    else group.main = dc;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => {
    const far = Number(a.id >= FAR_DC_MAGNITUDE) - Number(b.id >= FAR_DC_MAGNITUDE);
    return far !== 0 ? far : a.id - b.id;
  });
}

/** Which half of the board a row is — the word the row label prints. */
/** The RTT as the node prints it — `42 ms`, or an em dash when unmeasured. */
export function dcRttText(dc: DcStatus, s: Dict): string {
  if (dc.rtt_ms === null) return "—";
  return `${formatNumber(s, Math.round(dc.rtt_ms))} ${s.pulse.dc.rttUnit}`;
}

/**
 * What a signed route id means in words. `null` for the main route, whose
 * positive id already says everything.
 */
export function dcKindLabel(dc: Pick<DcStatus, "dc">, s: Dict): string | null {
  if (isMediaDc(dc)) {
    return fill(s.pulse.dc.mediaGroup, { dc: formatNumber(s, Math.abs(dc.dc)) });
  }
  return null;
}

/**
 * The node's accessible name. A node is a small tile of a ring, a writers
 * bar and a number — every one of concept §9's four facts is encoded
 * visually, so the label has to spell all four out, plus what kind of DC
 * group this is (main / media).
 */
export function dcNodeAriaLabel(dc: DcStatus, s: Dict): string {
  const base = fill(s.pulse.dc.nodeLabel, {
    dc: formatNumber(s, dc.dc),
    coverage: formatNumber(s, Math.round(dc.coverage_pct)),
    alive: formatNumber(s, dc.alive_writers),
    required: formatNumber(s, dc.required_writers),
    rtt: dcRttText(dc, s),
  });
  const kind = dcKindLabel(dc, s);
  return kind === null ? base : `${base} · ${kind}`;
}

export interface DcOverview {
  total: number;
  covered: number;
  writersAlive: number;
  writersRequired: number;
  p95RttMs: number | null;
  attention: DcStatus[];
}

// Overview carries the conclusion, not the full twelve-node board. Nodes
// needing attention are ordered by coverage first and RTT second; a healthy
// fleet therefore occupies three summary facts and no inventory wall.
export function computeDcOverview(dcs: readonly DcStatus[]): DcOverview {
  const rtts = dcs
    .map((dc) => dc.rtt_ms)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(rtts.length * 0.95) - 1);
  const attention = dcs
    .filter((dc) => dcCoverageState(dc) !== "ok" || dcRttTone(dc.rtt_ms) === "warn")
    .sort((a, b) => {
      const severity = (dc: DcStatus) =>
        dcCoverageState(dc) === "error" ? 2 : dcCoverageState(dc) === "warn" ? 1 : 0;
      return severity(b) - severity(a) || (b.rtt_ms ?? -1) - (a.rtt_ms ?? -1);
    })
    .slice(0, 3);
  return {
    total: dcs.length,
    covered: dcs.filter((dc) => dcCoverageState(dc) === "ok").length,
    writersAlive: dcs.reduce((sum, dc) => sum + dc.alive_writers, 0),
    writersRequired: dcs.reduce((sum, dc) => sum + dc.required_writers, 0),
    p95RttMs: rtts.length > 0 ? rtts[p95Index]! : null,
    attention,
  };
}
