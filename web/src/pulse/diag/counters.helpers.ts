import type { ZeroAllData } from "../../lib/api/generated/types.gen";
import { COUNTER_GROUP_PATHS } from "../details-builder/definitions/counters";

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
//     not move) would otherwise divide by zero and print Infinity.
export function computeCounterDeltas(input: CounterDeltaInput): CounterDeltas {
  const perSecond: CounterSnapshot = {};
  const sinceOpen: CounterSnapshot = {};

  const { previous, baseline, current } = input;
  if (previous) {
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
  if (baseline) {
    for (const [path, value] of Object.entries(current.values)) {
      const before = baseline.values[path];
      if (before === undefined) continue;
      sinceOpen[path] = value - before;
    }
  }
  return { perSecond, sinceOpen };
}
