package sqlstore

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"strings"
)

//go:embed migrations/*/*.sql
var migrationFiles embed.FS

const (
	statementSeparator         = "-- statement"
	sqliteSchemaVersion        = 11
	sqliteBaselineMigrationSQL = "migrations/sqlite/0011_baseline.sql"
)

// UnsupportedSchemaError reports a SQLite schema which this development
// baseline cannot open without an explicitly supported future upgrade.
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

// Migrate initializes an empty SQLite history store at the sole supported
// schema baseline. Development schemas are deliberately not converted.
func Migrate(ctx context.Context, db *sql.DB, dialect Dialect) (int, error) {
	if dialect.Name() != "sqlite" {
		return 0, fmt.Errorf("unsupported store dialect %q", dialect.Name())
	}
	baseline, err := migrationFiles.ReadFile(sqliteBaselineMigrationSQL)
	if err != nil {
		return 0, fmt.Errorf("read SQLite baseline: %w", err)
	}
	version := 0
	err = WithTx(ctx, db, nil, func(tx *sql.Tx) error {
		current, err := dialect.SchemaVersion(ctx, tx)
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
		case current != 0:
			return &UnsupportedSchemaError{
				Current: current, Supported: sqliteSchemaVersion,
				Reason: "an unsupported development schema",
			}
		}

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
		for _, statement := range strings.Split(string(baseline), statementSeparator) {
			statement = strings.TrimSpace(statement)
			if statement == "" {
				continue
			}
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("apply SQLite schema baseline: %w", err)
			}
		}
		if err := dialect.SetSchemaVersion(ctx, tx, sqliteSchemaVersion); err != nil {
			return fmt.Errorf("set SQLite schema baseline version: %w", err)
		}
		version = sqliteSchemaVersion
		return nil
	})
	if err != nil {
		return 0, err
	}
	return version, nil
}
