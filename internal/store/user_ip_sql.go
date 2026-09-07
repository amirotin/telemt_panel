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
	return s.withUserIPTx(func(tx *sql.Tx) error {
		_, err := tx.Exec("DELETE FROM user_ip_history WHERE last_ts < ?", now-int64(s.UserIPRetention()/time.Second))
		return err
	})
}

// A bounded transaction also bounds shutdown when a final batch is flushed.
func (s *SQLite) withUserIPTx(fn func(*sql.Tx) error) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func readUserIPCollection(tx *sql.Tx) (UserIPCollection, error) {
	var c UserIPCollection
	err := tx.QueryRow("SELECT batch_id,since_ts,through_ts,limited,gap FROM user_ip_history_collection WHERE singleton=1").Scan(&c.BatchID, &c.Since, &c.Through, &c.Limited, &c.Gap)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return c, err
}

func exportUserIPs(tx *sql.Tx, cutoff int64) ([]UserIPRecord, *UserIPCollection, error) {
	c, err := readUserIPCollection(tx)
	if err != nil {
		return nil, nil, err
	}
	rows, err := tx.Query("SELECT username,ip,family,first_ts,last_ts,observations,last_active_ts,source FROM user_ip_history WHERE last_ts>=? ORDER BY username,ip", cutoff)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	result := []UserIPRecord{}
	for rows.Next() {
		var r UserIPRecord
		if err := rows.Scan(&r.Username, &r.IP, &r.Family, &r.First, &r.Last, &r.Observations, &r.LastActive, &r.Source); err != nil {
			return nil, nil, err
		}
		result = append(result, r)
	}
	return result, portableUserIPCollection(c), rows.Err()
}

func writeUserIPCollection(tx *sql.Tx, c UserIPCollection) error {
	_, err := tx.Exec(`INSERT INTO user_ip_history_collection(singleton,batch_id,since_ts,through_ts,limited,gap) VALUES(1,?,?,?,?,?)
	ON CONFLICT(singleton) DO UPDATE SET batch_id=excluded.batch_id,since_ts=excluded.since_ts,through_ts=excluded.through_ts,limited=excluded.limited,gap=excluded.gap`, c.BatchID, c.Since, c.Through, c.Limited, c.Gap)
	return err
}

func (s *SQLite) ApplyUserIPBatch(b UserIPBatch) error {
	if err := validateUserIPBatch(b); err != nil {
		return err
	}
	return s.withUserIPTx(func(tx *sql.Tx) error {
		c, err := readUserIPCollection(tx)
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
		if _, err := tx.Exec("DELETE FROM user_ip_history WHERE last_ts < ?", b.Through-int64(s.UserIPRetention()/time.Second)); err != nil {
			return err
		}
		stmt, err := tx.Prepare(`INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(username,ip) DO UPDATE SET first_ts=min(first_ts,excluded.first_ts),last_ts=max(last_ts,excluded.last_ts),
		observations=CASE WHEN observations>9223372036854775807-excluded.observations THEN 9223372036854775807 ELSE observations+excluded.observations END,
		last_active_ts=max(last_active_ts,excluded.last_active_ts),source=CASE WHEN excluded.last_ts>=last_ts THEN excluded.source ELSE source END`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		users := make(map[string]bool)
		for _, r := range b.Records {
			if _, err := stmt.Exec(r.Username, r.IP, r.Family, r.First, r.Last, r.Observations, r.LastActive, r.Source); err != nil {
				return err
			}
			users[r.Username] = true
		}
		// Expiration is indexed; it never scans the retained address payloads.
		if _, err := tx.Exec("DELETE FROM user_ip_history WHERE last_ts < ?", b.Through-int64(s.UserIPRetention()/time.Second)); err != nil {
			return err
		}
		c = nextUserIPCollection(c, b)
		for username := range users {
			result, err := tx.Exec(`DELETE FROM user_ip_history WHERE username=? AND ip IN
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
		if err := tx.QueryRow("SELECT count(*) FROM user_ip_history").Scan(&count); err != nil {
			return err
		}
		if count > UserIPSQLiteLimit {
			if _, err := tx.Exec(`DELETE FROM user_ip_history WHERE (username,ip) IN (SELECT username,ip FROM user_ip_history ORDER BY last_ts,username,ip LIMIT ?)`, count-UserIPSQLiteLimit); err != nil {
				return err
			}
			c.Limited = true
		}
		return writeUserIPCollection(tx, c)
	})
}

func (s *SQLite) UserIPHistory(q UserIPQuery) (UserIPPage, error) {
	page := UserIPPage{Items: []UserIPRecord{}}
	if err := validateUserIPQuery(q); err != nil {
		return page, err
	}
	err := s.withUserIPTx(func(tx *sql.Tx) error {
		from := max(q.From, q.Now-int64(s.UserIPRetention()/time.Second))
		where := "username=? AND last_ts>=?"
		args := []any{q.Username, from}
		if err := tx.QueryRow("SELECT count(*),coalesce(sum(first_ts>=?),0) FROM user_ip_history WHERE "+where, q.From, q.Username, from).Scan(&page.Total, &page.New); err != nil {
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
		if err := tx.QueryRow("SELECT count(*) FROM user_ip_history WHERE "+where, args...).Scan(&page.Matched); err != nil {
			return err
		}
		if q.Before != 0 {
			where += " AND (last_ts<? OR (last_ts=? AND ip>?))"
			args = append(args, q.Before, q.Before, q.AfterIP)
		}
		args = append(args, q.Limit+1)
		rows, err := tx.Query("SELECT username,ip,family,first_ts,last_ts,observations,last_active_ts,source FROM user_ip_history WHERE "+where+" ORDER BY last_ts DESC,ip ASC LIMIT ?", args...)
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
	result := make(map[string]int64)
	err := s.withUserIPTx(func(tx *sql.Tx) error {
		rows, err := tx.Query("SELECT username,count(*) FROM user_ip_history WHERE last_ts>=? GROUP BY username", max(from, now-int64(s.UserIPRetention()/time.Second)))
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
	var c UserIPCollection
	err := s.withUserIPTx(func(tx *sql.Tx) error { var err error; c, err = readUserIPCollection(tx); return err })
	return c, err
}

func (s *SQLite) ResetUserIPHistory(username string) error {
	return s.withUserIPTx(func(tx *sql.Tx) error {
		if username != "" {
			_, err := tx.Exec("DELETE FROM user_ip_history WHERE username=?", username)
			return err
		}
		if _, err := tx.Exec("DELETE FROM user_ip_history"); err != nil {
			return err
		}
		_, err := tx.Exec("UPDATE user_ip_history_collection SET since_ts=0,limited=0,gap=0")
		return err
	})
}
