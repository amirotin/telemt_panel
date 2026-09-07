package store

import (
	"math"
	"slices"
	"time"
)

const metricObservationGap = 120

func groupMetricSamples(points []MetricPoint, width time.Duration) map[int64][]MetricPoint {
	out := make(map[int64][]MetricPoint)
	for _, point := range points {
		ts := metricBucket(point.TS, width)
		out[ts] = append(out[ts], point)
	}
	return out
}

func sortedMetricBuckets(points map[int64][]MetricPoint) []int64 {
	keys := make([]int64, 0, len(points))
	for ts := range points {
		keys = append(keys, ts)
	}
	slices.Sort(keys)
	return keys
}

// aggregateMetricSamples consumes ordered, unique raw observations. Empty
// windows stay empty; an isolated counter observation has no observed duration.
func aggregateMetricSamples(name string, samples []MetricPoint) MetricPoint {
	var out MetricPoint
	for _, sample := range samples {
		value := sample.Value
		point := MetricPoint{
			TS: sample.TS, Value: value, Max: value, Min: &value, Samples: 1,
			FirstTS: sample.TS, LastTS: sample.TS, FirstValue: value,
		}
		if isCounterMetric(name) {
			zero := float64(0)
			point.Delta = &zero
		}
		out = mergeMetricAggregates(name, out, point)
	}
	return out
}

// mergeMetricAggregates combines disjoint observation sets. Means are
// sample-weighted, not means of means. Unknown legacy extrema stay unknown.
// Counter movement across resets, gaps or overlapping sets is never invented.
func mergeMetricAggregates(name string, a, b MetricPoint) MetricPoint {
	if a.Samples == 0 {
		return b
	}
	if b.Samples == 0 {
		return a
	}
	if b.LastTS < a.FirstTS && a.Min != nil && b.Min != nil {
		a, b = b, a
	}
	out := a
	out.Samples = a.Samples + b.Samples
	out.Max = math.Max(a.Max, b.Max)
	out.Min = nil
	if a.Min != nil && b.Min != nil {
		minimum := math.Min(*a.Min, *b.Min)
		out.Min = &minimum
	}
	if metricBucketUsesLast(name) {
		if b.LastTS >= a.LastTS {
			out.Value = b.Value
		}
	} else {
		out.Value = a.Value*(float64(a.Samples)/float64(out.Samples)) + b.Value*(float64(b.Samples)/float64(out.Samples))
		if out.Min != nil {
			out.Value = max(*out.Min, min(out.Max, out.Value))
		}
	}
	if a.Min != nil && b.Min != nil && b.FirstTS < a.FirstTS {
		out.FirstTS, out.FirstValue = b.FirstTS, b.FirstValue
	}
	out.LastTS = max(a.LastTS, b.LastTS)
	out.Gaps = a.Gaps + b.Gaps
	out.ObservedSeconds = a.ObservedSeconds + b.ObservedSeconds
	out.Delta = nil
	if a.Delta != nil && b.Delta != nil {
		delta := *a.Delta + *b.Delta
		out.Delta = &delta
	}
	gap := b.FirstTS - a.LastTS
	known := a.Min != nil && b.Min != nil
	switch {
	case !known || gap <= 0:
		out.Gaps++
		out.Delta = nil
		out.ObservedSeconds = 0
	case gap > metricObservationGap || (isCounterMetric(name) && b.FirstValue < a.Value):
		out.Gaps++
	default:
		out.ObservedSeconds += gap
		if out.Delta != nil {
			*out.Delta += b.FirstValue - a.Value
		}
	}
	return out
}
