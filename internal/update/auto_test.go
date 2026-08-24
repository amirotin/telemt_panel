package update

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func TestAutoSettings_GetDefaultsAndRoundTrip(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	defer st.Close()

	got, err := GetAutoSettings(st)
	if err != nil {
		t.Fatalf("GetAutoSettings: %v", err)
	}
	want := AutoSettings{Telemt: AutoModeOff, Panel: AutoModeOff, Interval: defaultAutoInterval}
	if got != want {
		t.Errorf("defaults = %+v, want %+v", got, want)
	}

	set := AutoSettings{Telemt: AutoModeApply, Panel: AutoModeCheck, Interval: 2 * time.Hour}
	if err := SetAutoSettings(st, set); err != nil {
		t.Fatalf("SetAutoSettings: %v", err)
	}
	got, err = GetAutoSettings(st)
	if err != nil {
		t.Fatalf("GetAutoSettings after set: %v", err)
	}
	if got != set {
		t.Errorf("round-trip = %+v, want %+v", got, set)
	}
}

func TestSetAutoSettings_RejectsInvalidModeAndInterval(t *testing.T) {
	st, _ := store.NewMemory("")
	defer st.Close()

	if err := SetAutoSettings(st, AutoSettings{Telemt: "bogus", Panel: AutoModeOff, Interval: time.Hour}); err == nil {
		t.Error("want error for invalid mode")
	}
	if err := SetAutoSettings(st, AutoSettings{Telemt: AutoModeOff, Panel: AutoModeOff, Interval: 30 * time.Minute}); err == nil {
		t.Error("want error for interval below the 1h floor")
	}
}

// newAutoTestEngine builds a real Engine (fake GitHub server + hosttest
// Runner) with one target, "telemt", configured so LatestVersion reports
// v2.0.0 as newer than the target's current v1.0.0 — the fixture
// tickTarget's "check"/"apply" paths exercise.
func newAutoTestEngine(t *testing.T, hub UpdatePublisher, postRestartErr error) (*Engine, *fakeReleaseServer, *fakeTarget) {
	t.Helper()
	fixture := newFakeReleaseServer(t)
	tarBytes := buildTarGz(t, "telemt", []byte("new-binary"))
	setupHappyRelease(fixture, TargetTelemt, tarBytes)

	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "telemt")
	if err := os.WriteFile(binaryPath, []byte("old-binary"), 0o755); err != nil {
		t.Fatalf("seed binary: %v", err)
	}

	target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", binaryPath: binaryPath, serviceName: "telemt", version: "v1.0.0"}
	if postRestartErr != nil {
		target.postRestart = func(context.Context) error { return postRestartErr }
	}
	runner := newTestRunner()
	e, _ := newTestEngine(t, fixture, runner, map[string]Target{TargetTelemt: target}, hub)
	return e, fixture, target
}

func TestAutoUpdater_Tick_RespectsMode(t *testing.T) {
	t.Run("off skips entirely", func(t *testing.T) {
		pub := &fakePublisher{}
		e, _, _ := newAutoTestEngine(t, pub, nil)
		a := NewAutoUpdater(nil, e)
		a.tickTarget(context.Background(), TargetTelemt, AutoModeOff)
		if len(pub.Published()) != 0 {
			t.Errorf("published = %v, want none for off mode", pub.Published())
		}
		if e.LockHeld() {
			t.Error("engine locked after an off-mode tick")
		}
	})

	t.Run("check publishes an availability notice without applying", func(t *testing.T) {
		pub := &fakePublisher{}
		e, _, _ := newAutoTestEngine(t, pub, nil)
		a := NewAutoUpdater(nil, e)
		a.tickTarget(context.Background(), TargetTelemt, AutoModeCheck)
		if len(pub.Published()) != 1 {
			t.Fatalf("published = %v, want exactly 1 event", pub.Published())
		}
		if e.LockHeld() {
			t.Error("engine locked after a check-mode tick (should never apply)")
		}
	})

	t.Run("apply runs the update to completion", func(t *testing.T) {
		st, err := store.NewMemory("")
		if err != nil {
			t.Fatalf("store.NewMemory: %v", err)
		}
		defer st.Close()

		e, _, _ := newAutoTestEngine(t, nil, nil)
		a := NewAutoUpdater(st, e)
		a.tickTarget(context.Background(), TargetTelemt, AutoModeApply)
		waitUnlocked(e)

		entries, err := e.st.ListUpdateJournal(TargetTelemt, 20)
		if err != nil {
			t.Fatalf("ListUpdateJournal: %v", err)
		}
		if len(entries) == 0 || entries[0].Phase != PhaseDone {
			t.Fatalf("last journal entry = %+v, want phase=done", entries)
		}
	})
}

func TestAutoUpdater_Run_TicksOnInjectedClockAndStopsOnContextCancel(t *testing.T) {
	pub := &fakePublisher{}
	e, _, _ := newAutoTestEngine(t, pub, nil)

	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	defer st.Close()
	if err := SetAutoSettings(st, AutoSettings{Telemt: AutoModeCheck, Panel: AutoModeOff, Interval: time.Hour}); err != nil {
		t.Fatalf("SetAutoSettings: %v", err)
	}

	a := NewAutoUpdater(st, e)
	tick := make(chan time.Time)
	a.after = func(d time.Duration) <-chan time.Time { return tick }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		a.Run(ctx)
		close(done)
	}()

	// Fire one tick manually — no real wait, no dependency on the
	// configured interval actually elapsing.
	tick <- time.Now()
	waitFor(t, func() bool { return len(pub.Published()) >= 1 })

	cancel()
	waitFor(t, func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	})
}

// waitFor spin-waits (no time.Sleep) until cond reports true or the test
// times out — used for cross-goroutine synchronization in these tests
// instead of a fixed sleep.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition never became true")
		}
	}
}
