//go:build !lite

package store

import (
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

const metricPointColumns = "tier, ts, value, max, samples, last_ts, min_value, first_ts, first_value, delta, observed_seconds, gaps"

// RecordMetric queues an observation for the next batched flush.
func (s *SQLite) RecordMetric(name string, point MetricPoint) error {
	return s.RecordMetrics([]NamedMetricPoint{{Name: name, Point: point}})
}

// RecordMetrics updates live graphs and a bounded pending batch without disk
// I/O. Already flushed timestamps are immutable; duplicates and late samples
// still in the pending batch are replaced and sorted before aggregation.
func (s *SQLite) RecordMetrics(batch []NamedMetricPoint) error {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	if s.metricsClosed {
		return sql.ErrConnDone
	}
	if s.liveMetrics == nil {
		s.liveMetrics = make(map[string][]MetricPoint)
	}
	if s.pendingMetrics == nil {
		s.pendingMetrics = make(map[string][]MetricPoint)
	}
	for _, named := range batch {
		if named.Name == "" || math.IsNaN(named.Point.Value) || math.IsInf(named.Point.Value, 0) {
			continue
		}
		s.liveMetrics[named.Name] = appendLiveMetric(s.liveMetrics[named.Name], named.Point)
		if persistentMetricHistory(named.Name) && s.policy(metricCategory(named.Name)).Enabled {
			s.pendingMetrics[named.Name] = appendLiveMetric(s.pendingMetrics[named.Name], named.Point)
		}
	}
	return nil
}

// flushMetrics commits each pending observation to a five-minute bucket and
// an hourly bucket in one transaction. A failed transaction keeps the pending
// batch for retry. Existing bucket watermarks prevent replay after a restart.
func (s *SQLite) flushMetrics() error {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	if len(s.pendingMetrics) == 0 {
		return nil
	}
	err := s.withOperationTx(func(tx *sql.Tx) error {
		for _, name := range sortedKeys(s.pendingMetrics) {
			if !s.policy(metricCategory(name)).Enabled {
				continue
			}
			fine := groupMetricSamples(s.pendingMetrics[name], 5*time.Minute)
			hours := make(map[int64][]MetricPoint)
			for _, ts := range sortedMetricBuckets(fine) {
				previous, err := readMetricAggregate(tx, name, MetricTierFive, ts)
				if err != nil {
					return err
				}
				var accepted []MetricPoint
				for _, point := range fine[ts] {
					if previous.Samples == 0 || point.TS > previous.LastTS {
						accepted = append(accepted, point)
						hour := metricBucket(point.TS, time.Hour)
						hours[hour] = append(hours[hour], point)
					}
				}
				if len(accepted) == 0 {
					continue
				}
				point := mergeMetricAggregates(name, previous, aggregateMetricSamples(name, accepted))
				point.TS, point.Tier = ts, MetricTierFive
				if err := s.writeMetricAggregate(tx, name, point); err != nil {
					return err
				}
			}
			for _, ts := range sortedMetricBuckets(hours) {
				previous, err := readMetricAggregate(tx, name, MetricTierHour, ts)
				if err != nil {
					return err
				}
				// A legacy or imported hour can already contain observations
				// whose five-minute buckets never existed or have expired.
				// Its watermark prevents those observations being counted twice.
				accepted := make([]MetricPoint, 0, len(hours[ts]))
				for _, sample := range hours[ts] {
					if previous.Samples == 0 || sample.TS > previous.LastTS {
						accepted = append(accepted, sample)
					}
				}
				if len(accepted) == 0 {
					continue
				}
				point := mergeMetricAggregates(name, previous, aggregateMetricSamples(name, accepted))
				point.TS, point.Tier = ts, MetricTierHour
				if err := s.writeMetricAggregate(tx, name, point); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("flush metric history: %w", err)
	}
	clear(s.pendingMetrics)
	return nil
}

func readMetricAggregate(tx *sql.Tx, name string, tier MetricTier, ts int64) (MetricPoint, error) {
	point, err := scanMetricPoint(tx.QueryRow("SELECT "+metricPointColumns+" FROM metric_points WHERE name = ? AND tier = ? AND ts = ?", name, tier, ts))
	if errors.Is(err, sql.ErrNoRows) {
		return MetricPoint{}, nil
	}
	return point, err
}

func scanMetricPoint(row interface{ Scan(...any) error }) (MetricPoint, error) {
	var point MetricPoint
	var tier string
	err := row.Scan(&tier, &point.TS, &point.Value, &point.Max, &point.Samples, &point.LastTS,
		&point.Min, &point.FirstTS, &point.FirstValue, &point.Delta, &point.ObservedSeconds, &point.Gaps)
	point.Tier = metricTierFromSQL(tier)
	if point.Tier == MetricTierRaw {
		point = MetricPoint{TS: point.TS, Value: point.Value}
	}
	return point, err
}

func (s *SQLite) writeMetricAggregate(tx *sql.Tx, name string, point MetricPoint) error {
	query := sqlstore.Upsert("metric_points", []string{"name", "tier", "ts"}, []string{
		"category", "value", "max", "samples", "last_ts", "min_value", "first_ts", "first_value", "delta", "observed_seconds", "gaps",
	})
	_, err := tx.Exec(query, name, metricTierSQL(point.Tier), point.TS, metricCategory(name),
		point.Value, point.Max, point.Samples, point.LastTS, point.Min, point.FirstTS, point.FirstValue,
		point.Delta, point.ObservedSeconds, point.Gaps)
	return err
}
