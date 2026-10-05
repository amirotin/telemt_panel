//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

func (s *SQLite) UserIPRetention() time.Duration {
	return time.Duration(s.policy(StorageUserIPHistory).RetentionDays) * 24 * time.Hour
}

func (s *SQLite) PruneUserIPHistory(now int64) error {
	return s.withUserIPWriteTx(func(tx *sql.Tx) error {
		_, err := tx.Exec("DELETE FROM user_ip_history WHERE last_ts < ?", now-int64(s.UserIPRetention()/time.Second))
		return err
	})
}

// A bounded transaction also bounds shutdown when a final batch is flushed.
func (s *SQLite) withUserIPTxContext(parent context.Context, fn func(*sql.Tx) error) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return historySQLContextError(ctx, err)
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return historySQLContextError(ctx, err)
	}
	return historySQLContextError(ctx, tx.Commit())
}

func (s *SQLite) withUserIPWriteTx(fn func(*sql.Tx) error) error {
	return s.withUserIPWriteTxContext(context.Background(), fn)
}
func (s *SQLite) withUserIPWriteTxContext(ctx context.Context, fn func(*sql.Tx) error) error {
	s.userIPWriters.Add(1)
	defer s.userIPWriters.Add(-1)
	err := s.withUserIPTxContext(ctx, fn)
	if err == nil {
		s.userIPRevision.Add(1)
	}
	return err
}

func readUserIPCollection(tx *sql.Tx) (UserIPCollection, error) {
	return readUserIPCollectionContext(context.Background(), tx)
}
func readUserIPCollectionContext(ctx context.Context, tx *sql.Tx) (UserIPCollection, error) {
	var c UserIPCollection
	err := tx.QueryRowContext(ctx, "SELECT batch_id,since_ts,through_ts,limited,gap FROM user_ip_history_collection WHERE singleton=1").Scan(&c.BatchID, &c.Since, &c.Through, &c.Limited, &c.Gap)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return c, err
}

func readPortableUserIPCollection(tx *sql.Tx) (*UserIPCollection, error) {
	c, err := readUserIPCollection(tx)
	if err != nil {
		return nil, err
	}
	return portableUserIPCollection(c), nil
}

func walkPortableUserIPs(tx *sql.Tx, cutoff int64, emit func(UserIPRecord) error) (err error) {
	rows, err := tx.Query("SELECT username,ip,family,first_ts,last_ts,observations,last_active_ts,source FROM user_ip_history WHERE last_ts>=? ORDER BY username,ip", cutoff)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	for rows.Next() {
		var r UserIPRecord
		if err := rows.Scan(&r.Username, &r.IP, &r.Family, &r.First, &r.Last, &r.Observations, &r.LastActive, &r.Source); err != nil {
			return err
		}
		if err := emit(r); err != nil {
			return err
		}
	}
	return rows.Err()
}

