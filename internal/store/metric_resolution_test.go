package store

import "testing"

func TestCompactMetricRangePreservesLegacyPeaksAndWeights(t *testing.T) {
	points := make([]MetricPoint, 90*24*4)
	for i := range points {
		points[i] = MetricPoint{TS: int64(i * 900), Tier: MetricTierQuarter, Value: 10, Max: 20, Samples: 2, LastTS: int64(i*900 + 895)}
	}
	points[1].Value, points[1].Max, points[1].Samples = 50, 100, 6
	got := compactMetricRange("connections", points)
	if len(got) != 2160 || got[0].Max != 100 || got[0].Samples != 12 || got[0].Min != nil || got[0].Delta != nil || got[0].Value < 29.999 || got[0].Value > 30.001 {
		t.Fatalf("compacted history lost extrema, weights or unknown metadata: count=%d first=%+v", len(got), got[0])
	}
}

func TestCompactMetricRangeLeavesLivePointsAlone(t *testing.T) {
	points := []MetricPoint{{TS: 305, Value: 2}, {TS: 310, Value: 3}}
	got := compactMetricRange("connections", points)
	if len(got) != 2 || got[0].TS != 305 || got[0].Tier != MetricTierRaw {
		t.Fatalf("live window compacted: %+v", got)
	}
}
