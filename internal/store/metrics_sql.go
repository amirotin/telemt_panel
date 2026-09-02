//go:build !lite

package store

import (
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"
)

const (
	metricMaintenanceInterval = 5 * time.Minute
	metricPruneBatchSize      = 250
)

var aggregateMetricTiers = []struct {
	tier  MetricTier
	width time.Duration
}{
	{tier: MetricTierMinute, width: time.Minute},
	{tier: MetricTierQuarter, width: 15 * time.Minute},
}

// RecordMetric persists one raw point and rebuilds its minute and 15-minute
// buckets in the same transaction. Rebuilding from raw points makes duplicate
// timestamps and out-of-order samples deterministic across all SQL dialects.
func (s *SQLite) RecordMetric(name string, point MetricPoint) error {
	return s.RecordMetrics([]NamedMetricPoint{{Name: name, Point: point}})
}

// RecordMetrics persists a poll's related samples in one transaction and one
// operation timeout. A remote database outage therefore delays a collector by
// at most one bounded call, not one timeout per metric/DC.
func (s *SQLite) RecordMetrics(batch []NamedMetricPoint) error {
	filtered := make([]NamedMetricPoint, 0, len(batch))
	for _, named := range batch {
		if named.Name == "" || !s.policy(metricCategory(named.Name)).Enabled {
			continue
		}
		named.Point.Tier = MetricTierRaw
		named.Point.Max = 0
		named.Point.Samples = 0
		filtered = append(filtered, named)
	}
	if len(filtered) == 0 {
		return nil
	}
	err := s.withOperationTx(func(tx *sql.Tx) error {
		query := s.dialect.Upsert("metric_points", []string{"name", "tier", "ts"}, []string{"category", "value", "max", "samples", "last_ts"})
		for _, named := range filtered {
			point := named.Point
			category := metricCategory(named.Name)
			if _, err := tx.Exec(s.bind(query), named.Name, metricTierRawSQL, point.TS, category, point.Value, point.Value, 1, point.TS); err != nil {
				return err
			}
		}
		for _, named := range filtered {
			for _, aggregate := range aggregateMetricTiers {
				if err := s.rebuildMetricBucket(tx, named.Name, metricCategory(named.Name), named.Point.TS, aggregate.tier, aggregate.width); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("record metric: %w", err)
	}
	return nil
}

func (s *SQLite) rebuildMetricBucket(tx *sql.Tx, name string, category StorageCategory, ts int64, tier MetricTier, width time.Duration) error {
	bucket := metricBucket(ts, width)
	end := bucket + int64(width/time.Second)
	rows, err := tx.Query(s.bind(`SELECT ts, value FROM metric_points WHERE name = ? AND tier = ? AND ts >= ? AND ts < ? ORDER BY ts`), name, metricTierRawSQL, bucket, end)
	if err != nil {
		return err
	}
	defer rows.Close()

	var value, maxValue float64
	var samples int64
	var lastTS int64
	for rows.Next() {
		var sampleTS int64
		var sample float64
		if err := rows.Scan(&sampleTS, &sample); err != nil {
			return err
		}
		if samples == 0 {
			maxValue = sample
		} else {
			maxValue = math.Max(maxValue, sample)
		}
		value += sample
		samples++
		lastTS = sampleTS
		if metricBucketUsesLast(name) {
			value = sample
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if samples == 0 {
		return nil
	}
	if !metricBucketUsesLast(name) {
		value /= float64(samples)
	}
	query := s.dialect.Upsert("metric_points", []string{"name", "tier", "ts"}, []string{"category", "value", "max", "samples", "last_ts"})
	_, err = tx.Exec(s.bind(query), name, metricTierSQL(tier), bucket, category, value, maxValue, samples, lastTS)
	return err
}

// MetricRange returns a non-overlapping mixture of raw, minute and 15-minute
// points, oldest first. Finer points are retained as a migration fallback when
// an older bucket has not been aggregated yet.
func (s *SQLite) MetricRange(name string, fromTS int64) ([]MetricPoint, error) {
	if !s.policy(metricCategory(name)).Enabled {
		return []MetricPoint{}, nil
	}
	rows, err := s.query(`SELECT tier, ts, value, max, samples FROM metric_points WHERE name = ? AND ts >= ? ORDER BY ts, tier`, name, fromTS)
	if err != nil {
		return nil, fmt.Errorf("read metric range: %w", err)
	}
	defer rows.Close()
	var all []MetricPoint
	for rows.Next() {
		var point MetricPoint
		var tier string
		if err := rows.Scan(&tier, &point.TS, &point.Value, &point.Max, &point.Samples); err != nil {
			return nil, fmt.Errorf("scan metric point: %w", err)
		}
		point.Tier = metricTierFromSQL(tier)
		if point.Tier == MetricTierRaw {
			point.Max = 0
			point.Samples = 0
		}
		all = append(all, point)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return selectMetricPoints(all, fromTS, time.Now().Unix()), nil
}

func (s *SQLite) startMetricMaintenance() {
	if s.maintenanceStop != nil {
		return
	}
	s.maintenanceStop = make(chan struct{})
	s.maintenanceDone = make(chan struct{})
	go func() {
		defer close(s.maintenanceDone)
		ticker := time.NewTicker(metricMaintenanceInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if _, err := s.pruneMetricBatch(time.Now(), metricPruneBatchSize); err != nil {
					slog.Warn("store: metric retention worker failed", "driver", s.driver, "error", err)
				}
				if _, err := s.pruneHistoryEventBatch(time.Now(), metricPruneBatchSize); err != nil {
					slog.Warn("store: event retention worker failed", "driver", s.driver, "error", err)
				}
			case <-s.maintenanceStop:
				return
			}
		}
	}()
}

type staleMetricKey struct {
	name string
	tier string
	ts   int64
}

// pruneMetricBatch deletes at most limit stale rows. Tier cutoffs keep the
// write-heavy resolutions bounded independently from the administrator's
// category retention, while 15-minute aggregates live for the full policy.
func (s *SQLite) pruneMetricBatch(now time.Time, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	conditions := []string{"(tier = ? AND ts < ?)", "(tier = ? AND ts < ?)"}
	args := []any{
		metricTierRawSQL, now.Add(-metricRawRetention).Unix(),
		string(MetricTierMinute), now.Add(-metricMinuteRetention).Unix(),
	}
	s.policyMu.RLock()
	for _, category := range storageCategoryOrder {
		policy := s.policies[category]
		if !policy.Enabled {
			continue
		}
		conditions = append(conditions, "(category = ? AND ts < ?)")
		args = append(args, category, now.Add(-retentionDuration(policy)).Unix())
	}
	s.policyMu.RUnlock()
	args = append(args, limit)
	rows, err := s.query(`SELECT name, tier, ts FROM metric_points WHERE `+strings.Join(conditions, " OR ")+` ORDER BY ts LIMIT ?`, args...)
	if err != nil {
		return 0, fmt.Errorf("select stale metric history: %w", err)
	}
	var keys []staleMetricKey
	for rows.Next() {
		var key staleMetricKey
		if err := rows.Scan(&key.name, &key.tier, &key.ts); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan stale metric history: %w", err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("read stale metric history: %w", err)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if len(keys) == 0 {
		return 0, nil
	}
	if err := s.withOperationTx(func(tx *sql.Tx) error {
		for _, key := range keys {
			if _, err := tx.Exec(s.bind(`DELETE FROM metric_points WHERE name = ? AND tier = ? AND ts = ?`), key.name, key.tier, key.ts); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return 0, fmt.Errorf("prune metric history batch: %w", err)
	}
	return len(keys), nil
}