func writeUserIPCollection(tx *sql.Tx, c UserIPCollection) error {
	return writeUserIPCollectionContext(context.Background(), tx, c)
}
func writeUserIPCollectionContext(ctx context.Context, tx *sql.Tx, c UserIPCollection) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO user_ip_history_collection(singleton,batch_id,since_ts,through_ts,limited,gap) VALUES(1,?,?,?,?,?)
	ON CONFLICT(singleton) DO UPDATE SET batch_id=excluded.batch_id,since_ts=excluded.since_ts,through_ts=excluded.through_ts,limited=excluded.limited,gap=excluded.gap`, c.BatchID, c.Since, c.Through, c.Limited, c.Gap)
	return err
}

func (s *SQLite) ApplyUserIPBatch(b UserIPBatch) error {
	return s.ApplyUserIPBatchContext(context.Background(), b)
}

func (s *SQLite) ApplyUserIPBatchContext(parent context.Context, b UserIPBatch) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	if err := validateUserIPBatch(b); err != nil {
		return err
	}
	return s.withUserIPWriteTxContext(ctx, func(tx *sql.Tx) error {
		c, err := readUserIPCollectionContext(ctx, tx)
		if err != nil {
			return err
		}
		if b.ID == c.BatchID {
			return nil
		}
		if b.Through <= c.Through {
			return errors.New("stale user IP batch")
		}
		// Expire before merging so a returning address cannot revive old history.
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_ip_history WHERE last_ts < ?", b.Through-int64(s.UserIPRetention()/time.Second)); err != nil {
			return err
		}
		stmt, err := tx.PrepareContext(ctx, `INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(username,ip) DO UPDATE SET first_ts=min(first_ts,excluded.first_ts),last_ts=max(last_ts,excluded.last_ts),
		observations=CASE WHEN observations>9223372036854775807-excluded.observations THEN 9223372036854775807 ELSE observations+excluded.observations END,
		last_active_ts=max(last_active_ts,excluded.last_active_ts),source=CASE WHEN excluded.last_ts>=last_ts THEN excluded.source ELSE source END`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		users := make(map[string]bool)
		for _, r := range b.Records {
			if _, err := stmt.ExecContext(ctx, r.Username, r.IP, r.Family, r.First, r.Last, r.Observations, r.LastActive, r.Source); err != nil {
				return err
			}
			users[r.Username] = true
		}
		// Expiration is indexed; it never scans the retained address payloads.
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_ip_history WHERE last_ts < ?", b.Through-int64(s.UserIPRetention()/time.Second)); err != nil {
			return err
		}
		c = nextUserIPCollection(c, b)
		for username := range users {
			result, err := tx.ExecContext(ctx, `DELETE FROM user_ip_history WHERE username=? AND ip IN
			(SELECT ip FROM user_ip_history WHERE username=? ORDER BY last_ts DESC,ip DESC LIMIT -1 OFFSET ?)`, username, username, UserIPPerUserLimit)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			c.Limited = c.Limited || n > 0
		}
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM user_ip_history").Scan(&count); err != nil {
			return err
		}
		if count > UserIPSQLiteLimit {
			if _, err := tx.ExecContext(ctx, `DELETE FROM user_ip_history WHERE (username,ip) IN (SELECT username,ip FROM user_ip_history ORDER BY last_ts,username,ip LIMIT ?)`, count-UserIPSQLiteLimit); err != nil {
				return err
			}
			c.Limited = true
		}
		return writeUserIPCollectionContext(ctx, tx, c)
	})
}

func (s *SQLite) UserIPHistory(q UserIPQuery) (UserIPPage, error) {
	return s.UserIPHistoryContext(context.Background(), q)
}

// UserIPHistoryContext cancels the transaction and queries with the request.
func (s *SQLite) UserIPHistoryContext(parent context.Context, q UserIPQuery) (UserIPPage, error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	page := UserIPPage{Items: []UserIPRecord{}}
	if err := validateUserIPQuery(q); err != nil {
		return page, err
	}
	err := s.withUserIPTxContext(ctx, func(tx *sql.Tx) error {
		from := max(q.From, q.Now-int64(s.UserIPRetention()/time.Second))
		where := "username=? AND last_ts>=?"
		args := []any{q.Username, from}
		if err := tx.QueryRowContext(ctx, "SELECT count(*),coalesce(sum(first_ts>=?),0) FROM user_ip_history WHERE "+where, q.From, q.Username, from).Scan(&page.Total, &page.New); err != nil {
			return err
		}
		if q.Family != 0 {
			where += " AND family=?"
			args = append(args, q.Family)
		}
		if q.Search != "" {
			where += " AND ip LIKE ? ESCAPE '\\'"
			args = append(args, "%"+strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(strings.ToLower(q.Search))+"%")
		}
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM user_ip_history WHERE "+where, args...).Scan(&page.Matched); err != nil {
			return err
		}
		if q.Before != 0 {
			where += " AND (last_ts<? OR (last_ts=? AND ip>?))"
			args = append(args, q.Before, q.Before, q.AfterIP)
		}
		args = append(args, q.Limit+1)
		rows, err := tx.QueryContext(ctx, "SELECT username,ip,family,first_ts,last_ts,observations,last_active_ts,source FROM user_ip_history WHERE "+where+" ORDER BY last_ts DESC,ip ASC LIMIT ?", args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r UserIPRecord
			if err := rows.Scan(&r.Username, &r.IP, &r.Family, &r.First, &r.Last, &r.Observations, &r.LastActive, &r.Source); err != nil {
				return err
			}
			page.Items = append(page.Items, r)
		}
		page.HasMore = len(page.Items) > q.Limit
		if page.HasMore {
			page.Items = page.Items[:q.Limit]
		}
		return rows.Err()
	})
	return page, err
}

func (s *SQLite) UserIPSummaries(from, now int64) (map[string]int64, error) {
	return s.UserIPSummariesContext(context.Background(), from, now)
}

// UserIPSummariesContext keeps address aggregation in SQL under the caller's deadline.
func (s *SQLite) UserIPSummariesContext(parent context.Context, from, now int64) (map[string]int64, error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	result := make(map[string]int64)
	err := s.withUserIPTxContext(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, "SELECT username,count(*) FROM user_ip_history WHERE last_ts>=? GROUP BY username", max(from, now-int64(s.UserIPRetention()/time.Second)))
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var username string
			var n int64
			if err := rows.Scan(&username, &n); err != nil {
				return err
			}
			result[username] = n
		}
		return rows.Err()
	})
	return result, err
}

func (s *SQLite) UserIPCollectionState() (UserIPCollection, error) {
	return s.UserIPCollectionStateContext(context.Background())
}

// UserIPCollectionStateContext reads metadata under the caller's deadline.
func (s *SQLite) UserIPCollectionStateContext(parent context.Context) (UserIPCollection, error) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	var c UserIPCollection
	err := s.withUserIPTxContext(ctx, func(tx *sql.Tx) error { var err error; c, err = readUserIPCollectionContext(ctx, tx); return err })
	return c, err
}

func (s *SQLite) ResetUserIPHistory(username string) error {
	return s.ResetUserIPHistoryContext(context.Background(), username)
}

func (s *SQLite) ResetUserIPHistoryContext(parent context.Context, username string) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	if err := lockHistoryMutex(ctx, &s.userIPMu); err != nil {
		return err
	}
	defer s.userIPMu.Unlock()
	err := s.withUserIPTxContext(ctx, func(tx *sql.Tx) error {
		if username != "" {
			_, err := tx.ExecContext(ctx, "DELETE FROM user_ip_history WHERE username=?", username)
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_ip_history"); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "UPDATE user_ip_history_collection SET since_ts=0,limited=0,gap=0")
		return err
	})
	if err == nil {
		s.userIPEpoch.Add(1)
	}
	return err
}
