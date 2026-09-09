// Package sqlstore contains the database/sql implementation used by SQLite.
package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

var identifierPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Upsert builds the identifier-safe SQLite INSERT ... ON CONFLICT statement
// used by metric aggregation. Values use SQLite's question-mark parameters.
func Upsert(table string, keyCols, updateCols []string) string {
	columns := append(append([]string(nil), keyCols...), updateCols...)
	if !identifierPattern.MatchString(table) || len(columns) == 0 {
		panic("sqlstore: invalid upsert identifier")
	}
	placeholders := make([]string, len(columns))
	for i, column := range columns {
		if !identifierPattern.MatchString(column) {
			panic("sqlstore: invalid upsert identifier")
		}
		placeholders[i] = "?"
	}
	prefix := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(columns, ", "), strings.Join(placeholders, ", "))
	if len(updateCols) == 0 {
		return prefix + " ON CONFLICT (" + strings.Join(keyCols, ", ") + ") DO NOTHING"
	}
	assignments := make([]string, len(updateCols))
	for i, column := range updateCols {
		if !identifierPattern.MatchString(column) {
			panic("sqlstore: invalid upsert identifier")
		}
		assignments[i] = column + " = excluded." + column
	}
	return prefix + " ON CONFLICT (" + strings.Join(keyCols, ", ") + ") DO UPDATE SET " + strings.Join(assignments, ", ")
}

// WithTx runs fn in one transaction, rolling back on every error or panic.
func WithTx(ctx context.Context, db *sql.DB, options *sql.TxOptions, fn func(*sql.Tx) error) (err error) {
	tx, err := db.BeginTx(ctx, options)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			_ = tx.Rollback()
			panic(recovered)
		}
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if err = fn(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}
