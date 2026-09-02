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
		opened, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"), "")
		if err != nil {
			t.Fatal(err)
		}
		return opened
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
	st := runStoreContract(t, func(t *testing.T) Store {
		opened, err := Open(OpenOptions{Driver: driver, DSN: dsn})
		if err != nil {
			t.Fatal(err)
		}
		return opened
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
		sqlBackend := st.(*SQLite)
		if err := clearSQLStoreForTest(sqlBackend); err != nil {
			t.Fatal(err)
		}
		if err := portable.ImportData(before); err != nil {
			t.Fatal(err)
		}
		after, err := portable.ExportData()
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(after, before) {
			t.Fatalf("portable network round trip changed data\n got: %#v\nwant: %#v", after, before)
		}
	})
}

func clearSQLStoreForTest(st *SQLite) error {
	return sqlstore.WithTx(context.Background(), st.db, &sql.TxOptions{}, func(tx *sql.Tx) error {
		for _, table := range []string{"sessions", "subpage_nonces", "settings", "update_journal", "audit_entries", "metric_points", "history_events"} {
			if _, err := tx.Exec("DELETE FROM " + table); err != nil {
				return err
			}
		}
		return nil
	})
}
