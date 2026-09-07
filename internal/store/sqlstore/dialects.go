package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
)

type SQLiteDialect struct{}

func (SQLiteDialect) Name() string             { return "sqlite" }
func (SQLiteDialect) Placeholder(int) string   { return "?" }
func (SQLiteDialect) Bind(query string) string { return query }
func (SQLiteDialect) AutoIncrement() string    { return "INTEGER PRIMARY KEY AUTOINCREMENT" }
func (SQLiteDialect) TimeType() string         { return "INTEGER" }
func (SQLiteDialect) BlobType() string         { return "BLOB" }
func (SQLiteDialect) TxLock() string           { return "" }
func (d SQLiteDialect) Upsert(table string, keys, updates []string) string {
	prefix := insertPrefix(d, table, keys, updates)
	if len(updates) == 0 {
		return prefix + " ON CONFLICT (" + strings.Join(keys, ", ") + ") DO NOTHING"
	}
	return prefix + " ON CONFLICT (" + strings.Join(keys, ", ") + ") DO UPDATE SET " +
		updateAssignments(updates, func(column string) string { return "excluded." + column })
}
func (SQLiteDialect) SchemaVersion(ctx context.Context, tx *sql.Tx) (int, error) {
	var version int
	if err := tx.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		return 0, fmt.Errorf("read sqlite schema version: %w", err)
	}
	return version, nil
}
func (SQLiteDialect) SetSchemaVersion(ctx context.Context, tx *sql.Tx, version int) error {
	if version < 0 {
		return fmt.Errorf("invalid sqlite schema version %d", version)
	}
	_, err := tx.ExecContext(ctx, `PRAGMA user_version = `+strconv.Itoa(version))
	return err
}
func (SQLiteDialect) SetMigrationDirty(context.Context, *sql.Tx, bool) error { return nil }
