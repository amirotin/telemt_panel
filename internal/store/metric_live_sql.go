//go:build !lite

package store

func (s *SQLite) liveMetricRange(name string, fromTS int64) []MetricPoint {
	s.liveMu.RLock()
	defer s.liveMu.RUnlock()
	out := make([]MetricPoint, 0, len(s.liveMetrics[name]))
	for _, point := range s.liveMetrics[name] {
		if point.TS >= fromTS {
			out = append(out, point)
		}
	}
	return out
}

// mergeLiveMetrics replaces persisted raw samples with their current live
// values while leaving earlier data and aggregate selection to the reader.
func mergeLiveMetrics(stored, live []MetricPoint) []MetricPoint {
	if len(live) == 0 {
		return stored
	}
	timestamps := make(map[int64]struct{}, len(live))
	for _, point := range live {
		timestamps[point.TS] = struct{}{}
	}
	out := make([]MetricPoint, 0, len(stored)+len(live))
	for _, point := range stored {
		_, replaced := timestamps[point.TS]
		if point.Tier != MetricTierRaw || !replaced {
			out = append(out, point)
		}
	}
	return append(out, live...)
}
