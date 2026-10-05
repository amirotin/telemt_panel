//go:build !lite

package store

import (
	"context"
	"database/sql"
	"time"
)

func pruneTrafficSummariesTx(ctx context.Context, tx *sql.Tx, now int64, retention time.Duration) error {
	cutoff := now - int64(retention/time.Second)
	rows, err := tx.QueryContext(ctx, `SELECT id,deleted_ts,EXISTS(SELECT 1 FROM user_traffic_buckets WHERE user_id=user_traffic_users.id AND ts >= ?)
		FROM user_traffic_users WHERE deleted_ts IS NOT NULL AND deleted_ts < ?`, cutoff, cutoff)
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
		if _, err := tx.ExecContext(ctx, `DELETE FROM user_traffic_users WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return nil
}
