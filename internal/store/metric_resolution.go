package store

import (
	"slices"
	"sort"
	"time"
)

type rankedMetricPoint struct {
	point      MetricPoint
	start, end int64
	rank       int
}

// compactMetricRange bounds a 90-day API response without dropping peaks or
// sampling every Nth point. It also covers imported legacy histories that
// have no hourly rows yet. Ordinary live and seven-day queries are untouched.
func compactMetricRange(name string, points []MetricPoint) []MetricPoint {
	if len(points) <= 4096 {
		return points
	}
	buckets := groupMetricSamples(points, time.Hour)
	out := make([]MetricPoint, 0, len(buckets))
	for _, ts := range sortedMetricBuckets(buckets) {
		var aggregate MetricPoint
		for _, point := range buckets[ts] {
			if point.Tier == MetricTierRaw {
				point = aggregateMetricSamples(name, []MetricPoint{point})
			}
			aggregate = mergeMetricAggregates(name, aggregate, point)
		}
		aggregate.TS, aggregate.Tier = ts, MetricTierHour
		out = append(out, aggregate)
	}
	return out
}

func selectMetricResolution(points []MetricPoint, fromTS, now int64) []MetricPoint {
	raw := make([]int64, 0)
	for _, p := range points {
		if p.Tier == MetricTierRaw {
			raw = append(raw, p.TS)
		}
	}
	slices.Sort(raw)
	longRange := fromTS < now-int64(7*24*time.Hour/time.Second)
	ordered := make([]rankedMetricPoint, 0, len(points))
	for _, p := range points {
		start, end := metricObservationBounds(p)
		rank := 0
		switch p.Tier {
		case MetricTierRaw:
			if p.TS >= now-int64(LiveMetricRetention/time.Second) {
				rank = 5
			}
		case MetricTierFive:
			rank = 4
			// A restarted process must not replace a complete durable bucket
			// with just its last replayed sample. Live points after the stored
			// observation boundary remain visible as a separate tail.
			left := sort.Search(len(raw), func(i int) bool { return raw[i] >= start })
			right := sort.Search(len(raw), func(i int) bool { return raw[i] > end })
			if int64(right-left) < p.Samples {
				rank = 6
			}
		case MetricTierHour:
			rank = 1
			if longRange || p.TS < now-int64(7*24*time.Hour/time.Second) {
				rank = 7
			}
		case MetricTierMinute:
			rank = 2
			if desiredMetricTier(p.TS, now) == MetricTierMinute {
				rank = 3
			}
		case MetricTierQuarter:
			rank = 2
			if desiredMetricTier(p.TS, now) == MetricTierQuarter {
				rank = 3
			}
		default:
			continue
		}
		ordered = append(ordered, rankedMetricPoint{point: p, start: start, end: end, rank: rank})
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].rank != ordered[j].rank {
			return ordered[i].rank > ordered[j].rank
		}
		return ordered[i].start < ordered[j].start
	})
	selected := make([]rankedMetricPoint, 0, len(ordered))
	for _, candidate := range ordered {
		index := sort.Search(len(selected), func(i int) bool { return selected[i].start >= candidate.start })
		if index > 0 && selected[index-1].end >= candidate.start {
			continue
		}
		if index < len(selected) && selected[index].start <= candidate.end {
			continue
		}
		selected = slices.Insert(selected, index, candidate)
	}
	out := make([]MetricPoint, 0, len(selected))
	for _, item := range selected {
		if item.point.TS >= fromTS {
			out = append(out, item.point)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out
}

func metricObservationBounds(point MetricPoint) (int64, int64) {
	if point.Tier == MetricTierRaw {
		return point.TS, point.TS
	}
	start := point.TS
	if point.Min != nil {
		start = point.FirstTS
	}
	if point.LastTS >= start && point.LastTS != 0 {
		return start, point.LastTS
	}
	width := int64(3600)
	switch point.Tier {
	case MetricTierMinute:
		width = 60
	case MetricTierFive:
		width = 300
	case MetricTierQuarter:
		width = 900
	}
	return start, point.TS + width - 1
}
