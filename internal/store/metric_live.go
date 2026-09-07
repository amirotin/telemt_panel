package store

import (
	"cmp"
	"math"
	"slices"
	"time"
)

// MetricCap bounds a live series at the default five-second poll cadence,
// including both endpoints of a two-hour window. The timestamp bound also
// applies to slower collectors; faster collectors cannot grow memory freely.
const MetricCap = int(LiveMetricRetention/(5*time.Second)) + 1

// LiveMetricRetention is the maximum observation span of process-local
// metric samples, independent of optional disk retention.
const LiveMetricRetention = 2 * time.Hour

// appendLiveMetric keeps samples ordered and unique by timestamp. Late
// samples cannot push the observation window backwards or displace newer
// samples. Its caller owns synchronization and the returned slice.
func appendLiveMetric(points []MetricPoint, point MetricPoint) []MetricPoint {
	if math.IsNaN(point.Value) || math.IsInf(point.Value, 0) {
		return points
	}
	point = MetricPoint{TS: point.TS, Value: point.Value}
	latest := point.TS
	if len(points) > 0 {
		latest = max(latest, points[len(points)-1].TS)
	}
	cutoff := latest - int64(metricRawRetention/time.Second)
	if point.TS < cutoff {
		return points
	}
	index, exists := slices.BinarySearchFunc(points, point.TS, func(p MetricPoint, ts int64) int {
		return cmp.Compare(p.TS, ts)
	})
	if exists {
		points[index] = point
	} else {
		points = slices.Insert(points, index, point)
	}
	start, _ := slices.BinarySearchFunc(points, cutoff, func(p MetricPoint, ts int64) int {
		return cmp.Compare(p.TS, ts)
	})
	start = max(start, len(points)-MetricCap)
	if start > 0 {
		copy(points, points[start:])
		clear(points[len(points)-start:])
		points = points[:len(points)-start]
	}
	return points
}
