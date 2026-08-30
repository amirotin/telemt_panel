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

/**
 * A NEGATIVE id is not a test site: by Telegram's own convention (Telemt's
 * `transport/middle_proxy/pool_config.rs` — "negative DC entries mirror
 * positives when absent (Telegram convention)") DC −N is the MEDIA/download
 * server group of DC N. It carries real client traffic, just a different
 * kind of it.
 */
export function isMediaDc(dc: Pick<DcStatus, "dc">): boolean {
  return dc.dc < 0;
}

/**
 * The one id that really is the test environment — DC 203, and −203 its
 * media group. Everything else, sign regardless, is production.
 */
export const TEST_DC_ID = 203;

export function isTestDc(dc: Pick<DcStatus, "dc">): boolean {
  return Math.abs(dc.dc) === TEST_DC_ID;
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

/**
 * Writers as a FILL FRACTION — `alive / required`, clamped to 0…1.
 *
 * The node used to draw one dot per required writer. Dots only work while
 * the floor is small: the live fleet has a data center needing ten, which
 * rendered as a row of specks nobody counts, and the node then had to fall
 * back to the bare fraction for exactly that DC — one node in twelve
 * speaking a different visual language. A thin bar says the same thing at
 * any floor, and the fraction underneath still gives the exact numbers.
 *
 * A pool over its floor clamps at a full bar, the same way coverage does:
 * a bar past its own track reads as a bug, not as spare capacity.
 */
export function dcWriterRatio(dc: Pick<DcStatus, "alive_writers" | "required_writers">): number {
  if (dc.required_writers <= 0) return dc.alive_writers > 0 ? 1 : 0;
  return Math.min(Math.max(dc.alive_writers / dc.required_writers, 0), 1);
}

// Ids of magnitude >= 100 are the 203-family sites; they close their row
// rather than sorting by number, which would put DC -203 at the head of the
// negative row and DC 203 in the middle of nothing.
const FAR_DC_MAGNITUDE = 100;

function byBoardOrder(a: { dc: number }, b: { dc: number }): number {
  const far = Number(Math.abs(a.dc) >= FAR_DC_MAGNITUDE) - Number(Math.abs(b.dc) >= FAR_DC_MAGNITUDE);
  return far !== 0 ? far : a.dc - b.dc;
}

/** Which half of the board a row is — the word the row label prints. */
export type DcBoardRowKind = "media" | "main";

export interface DcBoardRow<T> {
  kind: DcBoardRowKind;
  dcs: T[];
}

/**
 * Concept §9's «Альтернативная компоновка» — the board's two rows:
 *
 *     Медиа      DC-5  DC-4  DC-3  DC-2  DC-1  DC-203
 *     Основные   DC1   DC2   DC3   DC4   DC5   DC203
 *
 * Media groups (negative ids) on top, main groups underneath, each row
 * ascending with the 203-family site last, so a column pairs a data center
 * with its own media servers and the block reads like a route panel. Each
 * row carries its KIND because the two halves are no longer told apart by
 * colour — every node is coloured by its state now — and «-5» alone does
 * not say "media servers of DC 5" to anyone who has not been told.
 *
 * Returned as ROWS rather than one flat list because the two rows are
 * rendered as two grids: that is what makes the pairing survive a payload
 * with an odd number of sites, and what turns the same markup into concept
 * §21's 3×4 on a phone (three columns × two rows, twice).
 */
export function dcBoardRows<T extends { dc: number }>(dcs: readonly T[]): DcBoardRow<T>[] {
  const media = dcs.filter((dc) => dc.dc < 0).sort(byBoardOrder);
  const main = dcs.filter((dc) => dc.dc >= 0).sort(byBoardOrder);
  return [
    { kind: "media" as const, dcs: media },
    { kind: "main" as const, dcs: main },
  ].filter((row) => row.dcs.length > 0);
}

/** The RTT as the node prints it — `42 ms`, or an em dash when unmeasured. */
export function dcRttText(dc: DcStatus, s: Dict): string {
  if (dc.rtt_ms === null) return "—";
  return `${formatNumber(s, Math.round(dc.rtt_ms))} ${s.pulse.dc.rttUnit}`;
}

/**
 * What a node's id MEANS, in words — the half of its identity the number
 * alone cannot carry. `null` for a plain production data center, whose id
 * already says everything.
 */
export function dcKindLabel(dc: Pick<DcStatus, "dc">, s: Dict): string | null {
  const parts: string[] = [];
  if (isMediaDc(dc)) {
    parts.push(fill(s.pulse.dc.mediaGroup, { dc: formatNumber(s, Math.abs(dc.dc)) }));
  }
  if (isTestDc(dc)) parts.push(s.pulse.dc.testSite);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The node's accessible name. A node is a small tile of a ring, a writers
 * bar and a number — every one of concept §9's four facts is encoded
 * visually, so the label has to spell all four out, plus what kind of DC
 * group this is (media / test), which only a dashed ring and a tiny tag
 * hint at on screen.
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
