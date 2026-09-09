package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
)

func TestWriteExclusiveFileRemovesPartialOutputAfterCallbackFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "partial.json")
	wantErr := errors.New("injected export failure")
	err := writeExclusiveFile(path, func(w io.Writer) error {
		if _, err := io.WriteString(w, "partial"); err != nil {
			return err
		}
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("writeExclusiveFile error = %v, want %v", err, wantErr)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial output survived: %v", err)
	}
}

func TestWriteExclusiveFileRefusesExistingFileAndSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{target, filepath.Join(dir, "link")} {
		if path != target {
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
		}
		called := false
		if err := writeExclusiveFile(path, func(io.Writer) error { called = true; return nil }); err == nil {
			t.Fatalf("writeExclusiveFile(%q) overwrote existing path", path)
		}
		if called {
			t.Fatalf("write callback called for existing path %q", path)
		}
	}
	raw, err := os.ReadFile(target)
	if err != nil || string(raw) != "keep" {
		t.Fatalf("existing target changed: %q, %v", raw, err)
	}
}

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

func TestResolveStatePathEmptyUsesVolatileState(t *testing.T) {
	got, err := resolveStatePath("")
	if err != nil || got != "" {
		t.Fatalf("resolveStatePath(\"\") = %q, %v; want empty path", got, err)
	}
}

