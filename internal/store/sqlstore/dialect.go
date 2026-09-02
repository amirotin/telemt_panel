// Package sqlstore contains the database/sql implementation shared by the
// SQLite, PostgreSQL and MySQL store drivers.
package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
)

// Dialect contains the small set of SQL differences used by the panel store.
type Dialect interface {
	Name() string
	Placeholder(i int) string
	Bind(string) string
	Upsert(table string, keyCols, updateCols []string) string
	AutoIncrement() string
	TimeType() string
	BlobType() string
	TxLock() string
	SchemaVersion(context.Context, *sql.Tx) (int, error)
	SetMigrationDirty(context.Context, *sql.Tx, bool) error
	SetSchemaVersion(context.Context, *sql.Tx, int) error
}

// Bind converts the driver's neutral ? placeholders to the dialect form.
// Store queries do not contain question marks in quoted strings, so this
// deliberately small binder is sufficient and keeps the shared SQL readable.
func bindQuestionMarks(query string, placeholder func(int) string) string {
	var out strings.Builder
	out.Grow(len(query) + 8)
	index := 1
	for _, char := range query {
		if char == '?' {
			out.WriteString(placeholder(index))
			index++
			continue
		}
		out.WriteRune(char)
	}
	return out.String()
}

var identifierPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func insertPrefix(d Dialect, table string, keyCols, updateCols []string) string {
	columns := append(append([]string(nil), keyCols...), updateCols...)
	if !identifierPattern.MatchString(table) || len(columns) == 0 {
		panic("sqlstore: invalid upsert identifier")
	}
	placeholders := make([]string, len(columns))
	for i, column := range columns {
		if !identifierPattern.MatchString(column) {
			panic("sqlstore: invalid upsert identifier")
		}
		placeholders[i] = d.Placeholder(i + 1)
	}
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(columns, ", "), strings.Join(placeholders, ", "))
}

func updateAssignments(columns []string, value func(string) string) string {
	out := make([]string, len(columns))
	for i, column := range columns {
		if !identifierPattern.MatchString(column) {
			panic("sqlstore: invalid upsert identifier")
		}
		out[i] = column + " = " + value(column)
	}
	return strings.Join(out, ", ")
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
