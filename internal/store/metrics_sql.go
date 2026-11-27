//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

const (
	metricMaintenanceInterval = 5 * time.Minute
	metricPruneBatchSize      = 250
	metricPruneCatchUpDelay   = 5 * time.Second
)

// MetricRange selects live samples, five-minute detail or hourly history.
// Existing raw/minute/quarter rows remain readable as a migration fallback.
func (s *SQLite) MetricRange(name string, fromTS int64) ([]MetricPoint, error) {
	return s.MetricRangeContext(context.Background(), name, fromTS)
}
func (s *SQLite) MetricRangeContext(parent context.Context, name string, fromTS int64) ([]MetricPoint, error) {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	live, err := s.liveMetricRangeContext(ctx, name, fromTS)
	if err != nil {
		return nil, err
	}
	if !persistentMetricHistory(name) || !s.policy(metricCategory(name)).Enabled {
		return live, nil
	}
	rows, err := s.queryContext(ctx, "SELECT "+metricPointColumns+" FROM metric_points WHERE name = ? AND ts >= ? ORDER BY ts, tier", name, fromTS)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrHistoryTimeout) {
			return nil, err
		}
		if len(live) > 0 {
			return live, nil
		}
		return nil, fmt.Errorf("read metric range: %w", err)
	}
	defer rows.Close()
	var all []MetricPoint
	for rows.Next() {
		point, err := scanMetricPoint(rows)
		if err != nil {
			return nil, fmt.Errorf("scan metric point: %w", err)
		}
		all = append(all, point)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return compactMetricRange(name, selectMetricPoints(mergeLiveMetrics(all, live), fromTS, time.Now().Unix())), nil
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
		pruneTimer := time.NewTimer(metricMaintenanceInterval)
		defer pruneTimer.Stop()
		for {
			select {
			case <-s.maintenanceStop:
				return
			default:
			}
			select {
			case <-ticker.C:
				if err := s.flushMetrics(); err != nil {
					slog.Warn("store: metric flush failed", "error", err)
				}
			case <-pruneTimer.C:
				pruneTimer.Reset(s.pruneHistoryPass(time.Now()))
			case <-s.maintenanceStop:
				return
			}
		}
	}()
}

// pruneHistoryPass yields between bounded transactions. A full batch may
// leave a backlog, so revisit it sooner without increasing the flush rate.
func (s *SQLite) pruneHistoryPass(now time.Time) time.Duration {
	catchUp, failed := false, false
	for _, task := range []struct {
		name string
		run  func(time.Time, int) (int, error)
	}{
		{"metrics", s.pruneMetricBatch},
		{"events", s.pruneHistoryEventBatch},
		{"user_traffic", s.pruneUserTrafficBatch},
	} {
		removed, err := task.run(now, metricPruneBatchSize)
		if err != nil {
			failed = true
			slog.Warn("store: history retention worker failed", "category", task.name, "driver", s.Driver(), "error", err)
		}
		catchUp = catchUp || removed == metricPruneBatchSize
	}
	// Database failures retain the normal backoff instead of a noisy retry loop.
	if catchUp && !failed {
		return metricPruneCatchUpDelay
	}
	return metricMaintenanceInterval
}

type staleUserTrafficKey struct {
	userID int64
	tier   int
	ts     int64
}

func (s *SQLite) pruneUserTrafficBatch(now time.Time, limit int) (int, error) {
	ctx, cancel := historyOperationContext(context.Background())
	defer cancel()
	if limit <= 0 {
		return 0, nil
	}
	policy := s.policy(StorageUserTraffic)
	retention := retentionDuration(policy)
	rows, err := s.queryContext(ctx, `SELECT user_id, tier, ts FROM user_traffic_buckets WHERE tier = 0 AND ts < ?
        UNION ALL SELECT user_id, tier, ts FROM user_traffic_buckets WHERE tier = 1 AND ts < ?
        UNION ALL SELECT user_id, tier, ts FROM user_traffic_buckets WHERE tier = 2 AND ts < ?
		ORDER BY ts LIMIT ?`,
		now.Add(-min(userTrafficFineRetention, retention)).Unix(),
		now.Add(-min(30*24*time.Hour, retention)).Unix(),
		now.Add(-retention).Unix(),
		limit,
	)
	if err != nil {
		return 0, fmt.Errorf("select stale user traffic: %w", err)
	}
	var keys []staleUserTrafficKey
	for rows.Next() {
		var key staleUserTrafficKey
		if err := rows.Scan(&key.userID, &key.tier, &key.ts); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan stale user traffic: %w", err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("read stale user traffic: %w", err)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := s.withOperationTxContext(ctx, func(tx *sql.Tx) error {
		for _, key := range keys {
			if _, err := tx.ExecContext(ctx, `DELETE FROM user_traffic_buckets WHERE user_id = ? AND tier = ? AND ts = ?`, key.userID, key.tier, key.ts); err != nil {
				return err
			}
		}
		return pruneTrafficSummariesTx(ctx, tx, now.Unix(), retention)
	}); err != nil {
		return 0, fmt.Errorf("prune user traffic batch: %w", err)
	}
	return len(keys), nil
}

type staleMetricKey struct {
	name string
	tier string
	ts   int64
}

// pruneMetricBatch deletes at most limit stale rows. Tier cutoffs keep the
// write-heavy resolutions bounded independently from the administrator's
// category retention.
func (s *SQLite) pruneMetricBatch(now time.Time, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	// Each index range is ordered by timestamp. SQLite merges their heads
	// and stops at the batch limit, including when no range has stale rows.
	tiers := []struct {
		tier   MetricTier
		maxAge time.Duration
	}{
		{MetricTierRaw, metricRawRetention}, {MetricTierMinute, metricMinuteRetention},
		{MetricTierFive, 7 * 24 * time.Hour}, {MetricTierQuarter, 0}, {MetricTierHour, 0},
	}
	var queries []string
	var args []any
	s.policyMu.RLock()
	for _, category := range storageCategoryOrder {
		policy := s.policies[category]
		for _, tier := range tiers {
			age := tier.maxAge
			if policy.Enabled && (age == 0 || retentionDuration(policy) < age) {
				age = retentionDuration(policy)
			}
			if age == 0 {
				continue
			}
			queries = append(queries, "SELECT name, tier, ts FROM metric_points WHERE category = ? AND tier = ? AND ts < ?")
			args = append(args, category, metricTierSQL(tier.tier), now.Add(-age).Unix())
		}
	}
	s.policyMu.RUnlock()
	rows, err := s.query(strings.Join(queries, " UNION ALL ")+" ORDER BY ts LIMIT ?", append(args, limit)...)
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
			if _, err := tx.Exec(`DELETE FROM metric_points WHERE name = ? AND tier = ? AND ts = ?`, key.name, key.tier, key.ts); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return 0, fmt.Errorf("prune metric history batch: %w", err)
	}
	return len(keys), nil
}
