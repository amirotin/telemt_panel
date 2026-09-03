//go:build !lite

package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

func TestSQLiteStoreContract(t *testing.T) {
	runStoreContract(t, func(t *testing.T) Store {
		history, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
		if err != nil {
			t.Fatal(err)
		}
		state, err := NewState(filepath.Join(t.TempDir(), "panel-state.json"))
		if err != nil {
			_ = history.Close()
			t.Fatal(err)
		}
		combined, err := NewComposite(state, history)
		if err != nil {
			_ = history.Close()
			_ = state.Close()
			t.Fatal(err)
		}
		return combined
	})
}

func TestPostgresStoreContract(t *testing.T) {
	runNetworkStoreContract(t, "postgres", "TP_TEST_POSTGRES_DSN")
}

func TestMySQLStoreContract(t *testing.T) {
	runNetworkStoreContract(t, "mysql", "TP_TEST_MYSQL_DSN")
}

func runNetworkStoreContract(t *testing.T, driver, environment string) {
	t.Helper()
	dsn := os.Getenv(environment)
	if dsn == "" {
		t.Skipf("%s is not set; use a disposable test database", environment)
	}
	var sqlBackend *SQLite
	st := runStoreContract(t, func(t *testing.T) Store {
		opened, err := Open(OpenOptions{Driver: driver, DSN: dsn})
		if err != nil {
			t.Fatal(err)
		}
		sqlBackend = opened.(*SQLite)
		assertHistoryOnlyNetworkSchema(t, sqlBackend, driver)
		if err := clearSQLStoreForTest(sqlBackend); err != nil {
			_ = opened.Close()
			t.Fatalf("reset %s contract database: %v", driver, err)
		}
		state, err := NewState("")
		if err != nil {
			_ = opened.Close()
			t.Fatal(err)
		}
		combined, err := NewComposite(state, opened)
		if err != nil {
			_ = opened.Close()
			_ = state.Close()
			t.Fatal(err)
		}
		return combined
	})

	t.Run("portable_import", func(t *testing.T) {
		point := MetricPoint{TS: time.Now().Unix(), Value: 73}
		if err := st.RecordMetric("connections", point); err != nil {
			t.Fatal(err)
		}
		portable := st.(PortableStore)
		before, err := portable.ExportData()
		if err != nil {
			t.Fatal(err)
		}
		if err := clearSQLStoreForTest(sqlBackend); err != nil {
			t.Fatal(err)
		}
		freshState, err := NewState("")
		if err != nil {
			t.Fatal(err)
		}
		fresh, err := NewComposite(freshState, sqlBackend)
		if err != nil {
			t.Fatal(err)
		}
		if err := fresh.ImportData(before); err != nil {
			t.Fatal(err)
		}
		after, err := fresh.ExportData()
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(after, before) {
			t.Fatalf("portable network round trip changed data\n got: %#v\nwant: %#v", after, before)
		}
	})
}

func assertHistoryOnlyNetworkSchema(t *testing.T, st *SQLite, driver string) {
	t.Helper()
	query := `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
	if driver == "mysql" {
		query = `SELECT table_name FROM information_schema.tables WHERE table_schema = database()`
	}
	rows, err := st.db.Query(query)
	if err != nil {
		t.Fatalf("inspect %s schema: %v", driver, err)
	}
	defer rows.Close()
	allowed := map[string]bool{
		"schema_version": true,
		"metric_points":  true,
		"history_events": true,
	}
	seen := make(map[string]bool, len(allowed))
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatal(err)
		}
		if !allowed[table] {
			t.Fatalf("non-history table %q leaked into %s database", table, driver)
		}
		seen[table] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for table := range allowed {
		if !seen[table] {
			t.Fatalf("history table %q missing from %s database", table, driver)
		}
	}
}

func clearSQLStoreForTest(st *SQLite) error {
	return sqlstore.WithTx(context.Background(), st.db, &sql.TxOptions{}, func(tx *sql.Tx) error {
		for _, table := range []string{"metric_points", "history_events"} {
			if _, err := tx.Exec("DELETE FROM " + table); err != nil {
				return err
			}
		}
		return nil
	})
}
