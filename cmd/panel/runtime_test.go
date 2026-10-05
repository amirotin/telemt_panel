package main

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/update"
)

func TestRuntimeSubprocess(t *testing.T) {
	if path := os.Getenv("PANEL_RUNTIME_TEST_CONFIG"); path != "" {
		os.Args = []string{os.Args[0], "--config", path}
		main()
		os.Exit(0)
	}
}

type runtimeCloseErrorStore struct {
	store.Store
	closed bool
}

func (s *runtimeCloseErrorStore) Close() error {
	s.closed = true
	return errors.Join(s.Store.Close(), errors.New("injected close error"))
}

func TestRuntimeCloseErrorChangesExitCode(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "config.toml")
	if err := os.WriteFile(path, []byte("listen=\"127.0.0.1:0\"\n[telemt]\nurl=\"http://127.0.0.1:1\"\n[auth]\ndisabled=true\n[host]\nservice_manager=\"none\"\n[privileges]\nmode=\"manual\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	wrapper := &runtimeCloseErrorStore{Store: st}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if code := runRuntimeStore(ctx, cfg, path, wrapper); code != 1 || !wrapper.closed {
		t.Fatalf("exit=%d closed=%v", code, wrapper.closed)
	}
}

func TestRuntimeTLSPreparationFailureDoesNotConfirmUpdate(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "config.toml")
	if err := os.WriteFile(path, []byte("listen=\"127.0.0.1:19443\"\n[telemt]\nurl=\"http://127.0.0.1:1\"\n[auth]\ndisabled=true\n[host]\nservice_manager=\"none\"\n[privileges]\nmode=\"manual\"\n[tls]\nmode=\"certificate\"\ncert_file="+strconv.Quote(filepath.Join(directory, "missing.crt"))+"\nkey_file="+strconv.Quote(filepath.Join(directory, "missing.key"))+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(directory, panelStateFile)
	st, err := store.NewMemory(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AppendUpdateJournal(store.UpdateJournalEntry{Target: update.TargetPanel, RunID: "pending", Phase: update.PhaseRestarting, VersionTo: version, TS: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if code := runRuntimeStore(context.Background(), cfg, path, st); code != 1 {
		t.Fatalf("invalid TLS exit=%d", code)
	}
	reopened, err := store.NewMemory(statePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	entries, err := reopened.ListUpdateJournal(update.TargetPanel, 1)
	if err != nil || len(entries) != 1 || entries[0].Phase != update.PhaseRestarting {
		t.Fatalf("TLS failure journal=%+v error=%v", entries, err)
	}
}

func TestRuntimeListenErrorFlushesQueuedSessionTouch(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	directory := t.TempDir()
	path := filepath.Join(directory, "config.toml")
	if err := os.WriteFile(path, []byte("listen="+strconv.Quote(listener.Addr().String())+"\n[telemt]\nurl=\"http://127.0.0.1:1\"\n[auth]\ndisabled=true\n[host]\nservice_manager=\"none\"\n[privileges]\nmode=\"manual\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(directory, panelStateFile)
	st, err := store.NewMemory(statePath)
	if err != nil {
		t.Fatal(err)
	}
	seen := time.Now().UTC()
	if err := st.PutSession(store.Session{IDHash: "touch", Created: seen.Add(-time.Hour), LastSeen: seen.Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := st.TouchSession("touch", seen); err != nil {
		t.Fatal(err)
	}
	var runtimeStore store.Store = st
	metricPath := filepath.Join(directory, "metrics.db")
	if store.Variant != "lite" {
		history, err := store.Open(store.OpenOptions{Driver: "sqlite", Path: metricPath})
		if err != nil {
			t.Fatal(err)
		}
		if err := history.RecordMetric("traffic", store.MetricPoint{TS: seen.Unix(), Value: 42}); err != nil {
			t.Fatal(err)
		}
		runtimeStore, err = store.NewComposite(st, history)
		if err != nil {
			t.Fatal(err)
		}
	}
	if code := runRuntimeStore(context.Background(), cfg, path, runtimeStore); code != 1 {
		t.Fatalf("occupied port exit=%d", code)
	}
	reopened, err := store.NewMemory(statePath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	session, exists, err := reopened.GetSession("touch")
	if err != nil || !exists || !session.LastSeen.Equal(seen) {
		t.Fatalf("queued session touch lost: session=%+v error=%v", session, err)
	}
	if store.Variant != "lite" {
		history, err := store.Open(store.OpenOptions{Driver: "sqlite", Path: metricPath})
		if err != nil {
			t.Fatal(err)
		}
		defer history.Close()
		points, err := history.MetricRange("traffic", seen.Unix()-300)
		if err != nil || len(points) != 1 || points[0].Value != 42 {
			t.Fatalf("queued metric lost: %+v error=%v", points, err)
		}
	}
}

func TestRuntimeOccupiedPortDoesNotConfirmUpdate(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	directory := t.TempDir()
	statePath := filepath.Join(directory, panelStateFile)
	state, err := store.NewState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := state.AppendUpdateJournal(store.UpdateJournalEntry{Target: update.TargetPanel, RunID: "pending", Phase: update.PhaseRestarting, VersionFrom: "1.0.0", VersionTo: version, TS: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "config.toml")
	config := "listen = " + strconv.Quote(listener.Addr().String()) + "\ndata_dir = " + strconv.Quote(directory) + "\n[telemt]\nurl = \"http://127.0.0.1:1\"\n[auth]\ndisabled = true\n[host]\nservice_manager = \"none\"\n[privileges]\nmode = \"manual\"\n"
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRuntimeSubprocess$")
	command.Env = append(os.Environ(), "PANEL_RUNTIME_TEST_CONFIG="+configPath)
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "listen panel") {
		t.Fatalf("startup error=%v output=%s", err, output)
	}
	state, err = store.NewState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	entries, err := state.ListUpdateJournal(update.TargetPanel, 1)
	if err != nil || len(entries) != 1 || entries[0].Phase == update.PhaseDone {
		t.Fatalf("failed startup journal=%+v error=%v; must never report done", entries, err)
	}
}
