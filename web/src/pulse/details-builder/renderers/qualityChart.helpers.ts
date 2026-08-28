// Reading a chartable series out of a CustomSection's value (spec §9.8).
//
// Kept apart from the component so the two rules the chart depends on — what
// counts as a point, and what the caption calls p50 — are testable without a
// DOM, and so the chart module exports nothing but a component.

/** One labelled measurement of the series a quality chart draws. */
export interface QualityPoint {
  label: string;
  value: number;
}

// readQualitySeries accepts the two shapes a definition can hand over: a
// bare number series, or {label, value} pairs (what an ME `dc_rtt[]`
// adapter produces). Anything else yields an empty series and the chart
// says so, rather than drawing a bar of NaN.
export function readQualitySeries(value: unknown): QualityPoint[] {
  if (!Array.isArray(value)) return [];
  const points: QualityPoint[] = [];
  value.forEach((entry, index) => {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      points.push({ label: String(index + 1), value: entry });
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const raw = record["value"];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return;
    points.push({ label: String(record["label"] ?? index + 1), value: raw });
  });
  return points;
}

/** The median of a series — what the render's caption reports as p50. */
export function medianOf(points: readonly QualityPoint[]): number | null {
  if (points.length === 0) return null;
  const sorted = points.map((p) => p.value).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
