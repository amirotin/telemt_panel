package sqlstore

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/*/*.sql
var migrationFiles embed.FS

const statementSeparator = "-- statement"

// Migrate applies every embedded migration newer than the database schema.
// Each file is atomic and advances the dialect-specific schema version only
// after all of its statements succeed.
func Migrate(ctx context.Context, db *sql.DB, dialect Dialect) (int, error) {
	directory := "migrations/" + dialect.Name()
	entries, err := fs.ReadDir(migrationFiles, directory)
	if err != nil {
		return 0, fmt.Errorf("read %s migrations: %w", dialect.Name(), err)
	}
	type migration struct {
		version int
		name    string
	}
	migrations := make([]migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(entry.Name(), "_")
		if !ok {
			return 0, fmt.Errorf("invalid migration filename %q", entry.Name())
		}
		version, err := strconv.Atoi(prefix)
		if err != nil || version <= 0 {
			return 0, fmt.Errorf("invalid migration version in %q", entry.Name())
		}
		migrations = append(migrations, migration{version: version, name: entry.Name()})
	}
	sort.Slice(migrations, func(i, j int) bool { return migrations[i].version < migrations[j].version })
	for i := 1; i < len(migrations); i++ {
		if migrations[i-1].version == migrations[i].version {
			return 0, fmt.Errorf("duplicate %s migration version %d", dialect.Name(), migrations[i].version)
		}
	}
	latest := 0
	if len(migrations) > 0 {
		latest = migrations[len(migrations)-1].version
	}

	var current int
	if err := WithTx(ctx, db, nil, func(tx *sql.Tx) error {
		var err error
		current, err = dialect.SchemaVersion(ctx, tx)
		return err
	}); err != nil {
		return 0, err
	}
	if current > latest {
		return 0, fmt.Errorf("%s store schema %d is newer than supported schema %d", dialect.Name(), current, latest)
	}

	for _, migration := range migrations {
		if migration.version <= current {
			continue
		}
		body, err := migrationFiles.ReadFile(directory + "/" + migration.name)
		if err != nil {
			return 0, fmt.Errorf("read migration %s: %w", migration.name, err)
		}
		if err := WithTx(ctx, db, nil, func(tx *sql.Tx) error {
			if err := dialect.SetMigrationDirty(ctx, tx, true); err != nil {
				return fmt.Errorf("mark migration %s dirty: %w", migration.name, err)
			}
			for _, statement := range strings.Split(string(body), statementSeparator) {
				statement = strings.TrimSpace(statement)
				if statement == "" {
					continue
				}
				if _, err := tx.ExecContext(ctx, statement); err != nil {
					return fmt.Errorf("apply migration %s: %w", migration.name, err)
				}
			}
			if err := dialect.SetSchemaVersion(ctx, tx, migration.version); err != nil {
				return err
			}
			return dialect.SetMigrationDirty(ctx, tx, false)
		}); err != nil {
			return 0, err
		}
		current = migration.version
	}
	return current, nil
}
