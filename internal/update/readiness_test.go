package update

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func TestAsyncUpdateObservesPanelLifecycleCancellation(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer fixture.Close()
	defer close(release)
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := NewClient()
	client.BaseURL = fixture.URL
	e := NewEngine(EngineConfig{Runner: newTestRunner(), Store: st, Github: client, StagingDir: t.TempDir(), PanelLifecycleContext: ctx, Targets: map[string]Target{TargetPanel: &fakeTarget{name: TargetPanel, repo: "owner/repo", version: "v1.0.0"}}})
	if err := e.StartApply(TargetPanel, "v1.1.0"); err != nil {
		t.Fatal(err)
	}
	<-entered
	cancel()
	deadline := time.Now().Add(time.Second)
	for e.LockHeld() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if e.LockHeld() {
		t.Fatal("async update ignored panel lifecycle cancellation")
	}
}

func TestEngineApplyWaitsForReadiness(t *testing.T) {
	fixture := newFakeReleaseServer(t)
	target := &fakeTarget{name: TargetPanel, repo: "owner/repo", version: "v1.0.0"}
	e, _ := newTestEngine(t, fixture, newTestRunner(), map[string]Target{TargetPanel: target}, nil)
	e.ready = false
	if err := e.Apply(context.Background(), TargetPanel, "v1.1.0"); !errors.Is(err, ErrBusy) {
		t.Fatalf("apply before readiness error=%v, want unavailable reservation", err)
	}
	if err := e.StartApply(TargetPanel, "v1.1.0"); !errors.Is(err, ErrBusy) {
		waitUnlocked(e)
		t.Fatalf("async apply before readiness error=%v", err)
	}
	e.MarkReady()
	if err := e.Apply(context.Background(), TargetPanel, "v1.1.0"); errors.Is(err, ErrBusy) {
		t.Fatal("ready engine kept the readiness reservation")
	}
	e.Close()
	e.Close()
	if err := e.StartApply(TargetPanel, "v1.1.0"); !errors.Is(err, ErrBusy) {
		t.Fatalf("closed engine accepted a new operation: %v", err)
	}
}

func TestReconcileStartupDoesNotConfirmBeforeReadiness(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.AppendUpdateJournal(store.UpdateJournalEntry{Target: TargetPanel, RunID: "pending", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v1.1.0", TS: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := ReconcileInterrupted(st, "v1.1.0"); err != nil {
		t.Fatal(err)
	}
	entries, err := st.ListUpdateJournal(TargetPanel, 1)
	if err != nil || len(entries) != 1 || entries[0].Phase != PhaseRestarting {
		t.Fatalf("early startup journal=%+v error=%v; pending restart must await listeners", entries, err)
	}
}

func TestConfirmPanelReadyRejectsStaleHandoff(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	first := store.UpdateJournalEntry{Target: TargetPanel, RunID: "first", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v1.1.0", TS: time.Now()}
	if err := st.AppendUpdateJournal(first); err != nil {
		t.Fatal(err)
	}
	pending, err := ReconcileInterrupted(st, "v1.1.0")
	if err != nil || pending == nil {
		t.Fatalf("pending=%+v error=%v", pending, err)
	}
	first.RunID = "second"
	first.TS = time.Now()
	if err := st.AppendUpdateJournal(first); err != nil {
		t.Fatal(err)
	}
	if err := ConfirmPanelReady(st, *pending, "v1.1.0"); err == nil {
		t.Fatal("stale readiness callback confirmed a different update run")
	}
	entries, err := st.ListUpdateJournal(TargetPanel, 1)
	if err != nil || entries[0].RunID != "second" || entries[0].Phase != PhaseRestarting {
		t.Fatalf("new handoff changed: %+v error=%v", entries, err)
	}
}

type failingConfirmationStore struct {
	store.Store
}

func (s failingConfirmationStore) AppendUpdateJournal(store.UpdateJournalEntry) error {
	return errors.New("confirmation persistence failed")
}

func TestConfirmPanelReadyPropagatesPersistenceFailure(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.AppendUpdateJournal(store.UpdateJournalEntry{Target: TargetPanel, RunID: "pending", Phase: PhaseRestarting, VersionFrom: "v1.0.0", VersionTo: "v1.1.0", TS: time.Now()}); err != nil {
		t.Fatal(err)
	}
	err = ConfirmPanelReady(failingConfirmationStore{st}, PendingPanelRestart{"pending", "v1.0.0", "v1.1.0"}, "v1.1.0")
	if err == nil {
		t.Fatal("confirmation persistence failure lost")
	}
}
