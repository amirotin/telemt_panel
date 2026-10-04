//go:build !lite

package store

import (
	"context"
	"database/sql"
	"time"
)

// ReadUserIPSnapshot reads records, collection and retention as one bounded version.
func (s *SQLite) ReadUserIPSnapshot(ctx context.Context, from, now int64) (UserIPReadSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return UserIPReadSnapshot{}, err
	}
	if err := validateSnapshotRange(from, now); err != nil {
		return UserIPReadSnapshot{}, err
	}
	// Mutations take this barrier before starting their transaction. Policy reads
	// follow userIPMu -> policyMu; no database transaction escapes this method.
	if err := lockSnapshot(ctx, s.userIPMu.TryRLock); err != nil {
		return UserIPReadSnapshot{}, err
	}
	defer s.userIPMu.RUnlock()
	out := UserIPReadSnapshot{Records: []UserIPRecord{}, Retention: s.UserIPRetention(), Durable: true, Epoch: s.userIPEpoch.Load()}
	from = max(from, now-int64(out.Retention/time.Second))
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return UserIPReadSnapshot{}, err
	}
	defer tx.Rollback()
	if out.Collection, err = readUserIPCollection(tx); err != nil {
		return UserIPReadSnapshot{}, err
	}
	var future bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_ip_history WHERE last_ts>?)", now).Scan(&future); err != nil {
		return UserIPReadSnapshot{}, err
	}
	out.Collection.Gap = out.Collection.Gap || future
	rows, err := tx.QueryContext(ctx, "SELECT username,ip,family,first_ts,last_ts,observations,last_active_ts,source FROM user_ip_history WHERE last_ts>=? AND last_ts<=? ORDER BY username,ip LIMIT ?", from, now, UserIPSQLiteLimit+1)
	if err != nil {
		return UserIPReadSnapshot{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var r UserIPRecord
		if err = rows.Scan(&r.Username, &r.IP, &r.Family, &r.First, &r.Last, &r.Observations, &r.LastActive, &r.Source); err != nil {
			return UserIPReadSnapshot{}, err
		}
		if len(out.Records) == UserIPSQLiteLimit {
			out.Truncated = true
			break
		}
		out.Records = append(out.Records, r)
	}
	if err = rows.Err(); err != nil {
		return UserIPReadSnapshot{}, err
	}
	if err = rows.Close(); err != nil {
		return UserIPReadSnapshot{}, err
	}
	if err = tx.Commit(); err != nil {
		return UserIPReadSnapshot{}, err
	}
	return out, nil
}

// UserIPEpoch identifies committed resets, policy changes and history imports.
func (s *SQLite) UserIPEpoch() uint64 {
	return s.userIPEpoch.Load()
}
