//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"maps"
	"math"
	"strings"
	"time"
)

type sqlTrafficReadSnapshot struct {
	ctx       context.Context
	cancel    context.CancelFunc
	tx        *sql.Tx
	asOf      int64
	collector UserTrafficCollectorState
	summaries map[string]UserTrafficSummary
	tiers     []TrafficTierPolicy
	closed    bool
}

// BeginTrafficRead establishes a read transaction before capturing its time.
func (s *SQLite) BeginTrafficRead(parent context.Context) (TrafficReadSnapshot, error) {
	ctx, cancel := historyOperationContext(parent)
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("begin traffic read: %w", historySQLContextError(ctx, err))
	}
	collector, found, err := s.readUserTrafficCollectorTx(ctx, tx)
	if err != nil {
		_ = tx.Rollback()
		cancel()
		return nil, err
	}
	if !found {
		collector = UserTrafficCollectorState{SourceState: UserTrafficUnavailable, Continuity: UserTrafficNormal}
	}
	r := &sqlTrafficReadSnapshot{ctx: ctx, cancel: cancel, tx: tx, asOf: time.Now().Unix(), collector: collector}
	retention := int64(s.UserTrafficRetention() / time.Second)
	if retention > 0 {
		r.tiers = []TrafficTierPolicy{
			{Tier: MetricTierQuarter, WidthSecs: 900, RetentionSecs: min(86400, retention)},
			{Tier: MetricTierHour, WidthSecs: 3600, RetentionSecs: min(30*86400, retention)},
			{Tier: MetricTierDay, WidthSecs: 86400, RetentionSecs: retention},
		}
	}
	return r, nil
}
func (r *sqlTrafficReadSnapshot) AsOf() int64 { return r.asOf }
func (r *sqlTrafficReadSnapshot) Close() error {
	if r.closed {
		return nil
	}
	r.closed = true
	defer r.cancel()
	err := r.tx.Rollback()
	if r.ctx.Err() != nil {
		return r.ctx.Err()
	}
	if errors.Is(err, sql.ErrTxDone) {
		return nil
	}
	return err
}
func (r *sqlTrafficReadSnapshot) CollectorState() (UserTrafficCollectorState, error) {
	return r.collector, trafficContextError(r.ctx, r.closed)
}
func (r *sqlTrafficReadSnapshot) Summaries() (map[string]UserTrafficSummary, error) {
	if err := trafficContextError(r.ctx, r.closed); err != nil {
		return nil, err
	}
	if r.summaries == nil {
		rows, err := r.tx.QueryContext(r.ctx, `SELECT username,total_bytes,since_ts,updated_ts,month_key,month_bytes,deleted_ts,continuity FROM user_traffic_users`)
		if err != nil {
			return nil, fmt.Errorf("read traffic snapshot summaries: %w", historySQLContextError(r.ctx, err))
		}
		defer rows.Close()
		summaries := make(map[string]UserTrafficSummary)
		monthKey := utcMonthKey(r.asOf)
		for rows.Next() {
			var summary UserTrafficSummary
			var deleted sql.NullInt64
			if err := rows.Scan(&summary.Username, &summary.ObservedTotalBytes, &summary.ObservedSinceEpochSecs, &summary.LastActivityEpochSecs, &summary.MonthKey, &summary.CurrentMonthBytes, &deleted, &summary.Continuity); err != nil {
				return nil, err
			}
			if deleted.Valid {
				summary.DeletedEpochSecs = deleted.Int64
			}
			if summary.MonthKey != monthKey {
				summary.CurrentMonthBytes = 0
			}
			summaries[summary.Username] = summary
		}
		if err := rows.Err(); err != nil {
			return nil, historySQLContextError(r.ctx, err)
		}
		r.summaries = summaries
	}
	return maps.Clone(r.summaries), nil
}
func trafficSQLPredicate(windows []TrafficWindow) (string, []any) {
	parts := make([]string, 0, len(windows))
	args := make([]any, 0, 3*len(windows))
	for _, window := range windows {
		tier := 0
		switch window.Tier {
		case MetricTierHour:
			tier = 1
		case MetricTierDay:
			tier = 2
		}
		parts = append(parts, "(buckets.tier = ? AND buckets.ts >= ? AND buckets.ts < ?)")
		args = append(args, tier, window.From, window.To)
	}
	if len(parts) == 0 {
		return "0", args
	}
	return "(" + strings.Join(parts, " OR ") + ")", args
}
func (r *sqlTrafficReadSnapshot) Range(username string, from, to int64) ([]UserTrafficPoint, TrafficCoverage, error) {
	windows, coverage, err := PlanTrafficWindows(from, to, r.asOf, r.tiers)
	if err != nil {
		return nil, coverage, err
	}
	if err := trafficContextError(r.ctx, r.closed); err != nil {
		return nil, coverage, err
	}
	predicate, args := trafficSQLPredicate(windows)
	args = append(args, username)
	rows, err := r.tx.QueryContext(r.ctx, `SELECT buckets.tier,buckets.ts,buckets.bytes FROM user_traffic_buckets AS buckets JOIN user_traffic_users AS users ON users.id=buckets.user_id WHERE `+predicate+` AND users.username = ? ORDER BY buckets.ts`, args...)
	if err != nil {
		return nil, coverage, fmt.Errorf("read traffic snapshot range: %w", historySQLContextError(r.ctx, err))
	}
	defer rows.Close()
	points := make([]UserTrafficPoint, 0)
	for rows.Next() {
		var point UserTrafficPoint
		var tier int
		if err := rows.Scan(&tier, &point.TS, &point.Bytes); err != nil {
			return nil, coverage, err
		}
		point.Tier = userTrafficMetricTier(tier)
		points = append(points, point)
	}
	if err := historySQLContextError(r.ctx, rows.Err()); err != nil {
		return nil, coverage, err
	}
	return points, coverage, nil
}
func (r *sqlTrafficReadSnapshot) Aggregate(from, to int64) (int64, []UserTrafficPoint, TrafficCoverage, error) {
	windows, coverage, err := PlanTrafficWindows(from, to, r.asOf, r.tiers)
	if err != nil {
		return 0, nil, coverage, err
	}
	if err := trafficContextError(r.ctx, r.closed); err != nil {
		return 0, nil, coverage, err
	}
	predicate, args := trafficSQLPredicate(windows)
	rows, err := r.tx.QueryContext(r.ctx, `SELECT buckets.tier,buckets.ts,sum(buckets.bytes) FROM user_traffic_buckets AS buckets WHERE `+predicate+` GROUP BY buckets.tier,buckets.ts ORDER BY buckets.ts`, args...)
	if err != nil {
		return 0, nil, coverage, fmt.Errorf("aggregate traffic snapshot: %w", historySQLContextError(r.ctx, err))
	}
	defer rows.Close()
	points := make([]UserTrafficPoint, 0)
	var total int64
	for rows.Next() {
		var point UserTrafficPoint
		var tier int
		if err := rows.Scan(&tier, &point.TS, &point.Bytes); err != nil {
			return 0, nil, coverage, err
		}
		if point.Bytes > math.MaxInt64-total {
			return 0, nil, coverage, errors.New("aggregate user traffic exceeds int64")
		}
		total += point.Bytes
		point.Tier = userTrafficMetricTier(tier)
		points = append(points, point)
	}
	if err := rows.Err(); err != nil {
		return 0, nil, coverage, historySQLContextError(r.ctx, err)
	}
	return total, points, coverage, nil
}
func (r *sqlTrafficReadSnapshot) Ranking(from, to int64, includeDeleted bool, limit int, cursor *UserTrafficRankCursor) ([]UserTrafficRank, TrafficCoverage, error) {
	windows, coverage, err := PlanTrafficWindows(from, to, r.asOf, r.tiers)
	if err != nil {
		return nil, coverage, err
	}
	if err := trafficContextError(r.ctx, r.closed); err != nil {
		return nil, coverage, err
	}
	ranks := make([]UserTrafficRank, 0)
	if limit <= 0 {
		return ranks, coverage, nil
	}
	summaries, err := r.Summaries()
	if err != nil {
		return nil, coverage, err
	}
	predicate, args := trafficSQLPredicate(windows)
	args = append(args, includeDeleted)
	query := `SELECT users.username,sum(buckets.bytes) FROM user_traffic_buckets AS buckets JOIN user_traffic_users AS users ON users.id=buckets.user_id WHERE ` + predicate + ` AND (? OR users.deleted_ts IS NULL) GROUP BY users.id`
	if cursor != nil {
		query += ` HAVING sum(buckets.bytes) < ? OR (sum(buckets.bytes) = ? AND users.username > ?)`
		args = append(args, cursor.Bytes, cursor.Bytes, cursor.Username)
	}
	query += ` ORDER BY sum(buckets.bytes) DESC,users.username ASC LIMIT ?`
	args = append(args, limit)
	rows, err := r.tx.QueryContext(r.ctx, query, args...)
	if err != nil {
		return nil, coverage, fmt.Errorf("rank traffic snapshot: %w", historySQLContextError(r.ctx, err))
	}
	defer rows.Close()
	for rows.Next() {
		var rank UserTrafficRank
		if err := rows.Scan(&rank.Username, &rank.Bytes); err != nil {
			return nil, coverage, err
		}
		summary := summaries[rank.Username]
		rank.ObservedTotal = summary.ObservedTotalBytes
		rank.CurrentMonth = summary.CurrentMonthBytes
		rank.DeletedEpochSecs = summary.DeletedEpochSecs
		rank.Continuity = summary.Continuity
		ranks = append(ranks, rank)
	}
	if err := rows.Err(); err != nil {
		return nil, coverage, historySQLContextError(r.ctx, err)
	}
	return ranks, coverage, nil
}
