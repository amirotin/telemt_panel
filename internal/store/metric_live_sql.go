//go:build !lite

package store

import "context"

func (s *SQLite) liveMetricRange(name string, fromTS int64) []MetricPoint {
	points, _ := s.liveMetricRangeContext(context.Background(), name, fromTS)
	return points
}

func (s *SQLite) liveMetricRangeContext(ctx context.Context, name string, fromTS int64) ([]MetricPoint, error) {
	if err := lockHistoryMutex(ctx, historyReadMutex{&s.liveMu}); err != nil {
		return nil, err
	}
	defer s.liveMu.RUnlock()
	out := make([]MetricPoint, 0, len(s.liveMetrics[name]))
	for _, point := range s.liveMetrics[name] {
		if point.TS >= fromTS {
			out = append(out, point)
		}
	}
	return out, nil
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
