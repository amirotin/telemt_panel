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

type PostgresDialect struct{}

func (PostgresDialect) Name() string             { return "postgres" }
func (PostgresDialect) Placeholder(i int) string { return "$" + strconv.Itoa(i) }
func (d PostgresDialect) Bind(query string) string {
	return bindQuestionMarks(query, d.Placeholder)
}
func (PostgresDialect) AutoIncrement() string { return "BIGSERIAL PRIMARY KEY" }
func (PostgresDialect) TimeType() string      { return "BIGINT" }
func (PostgresDialect) BlobType() string      { return "BYTEA" }
func (PostgresDialect) TxLock() string        { return " FOR UPDATE" }
func (d PostgresDialect) Upsert(table string, keys, updates []string) string {
	prefix := insertPrefix(d, table, keys, updates)
	if len(updates) == 0 {
		return prefix + " ON CONFLICT (" + strings.Join(keys, ", ") + ") DO NOTHING"
	}
	return prefix + " ON CONFLICT (" + strings.Join(keys, ", ") + ") DO UPDATE SET " +
		updateAssignments(updates, func(column string) string { return "EXCLUDED." + column })
}

type MySQLDialect struct{}

func (MySQLDialect) Name() string             { return "mysql" }
func (MySQLDialect) Placeholder(int) string   { return "?" }
func (MySQLDialect) Bind(query string) string { return query }
func (MySQLDialect) AutoIncrement() string    { return "BIGINT AUTO_INCREMENT PRIMARY KEY" }
func (MySQLDialect) TimeType() string         { return "BIGINT" }
func (MySQLDialect) BlobType() string         { return "BLOB" }
func (MySQLDialect) TxLock() string           { return " FOR UPDATE" }
func (d MySQLDialect) Upsert(table string, keys, updates []string) string {
	prefix := insertPrefix(d, table, keys, updates)
	if len(updates) == 0 {
		return strings.Replace(prefix, "INSERT INTO ", "INSERT IGNORE INTO ", 1)
	}
	return prefix + " ON DUPLICATE KEY UPDATE " +
		updateAssignments(updates, func(column string) string { return "VALUES(" + column + ")" })
}

func networkSchemaVersion(ctx context.Context, tx *sql.Tx, dialect Dialect, createTable string) (int, error) {
	if _, err := tx.ExecContext(ctx, createTable); err != nil {
		return 0, fmt.Errorf("ensure schema version table: %w", err)
	}
	if _, err := tx.ExecContext(ctx, dialect.Upsert("schema_version", []string{"id"}, nil), 1); err != nil {
		return 0, fmt.Errorf("initialize schema version: %w", err)
	}
	var version int
	err := tx.QueryRowContext(ctx, `SELECT version FROM schema_version WHERE id = 1`+dialect.TxLock()).Scan(&version)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return version, err
}

func setNetworkSchemaVersion(ctx context.Context, tx *sql.Tx, dialect Dialect, version int) error {
	query := dialect.Upsert("schema_version", []string{"id"}, []string{"version"})
	_, err := tx.ExecContext(ctx, query, 1, version)
	return err
}

func (d PostgresDialect) SchemaVersion(ctx context.Context, tx *sql.Tx) (int, error) {
	return networkSchemaVersion(ctx, tx, d, `CREATE TABLE IF NOT EXISTS schema_version (
		id SMALLINT PRIMARY KEY CHECK (id = 1),
		version INTEGER NOT NULL DEFAULT 0
	)`)
}
func (PostgresDialect) SetMigrationDirty(context.Context, *sql.Tx, bool) error { return nil }
func (d PostgresDialect) SetSchemaVersion(ctx context.Context, tx *sql.Tx, version int) error {
	return setNetworkSchemaVersion(ctx, tx, d, version)
}
func (d MySQLDialect) SchemaVersion(ctx context.Context, tx *sql.Tx) (int, error) {
	version, err := networkSchemaVersion(ctx, tx, d, `CREATE TABLE IF NOT EXISTS schema_version (
		id TINYINT PRIMARY KEY,
		version INTEGER NOT NULL DEFAULT 0,
		dirty BOOLEAN NOT NULL DEFAULT FALSE
	)`)
	if err != nil {
		return 0, err
	}
	var dirty bool
	if err := tx.QueryRowContext(ctx, `SELECT dirty FROM schema_version WHERE id = 1`+d.TxLock()).Scan(&dirty); err != nil {
		return 0, err
	}
	if dirty {
		return 0, fmt.Errorf("mysql store has an incomplete migration and requires manual recovery")
	}
	return version, nil
}
func (MySQLDialect) SetMigrationDirty(ctx context.Context, tx *sql.Tx, dirty bool) error {
	_, err := tx.ExecContext(ctx, `UPDATE schema_version SET dirty = ? WHERE id = 1`, dirty)
	return err
}
func (d MySQLDialect) SetSchemaVersion(ctx context.Context, tx *sql.Tx, version int) error {
	return setNetworkSchemaVersion(ctx, tx, d, version)
}
