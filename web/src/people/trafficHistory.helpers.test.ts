import { describe, expect, it } from "vitest";
import { trafficBarHeights, trafficHistorySummary } from "./trafficHistory.helpers";

describe("traffic history helpers", () => {
  it("sums non-overlapping sparse buckets and keeps the peak", () => {
    expect(trafficHistorySummary([{ ts: 1, v: 100 }, { ts: 2, v: 0 }, { ts: 3, v: 250 }])).toEqual({
      total: 350,
      peak: 250,
    });
  });

  it("normalizes bars without producing invalid geometry", () => {
    expect(trafficBarHeights([{ ts: 1, v: 50 }, { ts: 2, v: 100 }])).toEqual([0.5, 1]);
    expect(trafficBarHeights([{ ts: 1, v: 0 }])).toEqual([0]);
  });
});
