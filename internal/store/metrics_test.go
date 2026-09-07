package store

import (
	"testing"
	"time"
)

func TestSelectMetricPointsFallsBackToRecentFiveMinuteBucket(t *testing.T) {
	now := int64(2_000_000)
	ts := metricBucket(now-60, 5*time.Minute)
	minimum := float64(10)
	aggregate := MetricPoint{TS: ts, Tier: MetricTierFive, FirstTS: ts + 5, LastTS: ts + 30, Value: 20, Min: &minimum, Max: 30, Samples: 3}
	got := selectMetricPoints([]MetricPoint{aggregate}, now-3600, now)
	if len(got) != 1 || got[0].Tier != MetricTierFive {
		t.Fatalf("recent durable fallback lost after restart: %+v", got)
	}
	points := []MetricPoint{aggregate, {TS: ts + 35, Value: 40}}
	got = selectMetricPoints(points, now-3600, now)
	if len(got) != 2 || got[0].Tier != MetricTierFive || got[1].Tier != MetricTierRaw {
		t.Fatalf("coarse history and new live tail overlap or disappeared: %+v", got)
	}
	points = append(points, MetricPoint{TS: ts + 30, Value: 30})
	got = selectMetricPoints(points, now-3600, now)
	if len(got) != 2 || got[0].Tier != MetricTierFive {
		t.Fatalf("one replayed raw point replaced an entire historical bucket: %+v", got)
	}
}

func TestSelectMetricPointsPrefersCompleteLiveObservations(t *testing.T) {
	now := int64(2_000_000)
	ts := metricBucket(now-60, 5*time.Minute)
	minimum := float64(10)
	points := []MetricPoint{
		{TS: ts, Tier: MetricTierFive, FirstTS: ts + 5, LastTS: ts + 15, Min: &minimum, Samples: 3},
		{TS: ts + 5, Value: 10}, {TS: ts + 10, Value: 20}, {TS: ts + 15, Value: 30},
	}
	got := selectMetricPoints(points, now-3600, now)
	if len(got) != 3 {
		t.Fatalf("live detail replaced by aggregate: %+v", got)
	}
	for _, p := range got {
		if p.Tier != MetricTierRaw {
			t.Fatalf("duplicate aggregate in live range: %+v", got)
		}
	}
}

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

func TestSelectUserTrafficPointsUsesFineDayAndHourlyArchive(t *testing.T) {
	now := time.Date(2026, 9, 2, 18, 0, 0, 0, time.UTC).Unix()
	points := []MetricPoint{
		{TS: now - int64(48*time.Hour/time.Second), Value: 400, Tier: MetricTierHour},
		{TS: now - int64(30*time.Minute/time.Second), Value: 100, Tier: MetricTierHour},
		{TS: now - int64(30*time.Minute/time.Second), Value: 20, Tier: MetricTierQuarter},
		{TS: now - int64(15*time.Minute/time.Second), Value: 30, Tier: MetricTierQuarter},
	}
	got := selectUserTrafficPoints(points, now-int64(7*24*time.Hour/time.Second), now)
	if len(got) != 3 {
		t.Fatalf("points = %+v, want archived hour and two fine buckets", got)
	}
	if got[0].Tier != MetricTierHour || got[1].Tier != MetricTierQuarter || got[2].Tier != MetricTierQuarter {
		t.Fatalf("tiers = %+v", got)
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
