package sqlstore

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

func TestUpsertSQL(t *testing.T) {
	want := "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
	if got := Upsert("settings", []string{"key"}, []string{"value"}); got != want {
		t.Fatalf("Upsert = %q, want %q", got, want)
	}
}

func TestUpsertRejectsUnsafeIdentifiers(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("unsafe identifier did not panic")
		}
	}()
	Upsert("settings; DROP TABLE sessions", []string{"key"}, []string{"value"})
}

func TestUpsertWithoutUpdates(t *testing.T) {
	want := "INSERT INTO locks (name) VALUES (?) ON CONFLICT (name) DO NOTHING"
	if got := Upsert("locks", []string{"name"}, nil); got != want {
		t.Fatalf("Upsert without updates = %q, want %q", got, want)
	}
}

func TestWithTxRollsBackOnError(t *testing.T) {
	db := openTestDB(t)
	want := errors.New("stop transaction")
	err := WithTx(context.Background(), db, nil, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO entries(value) VALUES ('error')`); err != nil {
			return err
		}
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("WithTx error = %v, want %v", err, want)
	}
	assertEntryCount(t, db, 0)
}

func TestWithTxRollsBackOnPanic(t *testing.T) {
	db := openTestDB(t)
	want := errors.New("panic transaction")
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		_ = WithTx(context.Background(), db, nil, func(tx *sql.Tx) error {
			if _, err := tx.Exec(`INSERT INTO entries(value) VALUES ('panic')`); err != nil {
				return err
			}
			panic(want)
		})
	}()
	if recovered != want {
		t.Fatalf("WithTx recovered = %v, want %v", recovered, want)
	}
	assertEntryCount(t, db, 0)
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sqlitedriver.Open("file:" + filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE entries(value TEXT)`); err != nil {
		t.Fatal(err)
	}
	return db
}

func assertEntryCount(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow(`SELECT count(*) FROM entries`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("entry count = %d, want %d", got, want)
	}
}
