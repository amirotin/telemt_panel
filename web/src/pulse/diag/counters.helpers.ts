import type { ZeroAllData } from "../../lib/api/generated/types.gen";
import { visibleFor, type DisplayMode } from "../../display-mode";
import { COUNTER_GROUP_PATHS } from "../details-builder/definitions/counters";

// countersRefetchMs: the poll that MAKES the deltas (ruling R4). The panel
// has no counter-history endpoint, so "change per second" is the difference
// between two consecutive answers — which means the interval is a product
// decision, not a caching one. Ten seconds is short enough that a reader who
// opens the page sees a rate within one breath, and long enough that a
// 4 KB dump every ten seconds costs the proxy nothing.
export const countersRefetchMs = 10_000;

// countersRefetchInterval ties the poll to the section it exists for.
//
// The deltas live on the deep `zero/all` map, and 06-ui.md:27,49 puts that
// map in extended mode. Polling in basic would buy a reader nothing they
// can see and still cost a 4 KB dump every ten seconds — so basic fetches
// the dump ONCE, for the tiles and the three breakdowns it does show, and
// leaves it there.
export function countersRefetchInterval(mode: DisplayMode): number | false {
  return visibleFor("extended", mode) ? countersRefetchMs : false;
}

/** One counter reading, keyed by the normalized path the map renderer uses. */
export type CounterSnapshot = Record<string, number>;

// readCounterValues flattens the five zero/all sections into `path -> number`
// — the shape a delta is arithmetic on. Only NUMERIC scalars: `core` also
// carries booleans and a telemetry level, and a "change per second" on a
// policy flag would be nonsense (§13.1 keeps a state and a counter apart).
//
// Nested containers (`connections_bad_by_class`, `handshake_error_codes`)
// are skipped here: they are breakdowns with their own section, and the
// resolver already gives them one.
export function readCounterValues(data: ZeroAllData | undefined): CounterSnapshot {
  const out: CounterSnapshot = {};
  if (!data) return out;
  for (const group of COUNTER_GROUP_PATHS) {
    const section = (data as unknown as Record<string, unknown>)[group];
    if (section === null || typeof section !== "object" || Array.isArray(section)) continue;
    for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[`${group}.${key}`] = value;
    }
  }
  return out;
}

/**
 * The one counter that says how long the process it belongs to has been
 * running. It is monotonic INSIDE a process and starts over at zero when
 * Telemt is restarted, which makes it the only honest way to tell "this
 * counter went down" from "every counter went back to zero".
 */
export const COUNTER_UPTIME_PATH = "core.uptime_seconds";

// countersRestarted answers "did Telemt restart between these two readings".
//
// A blanket "a negative delta means a reset" would be wrong here: the same
// five groups carry GAUGES that legitimately fall — `pool.pool_drain_active`
// drops as a drain completes, `core.configured_users` drops when a user is
// deleted — and suppressing those would hide the very movement a reader
// opened the page for. Uptime going backwards is the process-level fact,
// and it invalidates every counter at once rather than one at a time.
export function countersRestarted(
  before: CounterSnapshot | undefined,
  after: CounterSnapshot,
): boolean {
  const wasUp = before?.[COUNTER_UPTIME_PATH];
  const isUp = after[COUNTER_UPTIME_PATH];
  if (wasUp === undefined || isUp === undefined) return false;
  return isUp < wasUp;
}

export interface CounterDeltaInput {
  /** The reading two responses ago, and when it was taken (epoch ms). */
  previous: { values: CounterSnapshot; atMs: number } | null;
  /** The reading the page opened on (or the last reset), for the since-open column. */
  baseline: { values: CounterSnapshot; atMs: number } | null;
  current: { values: CounterSnapshot; atMs: number };
}

export interface CounterDeltas {
  /** Change per second since the previous response, by normalized path. */
  perSecond: CounterSnapshot;
  /** Absolute change since the page-open baseline, by normalized path. */
  sinceOpen: CounterSnapshot;
}

// computeCounterDeltas is ruling R4 as arithmetic: the panel has no counter
// history endpoint, so a rate is the difference between two consecutive
// answers divided by the time between them.
//
// Two rules that keep it honest rather than merely plausible:
//
//   * a counter that did not appear in the earlier reading gets NO delta.
//     A new key is not a jump from zero, and printing one would invent a
//     rate for a counter Telemt only just started reporting;
//   * a non-positive elapsed time yields no per-second column at all. Two
//     responses stamped the same millisecond (a cache hit, a clock that did
//     not move) would otherwise divide by zero and print Infinity;
//   * a reading taken ACROSS a Telemt restart yields no delta at all. The
//     counters started over at zero, so `value - before` is minus the whole
//     of the previous run — "−192 351/с" — and the restart is exactly the
//     moment a reader opens this page.
export function computeCounterDeltas(input: CounterDeltaInput): CounterDeltas {
  const perSecond: CounterSnapshot = {};
  const sinceOpen: CounterSnapshot = {};

  const { previous, baseline, current } = input;
  if (previous && !countersRestarted(previous.values, current.values)) {
    const elapsedMs = current.atMs - previous.atMs;
    if (elapsedMs > 0) {
      const seconds = elapsedMs / 1000;
      for (const [path, value] of Object.entries(current.values)) {
        const before = previous.values[path];
        if (before === undefined) continue;
        const rate = (value - before) / seconds;
        // Round to two decimals: the row prints a rate, not a measurement.
        perSecond[path] = Math.round(rate * 100) / 100;
      }
    }
  }
  if (baseline && !countersRestarted(baseline.values, current.values)) {
    for (const [path, value] of Object.entries(current.values)) {
      const before = baseline.values[path];
      if (before === undefined) continue;
      sinceOpen[path] = value - before;
    }
  }
  return { perSecond, sinceOpen };
}
