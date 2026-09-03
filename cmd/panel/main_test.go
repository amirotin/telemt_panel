package main

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
)

func TestNewStoreBuildsSQLiteStore(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite is intentionally omitted from the lite build")
	}
	cfg := &config.Config{Store: config.StoreConfig{Driver: "sqlite", Path: filepath.Join(t.TempDir(), "panel.db")}}
	st, err := newStore(cfg)
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestNewStoreBuildsMemoryStore(t *testing.T) {
	for _, driver := range []string{"", "memory"} {
		cfg := &config.Config{Store: config.StoreConfig{Driver: driver}}
		st, err := newStore(cfg)
		if err != nil {
			t.Fatalf("newStore(driver=%q): %v", driver, err)
		}
		if st == nil {
			t.Fatalf("newStore(driver=%q): want a non-nil store", driver)
		}
		st.Close()
	}
}

func TestNewStoreFallsBackWhenPostgresIsUnavailable(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("network drivers are intentionally omitted from the lite build")
	}
	dataDir := t.TempDir()
	cfg := &config.Config{DataDir: dataDir, Store: config.StoreConfig{
		Driver: "postgres",
		DSN:    "postgres://127.0.0.1:1/telemt_panel?connect_timeout=1",
	}}
	st, err := newStore(cfg)
	if err != nil {
		t.Fatalf("newStore: %v", err)
	}
	status := store.Runtime(st, cfg.Store.Driver)
	if status.ConfiguredDriver != "postgres" || status.ActiveDriver != "memory" || status.Error == "" {
		t.Fatalf("fallback status = %+v", status)
	}
	if err := st.SetSetting("fallback-state", "durable"); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.NewState(filepath.Join(dataDir, panelStateFile))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if value, ok, err := reopened.GetSetting("fallback-state"); err != nil || !ok || value != "durable" {
		t.Fatalf("state during history fallback = %q, %v, %v", value, ok, err)
	}
}

func TestResolveStatePathEmptyUsesVolatileState(t *testing.T) {
	got, err := resolveStatePath("")
	if err != nil || got != "" {
		t.Fatalf("resolveStatePath(\"\") = %q, %v; want empty path", got, err)
	}
}

func TestRunStoreCommandValidatesArguments(t *testing.T) {
	for _, args := range [][]string{nil, {"check"}, {"check", "--driver", "sqlite", "--dsn", "x"}} {
		if err := runStoreCommand(args); err == nil {
			t.Fatalf("runStoreCommand(%v) accepted invalid arguments", args)
		}
	}
}

func TestRunStoreExportImport(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite is intentionally omitted from the lite build")
	}
	dir := t.TempDir()
	sourceDB := filepath.Join(dir, "source.db")
	destinationDB := filepath.Join(dir, "destination.db")
	sourceConfig := writeStoreCommandConfig(t, dir, "source.toml", sourceDB)
	destinationConfig := writeStoreCommandConfig(t, dir, "destination.toml", destinationDB)

	sourceSettings, err := config.Load(sourceConfig)
	if err != nil {
		t.Fatal(err)
	}
	source, err := newStore(sourceSettings)
	if err != nil {
		t.Fatal(err)
	}
	if err := source.SetSetting("transfer-test", "preserved"); err != nil {
		t.Fatal(err)
	}
	if err := source.RecordMetric("connections", store.MetricPoint{TS: 1_800_000_000, Value: 17}); err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}

	dump := filepath.Join(dir, "dump.json")
	if err := runStoreCommand([]string{"export", "--config", sourceConfig, "--out", dump}); err != nil {
		t.Fatalf("export: %v", err)
	}
	info, err := os.Stat(dump)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("export mode = %o, want 600", info.Mode().Perm())
	}
	if err := runStoreCommand([]string{"export", "--config", sourceConfig, "--out", dump}); err == nil {
		t.Fatal("export overwrote an existing dump")
	}
	if err := runStoreCommand([]string{"import", "--config", destinationConfig, "--in", dump}); err != nil {
		t.Fatalf("import: %v", err)
	}

	destinationSettings, err := config.Load(destinationConfig)
	if err != nil {
		t.Fatal(err)
	}
	destination, err := newStore(destinationSettings)
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	value, ok, err := destination.GetSetting("transfer-test")
	if err != nil || !ok || value != "preserved" {
		t.Fatalf("imported setting = %q, %v, %v", value, ok, err)
	}
	points, err := destination.MetricRange("connections", 0)
	if err != nil || len(points) != 1 || points[0].Value != 17 {
		t.Fatalf("imported metrics = %+v, %v", points, err)
	}
}

