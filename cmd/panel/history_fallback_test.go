package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
)

func TestNewStoreUnavailableHistoryPreservesState(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite is intentionally omitted from the lite build")
	}
	for _, broken := range []string{"corrupt", "parent-is-file"} {
		t.Run(broken, func(t *testing.T) {
			dir := t.TempDir()
			original := []byte("not a SQLite database\n")
			blocked := filepath.Join(dir, "blocked")
			if err := os.WriteFile(blocked, original, 0o600); err != nil {
				t.Fatal(err)
			}
			path := blocked
			if broken == "parent-is-file" {
				path = filepath.Join(blocked, "history.db")
			}
			cfg := &config.Config{
				DataDir: filepath.Join(dir, "state"),
				Store:   config.StoreConfig{Driver: "sqlite", Path: path},
			}
			st, err := newStore(cfg)
			if err != nil {
				t.Fatalf("start with temporary history: %v", err)
			}
			t.Cleanup(func() { _ = st.Close() })
			if st.Driver() != "memory" || st.Info().Durable || !st.StateDurable() {
				t.Fatalf("unexpected persistence: %+v, state=%v", st.Info(), st.StateDurable())
			}
			if cfg.Store.Driver != "sqlite" || cfg.Store.Path != path {
				t.Fatal("fallback changed the configured database")
			}
			if err := st.SetSetting("fallback-test", "retained"); err != nil {
				t.Fatal(err)
			}
			session := store.Session{IDHash: "fallback-session", Created: time.Now(), LastSeen: time.Now()}
			if err := st.PutSession(session); err != nil {
				t.Fatal(err)
			}
			if err := st.RecordMetric("connections", store.MetricPoint{TS: time.Now().Unix(), Value: 7}); err != nil {
				t.Fatal(err)
			}
			if points, err := st.MetricRange("connections", 0); err != nil || len(points) != 1 || points[0].Value != 7 {
				t.Fatalf("temporary history is not recording: %v, %v", points, err)
			}
			if err := st.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := newStore(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if value, found, err := reopened.GetSetting("fallback-test"); err != nil || !found || value != "retained" {
				t.Fatalf("state lost: %q, %v, %v", value, found, err)
			}
			if _, found, err := reopened.GetSession(session.IDHash); err != nil || !found {
				t.Fatalf("session lost: %v, %v", found, err)
			}
			if points, err := reopened.MetricRange("connections", 0); err != nil || len(points) != 0 {
				t.Fatalf("temporary history survived restart: %v, %v", points, err)
			}
			if got, err := os.ReadFile(blocked); err != nil || !bytes.Equal(got, original) {
				t.Fatalf("original database/path changed: %q, %v", got, err)
			}
		})
	}
}

func TestTransferDoesNotFallBackToMemory(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite is intentionally omitted from the lite build")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "corrupt.db")
	original := []byte("preserve this corrupt database")
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := writeStoreCommandConfigWithDataDir(t, dir, "panel.toml", filepath.Join(dir, "state"), path)
	for _, importing := range []bool{false, true} {
		st, err := openTransferStore(configPath, importing)
		if err == nil {
			_ = st.Close()
			t.Fatalf("transfer importing=%v silently fell back", importing)
		}
		if !store.IsRuntimeOpenError(err) {
			t.Fatalf("unexpected transfer failure: %v", err)
		}
	}
	out := filepath.Join(dir, "export.json")
	if err := runStoreExport([]string{"--config", configPath, "--out", out}); err == nil {
		t.Fatal("export silently succeeded without the database")
	}
	if _, err := os.Stat(out); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed export created output: %v", err)
	}
	if got, err := os.ReadFile(path); err != nil || !bytes.Equal(got, original) {
		t.Fatalf("transfer changed corrupt database: %q, %v", got, err)
	}
}

func TestNewStoreUnavailableStateRemainsFatal(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, panelStateFile), []byte("invalid JSON"), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(&config.Config{DataDir: dir, Store: config.StoreConfig{Driver: "memory"}})
	if err == nil {
		_ = st.Close()
		t.Fatal("invalid panel state silently fell back")
	}
}

func TestNewStoreInvalidHistoryConfigurationRemainsFatal(t *testing.T) {
	for _, driver := range []string{"unknown", "sqlite"} {
		t.Run(driver, func(t *testing.T) {
			st, err := newStore(&config.Config{Store: config.StoreConfig{Driver: driver}})
			if err == nil {
				_ = st.Close()
				t.Fatal("invalid history configuration silently fell back")
			}
		})
	}
}
