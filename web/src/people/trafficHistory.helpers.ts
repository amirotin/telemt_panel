export interface TrafficHistoryPoint {
  ts: number;
  v: number;
  tier?: "1m" | "15m" | "1h" | "1d";
  max?: number;
}

export function trafficHistorySummary(points: readonly TrafficHistoryPoint[]) {
  let total = 0;
  let peak = 0;
  for (const point of points) {
    if (!Number.isFinite(point.v) || point.v < 0) continue;
    total += point.v;
    peak = Math.max(peak, point.v);
  }
  return { total, peak };
}

export function trafficBarHeights(points: readonly TrafficHistoryPoint[]): number[] {
  const { peak } = trafficHistorySummary(points);
  if (peak <= 0) return points.map(() => 0);
  return points.map((point) => Math.max(0, Math.min(1, point.v / peak)));
}