func TestRunStoreExportImportMemory(t *testing.T) {
	dir := t.TempDir()
	sourceData := filepath.Join(dir, "source-data")
	destinationData := filepath.Join(dir, "destination-data")
	if err := os.MkdirAll(sourceData, 0o700); err != nil {
		t.Fatal(err)
	}
	source, err := store.NewState(filepath.Join(sourceData, panelStateFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := source.SetSetting("memory-transfer", "preserved"); err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	sourceConfig := writeMemoryStoreCommandConfig(t, dir, "memory-source.toml", sourceData)
	destinationConfig := writeMemoryStoreCommandConfig(t, dir, "memory-destination.toml", destinationData)
	dump := filepath.Join(dir, "memory-dump.json")
	if err := runStoreCommand([]string{"export", "--config", sourceConfig, "--out", dump}); err != nil {
		t.Fatalf("export memory: %v", err)
	}
	if err := runStoreCommand([]string{"import", "--config", destinationConfig, "--in", dump}); err != nil {
		t.Fatalf("import memory: %v", err)
	}
	destination, err := store.NewState(filepath.Join(destinationData, panelStateFile))
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	value, ok, err := destination.GetSetting("memory-transfer")
	if err != nil || !ok || value != "preserved" {
		t.Fatalf("imported memory setting = %q, %v, %v", value, ok, err)
	}
}

func TestMemoryStoreImportRequiresDataDir(t *testing.T) {
	dir := t.TempDir()
	configPath := writeMemoryStoreCommandConfig(t, dir, "memory-no-data.toml", "")
	if st, err := openTransferStore(configPath, true); err == nil {
		st.Close()
		t.Fatal("memory import accepted a configuration without data_dir")
	}
}

func writeStoreCommandConfig(t *testing.T, dir, name, databasePath string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	content := fmt.Sprintf(`listen = "127.0.0.1:0"
data_dir = %q

[telemt]
url = "http://127.0.0.1:9091"

[auth]
username = "admin"
password_hash = "hash"

[store]
driver = "sqlite"
path = %q
`, filepath.Join(dir, name+"-data"), databasePath)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeMemoryStoreCommandConfig(t *testing.T, dir, name, dataDir string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	content := fmt.Sprintf(`listen = "127.0.0.1:0"
data_dir = %q

[telemt]
url = "http://127.0.0.1:9091"

[auth]
username = "admin"
password_hash = "hash"

[store]
driver = "memory"
`, dataDir)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestResolveStatePathCreatesDataDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "does", "not", "exist", "yet")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("precondition: %q already exists", dir)
	}

	got, err := resolveStatePath(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, panelStateFile)
	if got != want {
		t.Fatalf("resolveStatePath(%q) = %q, want %q", dir, got, want)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("data_dir was not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("%q was created but is not a directory", dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("state path probe left files behind: %v", entries)
	}
}

func TestResolveStatePathUnwritableParentFails(t *testing.T) {
	// A regular file in place of a would-be parent directory makes
	// MkdirAll fail regardless of the test's own user/permissions (e.g.
	// running as root), unlike a plain permission-bit test would.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	dataDir := filepath.Join(blocker, "sub")

	if got, err := resolveStatePath(dataDir); err == nil || got != "" {
		t.Fatalf("resolveStatePath(%q) = %q, %v; want a fatal directory error", dataDir, got, err)
	}
}
