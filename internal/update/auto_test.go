package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

	values := []AutoSettings{
		{Telemt: AutoModeApply, Panel: AutoModeCheck, Interval: 2 * time.Hour},
		{Telemt: AutoModeCheck, Panel: AutoModeOff, Interval: 12 * time.Hour},
	}
	for _, want := range values {
		if err := SetAutoSettings(st, want); err != nil {
			t.Fatalf("SetAutoSettings(%+v): %v", want, err)
		}
		got, err = GetAutoSettings(st)
		if err != nil || got != want {
			t.Fatalf("got %+v, %v; want %+v", got, err, want)
		}
	}
}

func TestSetAutoSettings_RejectsInvalidModeAndInterval(t *testing.T) {
	st, _ := store.NewMemory("")
	defer st.Close()

	if err := SetAutoSettings(st, AutoSettings{Telemt: "bogus", Panel: AutoModeOff, Interval: time.Hour}); !errors.Is(err, ErrInvalidAutoSettings) {
		t.Errorf("invalid mode error = %v, want ErrInvalidAutoSettings", err)
	}
	if err := SetAutoSettings(st, AutoSettings{Telemt: AutoModeOff, Panel: AutoModeOff, Interval: 30 * time.Minute}); !errors.Is(err, ErrInvalidAutoSettings) {
		t.Errorf("invalid interval error = %v, want ErrInvalidAutoSettings", err)
	}
}

func TestAutoSettings_ReopensDurableState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	st, err := store.NewMemory(path)
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	want := AutoSettings{Telemt: AutoModeCheck, Panel: AutoModeApply, Interval: 8 * time.Hour}
	if err := SetAutoSettings(st, want); err != nil {
		t.Fatalf("SetAutoSettings: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := store.NewMemory(path)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer reopened.Close()
	got, err := GetAutoSettings(reopened)
	if err != nil || got != want {
		t.Fatalf("got %+v, %v after reopen; want %+v", got, err, want)
	}
}

func TestGetAutoSettings_RejectsMalformedOrInvalidStoredRecord(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{name: "malformed JSON", raw: `{"telemt":`},
		{name: "invalid telemt mode", raw: `{"telemt":"bogus","panel":"off","interval":"2h"}`},
		{name: "invalid panel mode", raw: `{"telemt":"off","panel":"bogus","interval":"2h"}`},
		{name: "malformed interval", raw: `{"telemt":"off","panel":"off","interval":"sometimes"}`},
		{name: "interval below floor", raw: `{"telemt":"off","panel":"off","interval":"30m"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st, err := store.NewMemory("")
			if err != nil {
				t.Fatalf("store.NewMemory: %v", err)
			}
			defer st.Close()
			if err := st.SetSetting("auto_update", tt.raw); err != nil {
				t.Fatalf("seed stored record: %v", err)
			}
			if got, err := GetAutoSettings(st); err == nil {
				t.Fatalf("GetAutoSettings = %+v, nil; want error", got)
			}
		})
	}
}

type autoSettingsFailureStore struct {
	store.Store
	failOn int
	calls  int
}

func (s *autoSettingsFailureStore) SetSetting(key, value string) error {
	s.calls++
	if s.calls == s.failOn {
		return errors.New("persist settings: /private/panel-state.json is unavailable")
	}
	return s.Store.SetSetting(key, value)
}

func TestSetAutoSettings_PersistenceFailureKeepsCompleteSettings(t *testing.T) {
	for _, failOn := range []int{1, 2} {
		t.Run(fmt.Sprintf("failure boundary %d", failOn), func(t *testing.T) {
			st, err := store.NewMemory("")
			if err != nil {
				t.Fatalf("store.NewMemory: %v", err)
			}
			defer st.Close()

			before := AutoSettings{Telemt: AutoModeCheck, Panel: AutoModeOff, Interval: 2 * time.Hour}
			if err := SetAutoSettings(st, before); err != nil {
				t.Fatalf("seed settings: %v", err)
			}
			after := AutoSettings{Telemt: AutoModeApply, Panel: AutoModeApply, Interval: 12 * time.Hour}
			err = SetAutoSettings(&autoSettingsFailureStore{Store: st, failOn: failOn}, after)
			want := after
			if err != nil {
				want = before
			}
			got, getErr := GetAutoSettings(st)
			if getErr != nil || got != want {
				t.Fatalf("SetAutoSettings error = %v; got %+v, %v; want complete %+v", err, got, getErr, want)
			}
			if failOn == 1 && err == nil {
				t.Fatal("first setting write unexpectedly crossed the failure boundary")
			}
		})
	}
}

func TestSetAutoSettings_PersistsSingleCompleteRecord(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	defer st.Close()
	want := AutoSettings{Telemt: AutoModeApply, Panel: AutoModeCheck, Interval: 2 * time.Hour}
	if err := SetAutoSettings(st, want); err != nil {
		t.Fatalf("SetAutoSettings: %v", err)
	}
	raw, ok, err := st.GetSetting("auto_update")
	if err != nil || !ok {
		t.Fatalf("GetSetting(auto_update) = %q, %v, %v; want stored record", raw, ok, err)
	}
	var got map[string]string
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("stored record is not JSON: %v", err)
	}
	wantRecord := map[string]string{"telemt": "apply", "panel": "check", "interval": "2h0m0s"}
	if len(got) != len(wantRecord) {
		t.Fatalf("stored record = %#v, want %#v", got, wantRecord)
	}
	for key, wantValue := range wantRecord {
		if got[key] != wantValue {
			t.Fatalf("stored record[%q] = %q, want %q", key, got[key], wantValue)
		}
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
