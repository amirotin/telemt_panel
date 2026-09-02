package store

import (
	"sort"
	"time"
)

const (
	metricRawRetention    = 2 * time.Hour
	metricMinuteRetention = 24 * time.Hour
)

var metricTierRetention = []struct {
	tier MetricTier
	sql  string
	keep time.Duration
}{
	{tier: MetricTierRaw, sql: metricTierRawSQL, keep: metricRawRetention},
	{tier: MetricTierMinute, sql: string(MetricTierMinute), keep: metricMinuteRetention},
	{tier: MetricTierQuarter, sql: string(MetricTierQuarter)},
}

func metricTierSQL(tier MetricTier) string {
	if tier == MetricTierRaw {
		return metricTierRawSQL
	}
	return string(tier)
}

func metricTierFromSQL(tier string) MetricTier {
	if tier == metricTierRawSQL {
		return MetricTierRaw
	}
	return MetricTier(tier)
}

func metricBucket(ts int64, width time.Duration) int64 {
	seconds := int64(width / time.Second)
	return ts - ts%seconds
}

func isCounterMetric(name string) bool {
	switch name {
	case "traffic", "attempts", "refusals":
		return true
	default:
		return false
	}
}

func metricBucketUsesLast(name string) bool {
	return isCounterMetric(name) || name == "mode.route"
}

func desiredMetricTier(ts, now int64) MetricTier {
	switch {
	case ts >= now-int64(metricRawRetention/time.Second):
		return MetricTierRaw
	case ts >= now-int64(metricMinuteRetention/time.Second):
		return MetricTierMinute
	default:
		return MetricTierQuarter
	}
}

// selectMetricPoints returns one resolution for every time region and falls
// back to finer points while an upgraded database is still missing historical
// aggregates. That makes the schema migration lossless without duplicating
// buckets in charts.
func selectMetricPoints(points []MetricPoint, fromTS, now int64) []MetricPoint {
	minuteBuckets := make(map[int64]bool)
	quarterBuckets := make(map[int64]bool)
	for _, point := range points {
		switch point.Tier {
		case MetricTierMinute:
			minuteBuckets[point.TS] = true
		case MetricTierQuarter:
			quarterBuckets[point.TS] = true
		}
	}

	out := make([]MetricPoint, 0, len(points))
	for _, point := range points {
		if point.TS < fromTS {
			continue
		}
		desired := desiredMetricTier(point.TS, now)
		include := point.Tier == desired
		switch point.Tier {
		case MetricTierRaw:
			if desired == MetricTierMinute {
				include = !minuteBuckets[metricBucket(point.TS, time.Minute)]
			} else if desired == MetricTierQuarter {
				include = !quarterBuckets[metricBucket(point.TS, 15*time.Minute)] &&
					!minuteBuckets[metricBucket(point.TS, time.Minute)]
			}
		case MetricTierMinute:
			if desired == MetricTierQuarter {
				include = !quarterBuckets[metricBucket(point.TS, 15*time.Minute)]
			}
		}
		if include {
			out = append(out, point)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out
}