func TestRunStoreCommandValidatesArguments(t *testing.T) {
	for _, args := range [][]string{nil, {"check"}, {"export"}, {"import"}} {
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

func TestRunStoreImportRejectsSQLiteHistoryWithoutMutatingMemoryState(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite is intentionally omitted from the lite build")
	}
	dir := t.TempDir()
	sourceConfig := writeStoreCommandConfig(t, dir, "source.toml", filepath.Join(dir, "source.db"))
	cfg, err := config.Load(sourceConfig)
	if err != nil {
		t.Fatal(err)
	}
	source, err := newStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := source.SetSetting("audit-transfer", "must-not-import"); err != nil {
		t.Fatal(err)
	}
	if err := source.RecordMetric("connections", store.MetricPoint{TS: 1_800_000_000, Value: 17}); err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	dump := filepath.Join(dir, "dump.json")
	if err := runStoreExport([]string{"--config", sourceConfig, "--out", dump}); err != nil {
		t.Fatal(err)
	}

	destinationData := filepath.Join(dir, "destination")
	destinationConfig := writeMemoryStoreCommandConfig(t, dir, "destination.toml", destinationData)
	err = runStoreImport([]string{"--config", destinationConfig, "--in", dump})
	if err == nil || !strings.Contains(err.Error(), "memory store cannot import history") {
		t.Fatalf("memory import error = %v, want actionable history rejection", err)
	}
	destination, err := store.NewState(filepath.Join(destinationData, panelStateFile))
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	if value, ok, err := destination.GetSetting("audit-transfer"); err != nil || ok {
		t.Fatalf("rejected import mutated destination setting: value=%q ok=%v err=%v", value, ok, err)
	}
}

func TestRunStoreImportRejectsEveryMemoryHistoryFamily(t *testing.T) {
	now := int64(1_800_000_000)
	traffic := store.PortableUserTrafficUser{Summary: store.UserTrafficSummary{
		Username:               "alice",
		ObservedTotalBytes:     10,
		CurrentMonthBytes:      10,
		MonthKey:               202701,
		ObservedSinceEpochSecs: now,
		LastActivityEpochSecs:  now,
		Continuity:             store.UserTrafficNormal,
	}}
	cases := []struct {
		name   string
		mutate func(*store.PortableData)
	}{
		{"metrics", func(data *store.PortableData) {
			data.Metrics = map[string][]store.MetricPoint{"connections": {{TS: now, Value: 1}}}
		}},
		{"events", func(data *store.PortableData) {
			data.Events = []store.HistoryEvent{{TS: time.Unix(now, 0), Category: store.StorageEvents, Kind: "test.changed"}}
		}},
		{"traffic", func(data *store.PortableData) { data.UserTraffic = []store.PortableUserTrafficUser{traffic} }},
		{"traffic buckets", func(data *store.PortableData) {
			data.UserTraffic = []store.PortableUserTrafficUser{traffic}
			data.UserTrafficBuckets = []store.PortableUserTrafficBucket{{Username: "alice", Tier: store.MetricTierQuarter, TS: now, Bytes: 1}}
		}},
		{"traffic collector metadata", func(data *store.PortableData) {
			data.UserTrafficCollector = &store.UserTrafficCollectorState{LastSuccessTS: now, SourceStartedAt: now - 60, SourceState: store.UserTrafficCollecting, Continuity: store.UserTrafficPartial}
		}},
		{"IP history", func(data *store.PortableData) {
			data.UserIPs = []store.UserIPRecord{{Username: "alice", IP: "192.0.2.1", Family: 4, First: now, Last: now, Observations: 1}}
			data.UserIPCollection = &store.UserIPCollection{BatchID: "batch-1", Since: now, Through: now}
		}},
		{"IP collection metadata", func(data *store.PortableData) {
			data.UserIPCollection = &store.UserIPCollection{BatchID: "batch-1", Since: now - 60, Through: now, Gap: true}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			source, err := store.NewMemory("")
			if err != nil {
				t.Fatal(err)
			}
			data, err := source.ExportData()
			if err != nil {
				t.Fatal(err)
			}
			if err := source.Close(); err != nil {
				t.Fatal(err)
			}
			data.Settings["must-not-import"] = tc.name
			tc.mutate(&data)
			dump := filepath.Join(dir, "dump.json")
			writePortableDump(t, dump, data)
			configPath := writeMemoryStoreCommandConfig(t, dir, "destination.toml", filepath.Join(dir, "data"))
			if err := runStoreImport([]string{"--config", configPath, "--in", dump}); err == nil || !strings.Contains(err.Error(), "memory store cannot import history") {
				t.Fatalf("memory import error = %v, want actionable history rejection", err)
			}
		})
	}
}

func TestRunStoreExportAllowsSQLiteWithoutDataDir(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite is intentionally omitted from the lite build")
	}
	dir := t.TempDir()
	configPath := writeStoreCommandConfigWithDataDir(t, dir, "sqlite-no-data.toml", "", filepath.Join(dir, "history.db"))
	cfg, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	source, err := newStore(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := source.RecordMetric("connections", store.MetricPoint{TS: 1_800_000_000, Value: 17}); err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}
	dump := filepath.Join(dir, "dump.json")
	if err := runStoreExport([]string{"--config", configPath, "--out", dump}); err != nil {
		t.Fatalf("SQLite export without data_dir: %v", err)
	}
	raw, err := os.ReadFile(dump)
	if err != nil {
		t.Fatal(err)
	}
	var data store.PortableData
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	points := data.Metrics["connections"]
	found := false
	for _, point := range points {
		if point.TS == 1_800_000_000 && point.Value == 17 {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("exported SQLite metrics = %+v, want the recorded point", points)
	}
}

func TestStoreTransferDataDirRequirements(t *testing.T) {
	dir := t.TempDir()
	memoryConfig := writeMemoryStoreCommandConfig(t, dir, "memory-no-data.toml", "")
	dump := filepath.Join(dir, "dump.json")
	writePortableDump(t, dump, exportEmptyMemoryData(t))
	cases := []struct {
		name string
		args []string
	}{
		{"memory export", []string{"export", "--config", memoryConfig, "--out", filepath.Join(dir, "out.json")}},
		{"memory import", []string{"import", "--config", memoryConfig, "--in", dump}},
	}
	if store.Variant != "lite" {
		sqliteConfig := writeStoreCommandConfigWithDataDir(t, dir, "sqlite-no-data.toml", "", filepath.Join(dir, "destination.db"))
		cases = append(cases, struct {
			name string
			args []string
		}{"SQLite import", []string{"import", "--config", sqliteConfig, "--in", dump}})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := runStoreCommand(tc.args); err == nil || !strings.Contains(err.Error(), "requires data_dir") {
				t.Fatalf("runStoreCommand(%v) error = %v, want data_dir rejection", tc.args, err)
			}
		})
	}
}

func exportEmptyMemoryData(t *testing.T) store.PortableData {
	t.Helper()
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	data, err := st.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func writePortableDump(t *testing.T, path string, data store.PortableData) {
	t.Helper()
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeStoreCommandConfig(t *testing.T, dir, name, databasePath string) string {
	t.Helper()
	return writeStoreCommandConfigWithDataDir(t, dir, name, filepath.Join(dir, name+"-data"), databasePath)
}

func writeStoreCommandConfigWithDataDir(t *testing.T, dir, name, dataDir, databasePath string) string {
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
`, dataDir, databasePath)
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
