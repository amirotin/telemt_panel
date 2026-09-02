//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
)

const networkStoreConnectTimeout = 10 * time.Second

func init() {
	Register("postgres", func(options OpenOptions) (Store, error) {
		return newNetworkStore("pgx", options.DSN, options.MirrorPath, sqlstore.PostgresDialect{})
	})
	Register("mysql", func(options OpenOptions) (Store, error) {
		return newNetworkStore("mysql", options.DSN, options.MirrorPath, sqlstore.MySQLDialect{})
	})
}

func newNetworkStore(sqlDriver, dsn, mirrorPath string, dialect sqlstore.Dialect) (*SQLite, error) {
	if dsn == "" {
		return nil, errors.New("database DSN is empty")
	}
	db, err := sql.Open(sqlDriver, dsn)
	if err != nil {
		return nil, errors.New("database connection configuration is invalid")
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), networkStoreConnectTimeout)
	if err := db.PingContext(ctx); err != nil {
		cancel()
		db.Close()
		return nil, &ConnectionUnavailableError{Driver: dialect.Name()}
	}
	cancel()

	opened := newSQLStore(db, dialect, dialect.Name(), "", true)
	migrationCtx, cancelMigration := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelMigration()
	if err := opened.initializeSQL(migrationCtx); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize database: %w", err)
	}
	if err := opened.importMirror(mirrorPath); err != nil {
		db.Close()
		return nil, fmt.Errorf("import memory mirror: %w", err)
	}
	if err := opened.loadPolicies(); err != nil {
		db.Close()
		return nil, err
	}
	return opened, nil
}
