package store

import "time"

const (
	metricRawRetention       = LiveMetricRetention
	metricMinuteRetention    = 24 * time.Hour
	userTrafficFineRetention = 24 * time.Hour
)

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
