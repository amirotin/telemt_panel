package store

import (
	"testing"
	"time"
)

func TestSelectMetricPointsUsesOneResolutionPerRegion(t *testing.T) {
	now := int64(2_000_000)
	recent := now - 60
	minuteAge := now - int64(3*time.Hour/time.Second)
	quarterAge := now - int64(2*24*time.Hour/time.Second)
	points := []MetricPoint{
		{TS: recent, Value: 1},
		{TS: metricBucket(recent, time.Minute), Value: 2, Tier: MetricTierMinute, Max: 3, Samples: 2},
		{TS: minuteAge, Value: 4},
		{TS: metricBucket(minuteAge, time.Minute), Value: 5, Tier: MetricTierMinute, Max: 6, Samples: 2},
		{TS: quarterAge, Value: 7},
		{TS: metricBucket(quarterAge, time.Minute), Value: 8, Tier: MetricTierMinute, Max: 9, Samples: 2},
		{TS: metricBucket(quarterAge, 15*time.Minute), Value: 10, Tier: MetricTierQuarter, Max: 11, Samples: 3},
	}

	got := selectMetricPoints(points, 0, now)
	if len(got) != 3 {
		t.Fatalf("selected %d points, want 3: %+v", len(got), got)
	}
	if got[0].Tier != MetricTierQuarter || got[1].Tier != MetricTierMinute || got[2].Tier != MetricTierRaw {
		t.Fatalf("selected tiers = [%q %q %q], want [15m 1m raw]", got[0].Tier, got[1].Tier, got[2].Tier)
	}
}

func TestSelectMetricPointsFallsBackToFinerData(t *testing.T) {
	now := int64(2_000_000)
	old := now - int64(2*24*time.Hour/time.Second)
	points := []MetricPoint{
		{TS: old, Value: 7},
		{TS: old + 5, Value: 8},
	}
	got := selectMetricPoints(points, 0, now)
	if len(got) != 2 || got[0].Value != 7 || got[1].Value != 8 {
		t.Fatalf("fallback points = %+v, want both raw points", got)
	}
}

func TestCounterMetricClassification(t *testing.T) {
	for _, name := range []string{"traffic", "attempts", "refusals"} {
		if !isCounterMetric(name) {
			t.Errorf("%q must retain the last bucket value", name)
		}
	}
	for _, name := range []string{"connections", "active_users", "dc.2.rpc.rtt"} {
		if isCounterMetric(name) {
			t.Errorf("%q must be averaged", name)
		}
	}
	if !metricBucketUsesLast("mode.route") {
		t.Error("route mode must retain the last bucket state")
	}
}
