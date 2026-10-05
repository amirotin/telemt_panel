//go:build !lite

package store

import (
	"database/sql"
	"time"
)

func pruneTrafficSummariesTx(tx *sql.Tx, now int64, retention time.Duration) error {
	rows, err := tx.Query(`SELECT id,deleted_ts,EXISTS(SELECT 1 FROM user_traffic_buckets WHERE user_id=user_traffic_users.id)
		FROM user_traffic_users WHERE deleted_ts IS NOT NULL AND deleted_ts < ?`, now-int64(retention/time.Second))
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id, deleted int64
		var buckets bool
		if err := rows.Scan(&id, &deleted, &buckets); err != nil {
			rows.Close()
			return err
		}
		if expiredTrafficSummary(UserTrafficSummary{DeletedEpochSecs: deleted}, buckets, now, retention) {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.Exec(`DELETE FROM user_traffic_users WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return nil
}
