//go:build !lite

package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

const userTrafficBatchRows = 200

type userTrafficRow struct {
	name    string
	tier    MetricTier
	ts      int64
	value   float64
	max     float64
	samples int
	lastTS  int64
}

type userTrafficKey struct {
	name string
	tier MetricTier
	ts   int64
}

// RecordUserTraffic aggregates non-zero user deltas directly into 15-minute
// and hourly rows. It deliberately never writes raw per-poll user samples.
func (s *SQLite) RecordUserTraffic(deltas []UserTrafficDelta) error {
	if !s.policy(StorageUserTraffic).Enabled {
		return nil
	}
	rows := make([]userTrafficRow, 0, len(deltas)*2)
	rowIndex := make(map[userTrafficKey]int, len(deltas)*2)
	appendDelta := func(row userTrafficRow) {
		key := userTrafficKey{name: row.name, tier: row.tier, ts: row.ts}
		if index, ok := rowIndex[key]; ok {
			rows[index].value += row.value
			rows[index].max = max(rows[index].max, row.max)
			rows[index].samples += row.samples
			rows[index].lastTS = max(rows[index].lastTS, row.lastTS)
			return
		}
		rowIndex[key] = len(rows)
		rows = append(rows, row)
	}
	for _, delta := range deltas {
		if delta.Username == "" || delta.TS <= 0 || delta.Bytes == 0 {
			continue
		}
		value := float64(delta.Bytes)
		name := userTrafficMetricName(delta.Username)
		appendDelta(userTrafficRow{name: name, tier: MetricTierQuarter, ts: metricBucket(delta.TS, 15*time.Minute), value: value, max: value, samples: 1, lastTS: delta.TS})
		appendDelta(userTrafficRow{name: name, tier: MetricTierHour, ts: metricBucket(delta.TS, time.Hour), value: value, max: value, samples: 1, lastTS: delta.TS})
	}
	if len(rows) == 0 {
		return nil
	}

	err := s.withOperationTx(func(tx *sql.Tx) error {
		for start := 0; start < len(rows); start += userTrafficBatchRows {
			end := min(start+userTrafficBatchRows, len(rows))
			query, args := s.userTrafficUpsert(rows[start:end])
			if _, err := tx.Exec(query, args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("record user traffic: %w", err)
	}
	return nil
}

func (s *SQLite) userTrafficUpsert(rows []userTrafficRow) (string, []any) {
	var query strings.Builder
	query.WriteString("INSERT INTO metric_points (name, tier, ts, category, value, max, samples, last_ts) VALUES ")
	args := make([]any, 0, len(rows)*8)
	for i, row := range rows {
		if i > 0 {
			query.WriteString(", ")
		}
		query.WriteString("(?, ?, ?, ?, ?, ?, ?, ?)")
		args = append(args, row.name, row.tier, row.ts, StorageUserTraffic, row.value, row.max, row.samples, row.lastTS)
	}
	switch s.dialect.Name() {
	case "mysql":
		query.WriteString(" ON DUPLICATE KEY UPDATE value = value + VALUES(value), max = GREATEST(max, VALUES(max)), samples = samples + VALUES(samples), last_ts = GREATEST(last_ts, VALUES(last_ts))")
	case "postgres":
		query.WriteString(" ON CONFLICT (name, tier, ts) DO UPDATE SET value = metric_points.value + EXCLUDED.value, max = GREATEST(metric_points.max, EXCLUDED.max), samples = metric_points.samples + EXCLUDED.samples, last_ts = GREATEST(metric_points.last_ts, EXCLUDED.last_ts)")
	default:
		query.WriteString(" ON CONFLICT (name, tier, ts) DO UPDATE SET value = metric_points.value + excluded.value, max = max(metric_points.max, excluded.max), samples = metric_points.samples + excluded.samples, last_ts = max(metric_points.last_ts, excluded.last_ts)")
	}
	return s.bind(query.String()), args
}

// UserTrafficRange returns the non-overlapping sparse resolution for username.
func (s *SQLite) UserTrafficRange(username string, fromTS int64) ([]MetricPoint, error) {
	if !s.policy(StorageUserTraffic).Enabled {
		return []MetricPoint{}, nil
	}
	rows, err := s.query(`SELECT tier, ts, value, max, samples FROM metric_points WHERE name = ? AND category = ? AND ts >= ? AND tier IN (?, ?) ORDER BY ts, tier`,
		userTrafficMetricName(username), StorageUserTraffic, fromTS, MetricTierQuarter, MetricTierHour)
	if err != nil {
		return nil, fmt.Errorf("read user traffic: %w", err)
	}
	defer rows.Close()
	var points []MetricPoint
	for rows.Next() {
		var point MetricPoint
		if err := rows.Scan(&point.Tier, &point.TS, &point.Value, &point.Max, &point.Samples); err != nil {
			return nil, fmt.Errorf("scan user traffic: %w", err)
		}
		points = append(points, point)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return selectUserTrafficPoints(points, fromTS, time.Now().Unix()), nil
}

// UserTrafficRetention reports the configured category retention.
func (s *SQLite) UserTrafficRetention() time.Duration {
	policy := s.policy(StorageUserTraffic)
	if !policy.Enabled {
		return 0
	}
	return retentionDuration(policy)
}

// DeleteUserHistory removes all optional history owned by username.
func (s *SQLite) DeleteUserHistory(username string) error {
	_, err := s.exec(`DELETE FROM metric_points WHERE name = ? AND category = ?`, userTrafficMetricName(username), StorageUserTraffic)
	return wrapSQLError("delete user history", err)
}
