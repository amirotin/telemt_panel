//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// CheckConnection verifies a network DSN without creating tables or running
// migrations. It is used by the installer before it changes panel config.
func CheckConnection(driver, dsn string) error {
	var sqlDriver string
	switch driver {
	case "postgres":
		sqlDriver = "pgx"
	case "mysql":
		sqlDriver = "mysql"
	default:
		return &UnknownDriverError{Driver: driver}
	}
	if dsn == "" {
		return errors.New("database DSN is empty")
	}
	db, err := sql.Open(sqlDriver, dsn)
	if err != nil {
		return errors.New("database connection configuration is invalid")
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return &ConnectionUnavailableError{Driver: driver}
	}
	return nil
}
