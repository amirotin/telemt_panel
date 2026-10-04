package sqlstore

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"strconv"
	"strings"
)

//go:embed migrations/*/*.sql
var migrationFiles embed.FS

const (
	statementSeparator         = "-- statement"
	sqliteSchemaVersion        = 12
	sqliteBaselineVersion      = 11
	sqliteBaselineMigrationSQL = "migrations/sqlite/0011_baseline.sql"
	sqliteSnapshotMigrationSQL = "migrations/sqlite/0012_user_ip_snapshot_index.sql"
)

// UnsupportedSchemaError reports a SQLite schema without a supported upgrade path.
type UnsupportedSchemaError struct {
	Current   int
	Supported int
	Reason    string
}

func (e *UnsupportedSchemaError) Error() string {
	if e.Current > e.Supported {
		return fmt.Sprintf("sqlite store schema %d is newer than supported schema %d", e.Current, e.Supported)
	}
	return fmt.Sprintf("sqlite store schema %d is %s (supported schema: %d)", e.Current, e.Reason, e.Supported)
}

// UnsupportedSchemaVersions exposes the rejected and supported versions to
// callers that must distinguish a version gate from runtime database failure.
func (e *UnsupportedSchemaError) UnsupportedSchemaVersions() (int, int) {
	return e.Current, e.Supported
}

// Migrate initializes the frozen SQLite baseline and applies supported upgrades.
// Earlier development schemas are deliberately not converted.
func Migrate(ctx context.Context, db *sql.DB) (int, error) {
	baseline, err := migrationFiles.ReadFile(sqliteBaselineMigrationSQL)
	if err != nil {
		return 0, fmt.Errorf("read SQLite baseline: %w", err)
	}
	snapshotIndex, err := migrationFiles.ReadFile(sqliteSnapshotMigrationSQL)
	if err != nil {
		return 0, fmt.Errorf("read SQLite snapshot index migration: %w", err)
	}
	version := 0
	err = WithTx(ctx, db, nil, func(tx *sql.Tx) error {
		current, err := readSQLiteSchemaVersion(ctx, tx)
		if err != nil {
			return err
		}
		version = current
		switch {
		case current == sqliteSchemaVersion:
			return nil
		case current > sqliteSchemaVersion:
			return &UnsupportedSchemaError{
				Current: current, Supported: sqliteSchemaVersion,
				Reason: "newer than supported",
			}
		case current != 0 && current != sqliteBaselineVersion:
			return &UnsupportedSchemaError{
				Current: current, Supported: sqliteSchemaVersion,
				Reason: "an unsupported development schema",
			}
		}

		migrations := [][]byte{snapshotIndex}
		if current == 0 {
			var hasUserObjects bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT 1 FROM sqlite_schema
			WHERE type IN ('table', 'view', 'trigger')
			  AND substr(name, 1, 7) != 'sqlite_'
		)`).Scan(&hasUserObjects); err != nil {
				return fmt.Errorf("inspect empty SQLite schema: %w", err)
			}
			if hasUserObjects {
				return &UnsupportedSchemaError{
					Current: 0, Supported: sqliteSchemaVersion,
					Reason: "unversioned and contains user schema objects",
				}
			}
			migrations = append([][]byte{baseline}, migrations...)
		}
		for _, migration := range migrations {
			for _, statement := range strings.Split(string(migration), statementSeparator) {
				statement = strings.TrimSpace(statement)
				if statement == "" {
					continue
				}
				if _, err := tx.ExecContext(ctx, statement); err != nil {
					return fmt.Errorf("apply SQLite schema migration: %w", err)
				}
			}
		}
		if err := setSQLiteSchemaVersion(ctx, tx, sqliteSchemaVersion); err != nil {
			return fmt.Errorf("set SQLite schema version: %w", err)
		}
		version = sqliteSchemaVersion
		return nil
	})
	if err != nil {
		return 0, err
	}
	return version, nil
}

func readSQLiteSchemaVersion(ctx context.Context, tx *sql.Tx) (int, error) {
	var version int
	if err := tx.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		return 0, fmt.Errorf("read sqlite schema version: %w", err)
	}
	return version, nil
}

func setSQLiteSchemaVersion(ctx context.Context, tx *sql.Tx, version int) error {
	if version < 0 {
		return fmt.Errorf("invalid sqlite schema version %d", version)
	}
	_, err := tx.ExecContext(ctx, `PRAGMA user_version = `+strconv.Itoa(version))
	return err
}
