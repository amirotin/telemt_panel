//go:build !lite

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

func TestNewStoreUnsupportedSchemaRemainsFatal(t *testing.T) {
	for _, version := range []int{1, 10, 999} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "history.db")
			db, err := sqlitedriver.Open("file:" + path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
				_ = db.Close()
				t.Fatal(err)
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			st, err := newStore(&config.Config{Store: config.StoreConfig{Driver: "sqlite", Path: path}})
			if err == nil {
				_ = st.Close()
				t.Fatal("unsupported schema silently fell back")
			}
			var unsupported *sqlstore.UnsupportedSchemaError
			if !errors.As(err, &unsupported) {
				t.Fatalf("schema error classification lost: %v", err)
			}
			if after, err := os.ReadFile(path); err != nil || !bytes.Equal(before, after) {
				t.Fatalf("unsupported database changed: %v", err)
			}
		})
	}
}

func TestNewStoreUsesSQLiteAfterAccessIsRestoredAndRestarted(t *testing.T) {
	dir := t.TempDir()
	parent := filepath.Join(dir, "history")
	if err := os.WriteFile(parent, []byte("blocked"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{DataDir: filepath.Join(dir, "state"), Store: config.StoreConfig{Driver: "sqlite", Path: filepath.Join(parent, "history.db")}}
	st, err := newStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if st.Driver() != "memory" {
		t.Fatal("expected temporary history")
	}
	if err := os.Rename(parent, parent+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	if st.Driver() != "memory" {
		t.Fatal("running store changed without restart")
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := newStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if restarted.Driver() != "sqlite" || !restarted.Info().Durable || !restarted.StateDurable() {
		t.Fatalf("SQLite did not recover at restart: %+v", restarted.Info())
	}
}
