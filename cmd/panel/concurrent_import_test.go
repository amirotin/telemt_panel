package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func TestConcurrentRuntimeImportRejectsEmptyAnonymousState(t *testing.T) {
	directory := t.TempDir()
	dataDir := filepath.Join(directory, "data")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	configPath := filepath.Join(directory, "config.toml")
	raw := "listen=" + strconv.Quote(address) + "\ndata_dir=" + strconv.Quote(dataDir) + "\n[telemt]\nurl=\"http://127.0.0.1:1\"\n[auth]\ndisabled=true\n[host]\nservice_manager=\"none\"\n[privileges]\nmode=\"manual\"\n"
	if err := os.WriteFile(configPath, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	dumpPath := filepath.Join(directory, "dump.json")
	dump, err := json.Marshal(store.PortableData{FormatVersion: 7, Settings: map[string]string{"restored": "true"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dumpPath, dump, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	log, err := os.Create(filepath.Join(directory, "runtime.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRuntimeSubprocess$")
	command.Env = append(os.Environ(), "PANEL_RUNTIME_TEST_CONFIG="+configPath)
	command.Stdout, command.Stderr = log, log
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	stopped := false
	defer func() {
		if !stopped {
			command.Process.Kill()
			command.Wait()
		}
	}()
	client := &http.Client{Timeout: 200 * time.Millisecond}
	ready := false
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get("http://" + address + "/api/health")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				ready = true
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ready {
		t.Fatal("runtime did not become ready")
	}
	statePath := filepath.Join(dataDir, panelStateFile)
	before, _ := os.ReadFile(statePath)
	if err := runStoreImport([]string{"--config", configPath, "--in", dumpPath}); err == nil || !strings.Contains(err.Error(), "data_dir_in_use") {
		t.Fatalf("concurrent import error=%v, want data_dir_in_use", err)
	}
	after, _ := os.ReadFile(statePath)
	if !bytes.Equal(before, after) {
		t.Fatal("rejected import changed runtime state bytes")
	}
	if err := command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	stopped = true
	if err := runStoreImport([]string{"--config", configPath, "--in", dumpPath}); err != nil {
		t.Fatalf("import after owner shutdown: %v", err)
	}
	state, err := store.NewState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	value, exists, err := state.GetSetting("restored")
	if err != nil || !exists || value != "true" {
		t.Fatalf("restored value=%q exists=%v error=%v", value, exists, err)
	}
}

func TestStoreExportPreservesStateHistoryBytesModesAndTimes(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite omitted from lite")
	}
	directory := t.TempDir()
	dataDir := filepath.Join(directory, "state")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dataDir, panelStateFile)
	state, err := store.NewState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := state.SetSetting("auth.password_identity.v1", "preserved"); err != nil {
		t.Fatal(err)
	}
	state.Close()
	databasePath := filepath.Join(directory, "panel.db")
	history, err := store.Open(store.OpenOptions{Driver: "sqlite", Path: databasePath})
	if err != nil {
		t.Fatal(err)
	}
	if err := history.RecordMetric("traffic", store.MetricPoint{TS: time.Now().Unix(), Value: 42}); err != nil {
		t.Fatal(err)
	}
	history.Close()
	if err := os.Chmod(databasePath, 0o644); err != nil {
		t.Fatal(err)
	}
	configPath := writeStoreCommandConfigWithDataDir(t, directory, "config.toml", dataDir, databasePath)
	paths := []string{statePath, databasePath, configPath}
	beforeBytes := make(map[string][]byte)
	beforeInfo := make(map[string]os.FileInfo)
	for _, path := range paths {
		beforeBytes[path], err = os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		beforeInfo[path], err = os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := runStoreExport([]string{"--config", configPath, "--out", filepath.Join(directory, "export.json")}); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		after, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(beforeBytes[path], after) || beforeInfo[path].Mode() != info.Mode() || !beforeInfo[path].ModTime().Equal(info.ModTime()) {
			t.Fatalf("read-only export mutated %s bytes/mode/mtime", path)
		}
	}
}

func TestStoreExportDoesNotInitializeMissingHistory(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite omitted from lite")
	}
	directory := t.TempDir()
	databasePath := filepath.Join(directory, "missing-history", "panel.db")
	configPath := writeStoreCommandConfigWithDataDir(t, directory, "config.toml", filepath.Join(directory, "state"), databasePath)
	outputPath := filepath.Join(directory, "export.json")
	if err := runStoreExport([]string{"--config", configPath, "--out", outputPath}); err == nil {
		t.Fatal("export initialized a missing history database")
	}
	for _, path := range []string{filepath.Dir(databasePath), outputPath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("export changed missing destination %s: %v", path, err)
		}
	}
}
