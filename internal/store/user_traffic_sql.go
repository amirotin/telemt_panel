//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

type storedUserTraffic struct {
	id              int64
	summary         UserTrafficSummary
	lastRaw         sql.NullInt64
	lastSourceStart sql.NullInt64
}

type userTrafficBucket struct {
	userID int64
	tier   int
	ts     int64
	bytes  int64
}

// ApplyUserTrafficSnapshot atomically advances baselines, totals and buckets
// for one coherent Telemt observation.
func (s *SQLite) ApplyUserTrafficSnapshot(snapshot UserTrafficSnapshot) (UserTrafficApplyResult, error) {
	return s.ApplyUserTrafficSnapshotContext(context.Background(), snapshot)
}

func (s *SQLite) ApplyUserTrafficSnapshotContext(parent context.Context, snapshot UserTrafficSnapshot) (UserTrafficApplyResult, error) {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	if err := validateUserTrafficSnapshot(snapshot); err != nil {
		return UserTrafficApplyResult{}, err
	}
	historyEnabled := s.policy(StorageUserTraffic).Enabled
	retention := retentionDuration(s.policy(StorageUserTraffic))
	var result UserTrafficApplyResult
	err := s.withOperationTxContext(ctx, func(tx *sql.Tx) error {
		collector, found, err := s.readUserTrafficCollectorTx(ctx, tx)
		if err != nil {
			return err
		}
		if found && snapshot.ObservedAt <= collector.LastSuccessTS {
			return fmt.Errorf("user traffic snapshot is stale: observed=%d last=%d", snapshot.ObservedAt, collector.LastSuccessTS)
		}

		continuity := nextUserTrafficContinuity(collector, found, snapshot)

		if err := pruneTrafficSummariesTx(ctx, tx, snapshot.ObservedAt, retention); err != nil {
			return err
		}
		stored, err := s.readUserTrafficUsersTx(ctx, tx)
		if err != nil {
			return err
		}
		seen := make(map[string]struct{}, len(snapshot.Users))
		buckets := make([]userTrafficBucket, 0, len(snapshot.Users)*3)
		monthKey := utcMonthKey(snapshot.ObservedAt)

		for _, observation := range snapshot.Users {
			seen[observation.Username] = struct{}{}
			raw, err := userTrafficInt64(observation.RawOctets)
			if err != nil {
				return fmt.Errorf("user %q: %w", observation.Username, err)
			}

			current, exists := stored[observation.Username]
			if !exists {
				if !snapshot.TelemetryEnabled {
					continue
				}
				current = storedUserTraffic{summary: UserTrafficSummary{
					Username:               observation.Username,
					MonthKey:               monthKey,
					ObservedSinceEpochSecs: snapshot.ObservedAt,
					Continuity:             continuity,
				}}
				id, err := s.insertUserTrafficBaselineTx(ctx, tx, current.summary, raw, snapshot.SourceStartedAt)
				if err != nil {
					return err
				}
				current.id = id
				current.lastRaw = sql.NullInt64{Int64: raw, Valid: true}
				current.lastSourceStart = sql.NullInt64{Int64: snapshot.SourceStartedAt, Valid: true}
				stored[observation.Username] = current
				continue
			}

			userContinuity := current.summary.Continuity
			if continuity == UserTrafficPartial {
				userContinuity = UserTrafficPartial
			}
			wasDeleted := current.summary.DeletedEpochSecs != 0
			continuityChanged := current.summary.Continuity != userContinuity
			if !snapshot.TelemetryEnabled {
				if wasDeleted || continuityChanged {
					current.summary.DeletedEpochSecs = 0
					current.summary.Continuity = userContinuity
					if err := s.updateUserTrafficSummaryTx(ctx, tx, current, current.lastRaw, current.lastSourceStart); err != nil {
						return err
					}
				}
				continue
			}

			delta := int64(0)
			if current.lastRaw.Valid && current.lastSourceStart.Valid {
				switch {
				case current.lastSourceStart.Int64 != snapshot.SourceStartedAt:
					delta = raw
				case raw < current.lastRaw.Int64:
					delta = raw
				default:
					delta = raw - current.lastRaw.Int64
				}
			}
			if delta > math.MaxInt64-current.summary.ObservedTotalBytes {
				return fmt.Errorf("user %q: accumulated traffic exceeds int64", observation.Username)
			}
			if delta > math.MaxInt64-result.DeltaBytes {
				return errors.New("user traffic snapshot delta exceeds int64")
			}
			if result.DeltaBytes > math.MaxInt64-delta {
				return errors.New("aggregate user traffic delta exceeds int64")
			}

			current.summary.ObservedTotalBytes += delta
			if current.summary.MonthKey != monthKey {
				current.summary.MonthKey = monthKey
				current.summary.CurrentMonthBytes = delta
			} else {
				if delta > math.MaxInt64-current.summary.CurrentMonthBytes {
					return fmt.Errorf("user %q: monthly traffic exceeds int64", observation.Username)
				}
				current.summary.CurrentMonthBytes += delta
			}
			if delta > 0 {
				current.summary.LastActivityEpochSecs = snapshot.ObservedAt
				result.DeltaBytes += delta
				if historyEnabled {
					buckets = appendUserTrafficBuckets(buckets, current.id, snapshot.ObservedAt, delta)
				}
			}
			current.summary.DeletedEpochSecs = 0
			current.summary.Continuity = userContinuity
			lastRaw := sql.NullInt64{Int64: raw, Valid: true}
			lastSource := sql.NullInt64{Int64: snapshot.SourceStartedAt, Valid: true}
			if delta > 0 || current.lastRaw != lastRaw || current.lastSourceStart != lastSource ||
				wasDeleted || continuityChanged {
				if err := s.updateUserTrafficSummaryTx(ctx, tx, current, lastRaw, lastSource); err != nil {
					return err
				}
			}
		}

		for username, current := range stored {
			if _, ok := seen[username]; ok || current.summary.DeletedEpochSecs != 0 {
				continue
			}
			if _, err := tx.ExecContext(ctx, `UPDATE user_traffic_users SET deleted_ts = ? WHERE id = ?`, snapshot.ObservedAt, current.id); err != nil {
				return fmt.Errorf("mark deleted user traffic: %w", err)
			}
		}
		if historyEnabled && len(buckets) > 0 {
			if err := s.upsertUserTrafficBucketsTx(ctx, tx, buckets); err != nil {
				return err
			}
		}

		sourceState := userTrafficSourceState(snapshot.TelemetryEnabled)
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_traffic_collector
			(singleton, last_success_ts, source_started_at, source_state, continuity)
			VALUES (1, ?, ?, ?, ?)
			ON CONFLICT(singleton) DO UPDATE SET
			last_success_ts = excluded.last_success_ts,
			source_started_at = excluded.source_started_at,
			source_state = excluded.source_state,
			continuity = excluded.continuity`, snapshot.ObservedAt, snapshot.SourceStartedAt, sourceState, continuity); err != nil {
			return fmt.Errorf("update user traffic collector: %w", err)
		}
		return pruneTrafficSummariesTx(ctx, tx, snapshot.ObservedAt, retention)
	})
	if err != nil {
		return UserTrafficApplyResult{}, fmt.Errorf("apply user traffic snapshot: %w", err)
	}
	return result, nil
}

func appendUserTrafficBuckets(rows []userTrafficBucket, userID, ts, bytes int64) []userTrafficBucket {
	for tier, width := range []int64{900, 3600, 86400} {
		rows = append(rows, userTrafficBucket{userID: userID, tier: tier, ts: ts - ts%width, bytes: bytes})
	}
	return rows
}

func (s *SQLite) readUserTrafficCollectorTx(ctx context.Context, tx *sql.Tx) (UserTrafficCollectorState, bool, error) {
	var state UserTrafficCollectorState
	err := tx.QueryRowContext(ctx, `SELECT last_success_ts, source_started_at, source_state, continuity
		FROM user_traffic_collector WHERE singleton = 1`).Scan(
		&state.LastSuccessTS, &state.SourceStartedAt, &state.SourceState, &state.Continuity,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return UserTrafficCollectorState{}, false, nil
	}
	if err != nil {
		return UserTrafficCollectorState{}, false, fmt.Errorf("read user traffic collector: %w", err)
	}
	return state, true, nil
}

func (s *SQLite) readUserTrafficUsersTx(ctx context.Context, tx *sql.Tx) (map[string]storedUserTraffic, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, username, total_bytes, since_ts, updated_ts,
		month_key, month_bytes, last_raw_octets, last_source_started_at, deleted_ts, continuity
		FROM user_traffic_users`)
	if err != nil {
		return nil, fmt.Errorf("read user traffic users: %w", err)
	}
	defer rows.Close()
	result := make(map[string]storedUserTraffic)
	for rows.Next() {
		var current storedUserTraffic
		var deleted sql.NullInt64
		if err := rows.Scan(
			&current.id,
			&current.summary.Username,
			&current.summary.ObservedTotalBytes,
			&current.summary.ObservedSinceEpochSecs,
			&current.summary.LastActivityEpochSecs,
			&current.summary.MonthKey,
			&current.summary.CurrentMonthBytes,
			&current.lastRaw,
			&current.lastSourceStart,
			&deleted,
			&current.summary.Continuity,
		); err != nil {
			return nil, fmt.Errorf("scan user traffic user: %w", err)
		}
		if deleted.Valid {
			current.summary.DeletedEpochSecs = deleted.Int64
		}
		result[current.summary.Username] = current
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user traffic users: %w", err)
	}
	return result, nil
}

func (s *SQLite) insertUserTrafficBaselineTx(ctx context.Context, tx *sql.Tx, summary UserTrafficSummary, raw, sourceStart int64) (int64, error) {
	result, err := tx.ExecContext(ctx, `INSERT INTO user_traffic_users
		(username, total_bytes, since_ts, updated_ts, month_key, month_bytes,
		 last_raw_octets, last_source_started_at, deleted_ts, continuity)
		VALUES (?, 0, ?, 0, ?, 0, ?, ?, NULL, ?)`,
		summary.Username, summary.ObservedSinceEpochSecs, summary.MonthKey, raw, sourceStart, summary.Continuity)
	if err != nil {
		return 0, fmt.Errorf("insert user traffic baseline: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("read user traffic id: %w", err)
	}
	return id, nil
}

func (s *SQLite) updateUserTrafficSummaryTx(ctx context.Context, tx *sql.Tx, current storedUserTraffic, raw, sourceStart sql.NullInt64) error {
	var deleted any
	if current.summary.DeletedEpochSecs != 0 {
		deleted = current.summary.DeletedEpochSecs
	}
	_, err := tx.ExecContext(ctx, `UPDATE user_traffic_users SET
		total_bytes = ?, updated_ts = ?, month_key = ?, month_bytes = ?,
		last_raw_octets = ?, last_source_started_at = ?, deleted_ts = ?, continuity = ?
		WHERE id = ?`,
		current.summary.ObservedTotalBytes,
		current.summary.LastActivityEpochSecs,
		current.summary.MonthKey,
		current.summary.CurrentMonthBytes,
		raw,
		sourceStart,
		deleted,
		current.summary.Continuity,
		current.id,
	)
	if err != nil {
		return fmt.Errorf("update user traffic summary: %w", err)
	}
	return nil
}

func (s *SQLite) upsertUserTrafficBucketsTx(ctx context.Context, tx *sql.Tx, rows []userTrafficBucket) error {
	for start := 0; start < len(rows); start += userTrafficBatchRows {
		end := min(start+userTrafficBatchRows, len(rows))
		var query strings.Builder
		query.WriteString(`INSERT INTO user_traffic_buckets (user_id, tier, ts, bytes) VALUES `)
		args := make([]any, 0, (end-start)*4)
		for index, row := range rows[start:end] {
			if index > 0 {
				query.WriteString(", ")
			}
			query.WriteString("(?, ?, ?, ?)")
			args = append(args, row.userID, row.tier, row.ts, row.bytes)
		}
		query.WriteString(` ON CONFLICT(user_id, tier, ts)
			DO UPDATE SET bytes = user_traffic_buckets.bytes + excluded.bytes`)
		if _, err := tx.ExecContext(ctx, query.String(), args...); err != nil {
			return fmt.Errorf("upsert user traffic buckets: %w", err)
		}
	}
	return nil
}

// UserTrafficSummaries returns every retained account summary keyed by username.
func (s *SQLite) UserTrafficSummaries() (map[string]UserTrafficSummary, error) {
	rows, err := s.query(`SELECT username, total_bytes, since_ts, updated_ts,
		month_key, month_bytes, deleted_ts, continuity FROM user_traffic_users`)
	if err != nil {
		return nil, fmt.Errorf("read user traffic summaries: %w", err)
	}
	defer rows.Close()
	currentMonth := utcMonthKey(time.Now().Unix())
	result := make(map[string]UserTrafficSummary)
	for rows.Next() {
		var summary UserTrafficSummary
		var deleted sql.NullInt64
		if err := rows.Scan(
			&summary.Username,
			&summary.ObservedTotalBytes,
			&summary.ObservedSinceEpochSecs,
			&summary.LastActivityEpochSecs,
			&summary.MonthKey,
			&summary.CurrentMonthBytes,
			&deleted,
			&summary.Continuity,
		); err != nil {
			return nil, fmt.Errorf("scan user traffic summary: %w", err)
		}
		if summary.MonthKey != currentMonth {
			summary.CurrentMonthBytes = 0
		}
		if deleted.Valid {
			summary.DeletedEpochSecs = deleted.Int64
		}
		result[summary.Username] = summary
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user traffic summaries: %w", err)
	}
	return result, nil
}

// UserTrafficCollectorState returns the last committed coherent observation.
func (s *SQLite) UserTrafficCollectorState() (UserTrafficCollectorState, error) {
	var state UserTrafficCollectorState
	err := s.queryRow(`SELECT last_success_ts, source_started_at, source_state, continuity
		FROM user_traffic_collector WHERE singleton = 1`).Scan(
		&state.LastSuccessTS, &state.SourceStartedAt, &state.SourceState, &state.Continuity,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return UserTrafficCollectorState{SourceState: UserTrafficUnavailable, Continuity: UserTrafficNormal}, nil
	}
	if err != nil {
		return UserTrafficCollectorState{}, fmt.Errorf("read user traffic collector state: %w", err)
	}
	return state, nil
}

// UserTrafficRange returns traffic selected by the shared interval planner.
func (s *SQLite) UserTrafficRange(username string, fromTS int64) ([]UserTrafficPoint, error) {
	r, err := s.BeginTrafficRead(context.Background())
	if err != nil {
		return nil, err
	}
	defer r.Close()
	points, _, err := r.Range(username, fromTS, r.AsOf())
	return points, err
}

func (s *SQLite) UserTrafficAggregate(fromTS, toTS int64) (int64, []UserTrafficPoint, error) {
	r, err := s.BeginTrafficRead(context.Background())
	if err != nil {
		return 0, nil, err
	}
	defer r.Close()
	total, points, _, err := r.Aggregate(fromTS, toTS)
	return total, points, err
}

func (s *SQLite) UserTrafficRanking(fromTS, toTS int64, includeDeleted bool, limit int, cursor *UserTrafficRankCursor) ([]UserTrafficRank, error) {
	r, err := s.BeginTrafficRead(context.Background())
	if err != nil {
		return nil, err
	}
	defer r.Close()
	ranks, _, err := r.Ranking(fromTS, toTS, includeDeleted, limit, cursor)
	return ranks, err
}

func userTrafficMetricTier(tier int) MetricTier {
	switch tier {
	case 0:
		return MetricTierQuarter
	case 1:
		return MetricTierHour
	default:
		return MetricTierDay
	}
}

// UserTrafficRetention reports the configured durable bucket retention.
func (s *SQLite) UserTrafficRetention() time.Duration {
	policy := s.policy(StorageUserTraffic)
	if !policy.Enabled {
		return 0
	}
	return retentionDuration(policy)
}

// DeleteUserHistory removes a user's totals, baseline and buckets.
func (s *SQLite) DeleteUserHistory(username string) error {
	return s.DeleteUserHistoryContext(context.Background(), username)
}

func (s *SQLite) DeleteUserHistoryContext(parent context.Context, username string) error {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	_, err := s.execContext(ctx, `DELETE FROM user_traffic_users WHERE username = ?`, username)
	return wrapSQLError("delete user history", err)
}

// ResetUserTraffic removes all accumulated user traffic and collector state.
// The next coherent snapshot establishes fresh baselines for every account.
func (s *SQLite) ResetUserTraffic() error {
	return s.ResetUserTrafficContext(context.Background())
}

func (s *SQLite) ResetUserTrafficContext(parent context.Context) error {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	return s.withOperationTxContext(ctx, func(tx *sql.Tx) error {
		for _, statement := range []string{
			`DELETE FROM user_traffic_buckets`,
			`DELETE FROM user_traffic_users`,
			`DELETE FROM user_traffic_collector`,
		} {
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("reset user traffic: %w", err)
			}
		}
		return nil
	})
}
