package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/update"
)

func TestManagedHealthWaitsForStartupConfirmation(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	tc := newFakeTelemtWithVersion(t, "1.0.0")
	hb := hub.New(hub.Config{}, tc, st)
	t.Cleanup(hb.Close)
	s := New(&config.Config{}, tc, st, hb, "1.2.3", EngineOptions{PanelLifecycleContext: context.Background()})
	t.Cleanup(s.limiter.Stop)
	t.Cleanup(s.subLimiter.Stop)
	t.Cleanup(s.updateEngine.Close)
	r := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("health before all listeners confirmed: HTTP %d: %s", w.Code, w.Body)
	}
}

func TestNewWorkerRegistrationExposesQueuedRunAndMergedJournal(t *testing.T) {
	data := t.TempDir()
	dir := filepath.Join(t.TempDir(), "updater")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "registration.json"), []byte(`{"version":1,"command":["/bin/true"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := update.NewWorkerClient(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Submit(context.Background(), update.TargetPanel, "v1.2.3", "v1.2.2"); err != nil {
		t.Fatal(err)
	}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AppendUpdateJournal(store.UpdateJournalEntry{Target: update.TargetPanel, RunID: "legacy", Phase: update.PhaseDone, VersionTo: "1.2.2", TS: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	tc := newFakeTelemtWithVersion(t, "1.0.0")
	hb := hub.New(hub.Config{}, tc, st)
	t.Cleanup(hb.Close)
	cfg := &config.Config{DataDir: data, Updates: config.UpdatesConfig{WorkerStateDir: dir}, Privileges: config.PrivilegesConfig{Mode: host.PrivilegesModeDirect}, Auth: config.AuthConfig{Disabled: true}}
	s := New(cfg, tc, st, hb, "1.2.2")
	t.Cleanup(s.limiter.Stop)
	t.Cleanup(s.subLimiter.Stop)
	t.Cleanup(s.updateEngine.Close)
	gh := newFakeGitHub(t)
	s.SetUpdateGithubBaseURL(gh.URL)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/updates", nil))
	var result updatesStatusView
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.LockHeld {
		t.Fatal("queued update did not hold the API lock")
	}
	for _, target := range result.Targets {
		if target.Target != update.TargetPanel {
			continue
		}
		if target.ActiveRun == nil || target.ActiveRun.VersionTo != "v1.2.3" {
			t.Fatalf("worker status missing: %+v", target)
		}
		if len(target.Journal) != 2 || target.Journal[0].VersionTo != "v1.2.3" || target.Journal[1].RunID != "legacy" {
			t.Fatalf("merged journal: %+v", target.Journal)
		}
		return
	}
	t.Fatal("panel target missing")
}
