package store

import (
	"strings"
	"time"
)

func persistentMetricHistory(name string) bool {
	switch name {
	case "health", "telemt.available", "telemt.unavailable", "mode.route", "dc.coverage_pct", "upstream.healthy_total", "upstream.unhealthy_total":
		return false
	}
	return !strings.HasPrefix(name, "upstream.") || (!strings.HasSuffix(name, ".healthy") && !strings.HasSuffix(name, ".unhealthy"))
}

const (
	metricRawRetention       = LiveMetricRetention
	metricMinuteRetention    = 24 * time.Hour
	userTrafficFineRetention = 24 * time.Hour
)

var metricTierRetention = []struct {
	tier MetricTier
	sql  string
	keep time.Duration
}{
	{tier: MetricTierRaw, sql: metricTierRawSQL, keep: metricRawRetention},
	{tier: MetricTierMinute, sql: string(MetricTierMinute), keep: metricMinuteRetention},
	{tier: MetricTierFive, sql: string(MetricTierFive), keep: 7 * 24 * time.Hour},
	{tier: MetricTierQuarter, sql: string(MetricTierQuarter)},
	{tier: MetricTierHour, sql: string(MetricTierHour)},
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
	return selectMetricResolution(points, fromTS, now)
}
