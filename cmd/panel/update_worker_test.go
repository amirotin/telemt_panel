package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/update"
)

func TestUpdateWorkerProtocolAndRecoveryWithoutCurrentConfig(t *testing.T) {
	var output bytes.Buffer
	if err := runUpdateWorkerCommand([]string{"--protocol"}, &output); err != nil || output.String() != "1\n" {
		t.Fatalf("protocol=%q error=%v", output.String(), err)
	}
	dir := t.TempDir()
	if err := runUpdateWorkerCommand([]string{"--recover", "--state-dir", dir, "--config", filepath.Join(dir, "missing.toml")}, &output); err != nil {
		t.Fatalf("empty recovery read current config: %v", err)
	}
	if err := runUpdateWorkerCommand([]string{"--state-dir", dir}, &output); err == nil {
		t.Fatal("worker ran without config")
	}
}

func TestUpdateWorkerPanelURLUsesLocalListenerAndBasePath(t *testing.T) {
	for _, tc := range []struct{ listen, tls, path, want string }{
		{"0.0.0.0:8080", "http", "/panel", "http://127.0.0.1:8080/panel/api/health"},
		{"[::]:8443", "certificate", "/panel/", "https://[::1]:8443/panel/api/health"},
		{"127.0.0.1:8443", "acme", "", "https://127.0.0.1:8443/api/health"},
	} {
		cfg := &config.Config{Listen: tc.listen, BasePath: tc.path, TLS: config.TLSConfig{Mode: tc.tls}}
		got, err := updateWorkerPanelURL(cfg)
		if err != nil || got != tc.want {
			t.Fatalf("url=%q error=%v want=%q", got, err, tc.want)
		}
	}
}

func TestUpdateWorkerRecoveryUsesSavedConfigAndRestoresFileMetadata(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "updater")
	if err := os.Mkdir(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.toml")
	binary := filepath.Join(dir, "panel")
	backupConfig := filepath.Join(stateDir, "saved-config")
	for path, data := range map[string]string{configPath: "not valid TOML !", backupConfig: "old config", binary: "broken candidate", binary + ".bak": "old executable"} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &config.Config{Path: configPath, DataDir: dir, Listen: "127.0.0.1:8080", Store: config.StoreConfig{Driver: "sqlite", Path: filepath.Join(dir, "history.db")}, Host: config.HostConfig{ServiceManager: host.KindNone, PanelService: "panel", TelemtService: "telemt"}, Privileges: config.PrivilegesConfig{Mode: host.PrivilegesModeDirect}, Updates: config.UpdatesConfig{PanelBinaryPath: binary, TelemtBinaryPath: filepath.Join(dir, "telemt")}}
	worker, err := makeUpdateWorkerConfig(cfg, stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(worker.SnapshotPaths) != 5 || worker.SnapshotPaths[3] != cfg.Store.Path+"-wal" || worker.SnapshotPaths[4] != cfg.Store.Path+"-shm" {
		t.Fatalf("snapshot paths=%v", worker.SnapshotPaths)
	}
	state := map[string]any{"version": 1, "task": map[string]any{
		"status":          update.RunStatus{RunID: "interrupted", Target: update.TargetPanel, Phase: update.PhaseRestarting, VersionFrom: "1.0.0", VersionTo: "1.1.0"},
		"recovery_config": json.RawMessage(worker.RecoveryConfig), "backup_path": binary + ".bak", "stop_intent": true, "publish_intent": true, "snapshot_complete": true,
		"snapshots": []map[string]any{{"path": configPath, "backup": backupConfig, "exists": true, "mode": 0o640, "uid": os.Geteuid(), "gid": os.Getegid()}},
	}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(stateDir, "state.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(stateDir, "registration.json"), []byte(`{"version":1,"command":["/bin/true"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runUpdateWorkerCommand([]string{"--recover", "--state-dir", stateDir}, &out); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(configPath)
	if err != nil || string(data) != "old config" {
		t.Fatalf("restored config=%q,%v", data, err)
	}
	info, err := os.Stat(configPath)
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("config mode=%v,%v", info, err)
	}
	data, err = os.ReadFile(binary)
	if err != nil || string(data) != "old executable" {
		t.Fatalf("restored binary=%q,%v", data, err)
	}
	data, err = os.ReadFile(filepath.Join(stateDir, "state.json"))
	if err != nil || !strings.Contains(string(data), `"recovery_ready":true`) {
		t.Fatalf("pending readiness state=%s,%v", data, err)
	}
	if _, err := os.Stat(binary + ".bak"); err != nil {
		t.Fatalf("backup removed before runtime readiness: %v", err)
	}
}

func TestUpdateWorkerInstallerIdleCheckDoesNotRequireConfigOrLock(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	if err := runUpdateWorkerCommand([]string{"--check-idle", "--state-dir", dir}, &out); err != nil {
		t.Fatalf("empty worker state not idle: %v", err)
	}
	state := map[string]any{"version": 1, "task": map[string]any{"status": update.RunStatus{Target: update.TargetPanel, Phase: update.PhaseChecking}}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runUpdateWorkerCommand([]string{"--check-idle", "--state-dir", dir}, &out); err == nil {
		t.Fatal("queued worker reported idle to installer")
	}
}
