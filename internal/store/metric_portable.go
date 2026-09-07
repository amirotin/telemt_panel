package store

import "fmt"

func validatePortableMetrics(metrics map[string][]MetricPoint) error {
	for name, points := range metrics {
		if name == "" {
			return fmt.Errorf("metric name cannot be empty")
		}
		for _, point := range points {
			switch point.Tier {
			case MetricTierRaw, MetricTierMinute, MetricTierFive, MetricTierQuarter, MetricTierHour:
			default:
				return fmt.Errorf("metric %q has unsupported tier %q", name, point.Tier)
			}
			// Exports predating aggregate metadata intentionally leave these
			// fields absent. Do not invent observation bounds during import.
			if point.Min == nil {
				continue
			}
			width := int64(3600)
			switch point.Tier {
			case MetricTierFive:
				width = 300
			case MetricTierMinute:
				width = 60
			case MetricTierQuarter:
				width = 900
			case MetricTierRaw:
				return fmt.Errorf("raw metric %q contains aggregate metadata", name)
			}
			if point.Samples < 1 || point.FirstTS < point.TS || point.LastTS < point.FirstTS || point.LastTS-point.TS >= width ||
				point.ObservedSeconds < 0 || point.ObservedSeconds > point.LastTS-point.FirstTS || point.Gaps < 0 ||
				*point.Min > point.Max || point.Value < *point.Min || point.Value > point.Max ||
				point.FirstValue < *point.Min || point.FirstValue > point.Max ||
				(point.Delta != nil && (!isCounterMetric(name) || *point.Delta < 0)) {
				return fmt.Errorf("metric %q contains invalid aggregate metadata", name)
			}
		}
	}
	return nil
}
