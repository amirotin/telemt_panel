//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

const userIPSnapshotChunkRows = 5000

// ReadUserIPSnapshot reads bounded pages while retaining the epoch and policy barrier.
func (s *SQLite) ReadUserIPSnapshot(ctx context.Context, from, now int64) (UserIPReadSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return UserIPReadSnapshot{}, err
	}
	if err := validateSnapshotRange(from, now); err != nil {
		return UserIPReadSnapshot{}, err
	}
	// Resets, imports and policy changes wait for every page. Ordinary collection
	// writes can use the sole database connection between read transactions.
	if err := lockSnapshot(ctx, s.userIPMu.TryRLock); err != nil {
		return UserIPReadSnapshot{}, err
	}
	defer s.userIPMu.RUnlock()
	out := UserIPReadSnapshot{Records: []UserIPRecord{}, Retention: s.UserIPRetention(), Durable: true, Epoch: s.userIPEpoch.Load()}
	from = max(from, now-int64(out.Retention/time.Second))
	revision := s.userIPRevision.Load()
	markPartial := func() {
		out.Partial = out.Partial || s.userIPWriters.Load() != 0 || s.userIPRevision.Load() != revision
	}
	var cursor *UserIPRecord
	for len(out.Records) <= UserIPSQLiteLimit {
		markPartial()
		limit := min(userIPSnapshotChunkRows, UserIPSQLiteLimit+1-len(out.Records))
		page, collection, future, err := s.readUserIPSnapshotPage(ctx, from, now, cursor, limit)
		if err != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			return UserIPReadSnapshot{}, err
		}
		markPartial()
		if cursor == nil {
			out.Collection = collection
			out.Collection.Gap = out.Collection.Gap || future
		}
		out.Records = append(out.Records, page...)
		if len(page) < limit || len(out.Records) > UserIPSQLiteLimit {
			break
		}
		last := page[len(page)-1]
		cursor = &last
	}
	out.Truncated = len(out.Records) > UserIPSQLiteLimit
	if out.Truncated {
		out.Records = out.Records[:UserIPSQLiteLimit]
	}
	sort.Slice(out.Records, func(i, j int) bool { return recordBefore(out.Records[i], out.Records[j]) })
	markPartial()
	if err := ctx.Err(); err != nil {
		return UserIPReadSnapshot{}, err
	}
	return out, nil
}

func (s *SQLite) readUserIPSnapshotPage(ctx context.Context, from, now int64, cursor *UserIPRecord, limit int) ([]UserIPRecord, UserIPCollection, bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, UserIPCollection{}, false, err
	}
	defer tx.Rollback()
	var collection UserIPCollection
	var future bool
	if cursor == nil {
		if collection, err = readUserIPCollection(tx); err != nil {
			return nil, UserIPCollection{}, false, err
		}
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_ip_history WHERE last_ts>?)", now).Scan(&future); err != nil {
			return nil, UserIPCollection{}, false, err
		}
	}
	page := make([]UserIPRecord, 0, limit)
	read := func(where string, args ...any) (err error) {
		args = append(args, limit-len(page))
		rows, err := tx.QueryContext(ctx, "SELECT username,ip,family,first_ts,last_ts,observations,last_active_ts,source FROM user_ip_history WHERE "+where+" ORDER BY last_ts DESC,username ASC,ip ASC LIMIT ?", args...)
		if err != nil {
			return err
		}
		defer func() { err = errors.Join(err, rows.Close()) }()
		for rows.Next() {
			var r UserIPRecord
			if err = rows.Scan(&r.Username, &r.IP, &r.Family, &r.First, &r.Last, &r.Observations, &r.LastActive, &r.Source); err != nil {
				return err
			}
			page = append(page, r)
		}
		return rows.Err()
	}
	if cursor == nil {
		if err = read("last_ts>=? AND last_ts<=?", from, now); err != nil {
			return nil, UserIPCollection{}, false, err
		}
	} else {
		// Seek directly within a timestamp tie before filling from older timestamps.
		// An OR over both ranges would rescan the preceding keys on every page.
		if err = read("last_ts=? AND (username,ip)>(?,?)", cursor.Last, cursor.Username, cursor.IP); err != nil {
			return nil, UserIPCollection{}, false, err
		}
		if len(page) < limit && cursor.Last > from {
			if err = read("last_ts>=? AND last_ts<?", from, cursor.Last); err != nil {
				return nil, UserIPCollection{}, false, err
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, UserIPCollection{}, false, err
	}
	return page, collection, future, nil
}

// UserIPEpoch identifies committed resets, policy changes and history imports.
func (s *SQLite) UserIPEpoch() uint64 {
	return s.userIPEpoch.Load()
}
