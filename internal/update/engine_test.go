package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/store"
)

// newTestEngine wires an Engine against fixture's fake GitHub server, a
// fresh in-memory store, and the given runner/targets — the common setup
// shared by every engine test below.
func newTestEngine(t *testing.T, fixture *fakeReleaseServer, runner host.Runner, targets map[string]Target, hub UpdatePublisher) (*Engine, store.Store) {
	t.Helper()
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	gh := NewClient()
	gh.BaseURL = fixture.URL

	e := NewEngine(EngineConfig{
		Runner:     runner,
		Store:      st,
		Targets:    targets,
		StagingDir: t.TempDir(),
		Github:     gh,
		Hub:        hub,
		Arch:       "x86_64",
		Variant:    "musl",
		Now:        func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
		NewRunID:   func() string { return "run1" },
	})
	return e, st
}

// setupHappyRelease registers a v2.0.0 release on fixture with a matching
// x86_64/musl asset (and correct checksum) for target "telemt", and
// returns the tarball's content bytes (the "new binary").
func setupHappyRelease(fixture *fakeReleaseServer, targetName string, content []byte) {
	assetName := AssetName(assetBaseName(targetName), "x86_64", "musl")
	tarBytes := content // caller passes already-built tar.gz bytes
	url := fixture.addAsset(assetName, tarBytes)
	sumURL := fixture.addAsset(assetName+".sha256", []byte(sha256Hex(tarBytes)+"  "+assetName+"\n"))
	fixture.releases = []Release{{
		Tag:    "v2.0.0",
		Assets: []Asset{{Name: assetName, BrowserDownloadURL: url}, {Name: assetName + ".sha256", BrowserDownloadURL: sumURL}},
	}}
}

func waitUnlocked(e *Engine) {
	for e.LockHeld() {
		runtime.Gosched()
	}
}

func TestApply_HappyPath_JournalsAllPhasesInOrder(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "telemt")
	if err := os.WriteFile(binaryPath, []byte("old-binary"), 0o755); err != nil {
		t.Fatalf("seed binary: %v", err)
	}

	fixture := newFakeReleaseServer(t)
	tarBytes := buildTarGz(t, "telemt", []byte("new-binary"))
	setupHappyRelease(fixture, TargetTelemt, tarBytes)

	target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", binaryPath: binaryPath, serviceName: "telemt", version: "v1.0.0"}
	runner := newTestRunner()
	pub := &fakePublisher{}
	e, st := newTestEngine(t, fixture, runner, map[string]Target{TargetTelemt: target}, pub)

	if err := e.Apply(context.Background(), TargetTelemt, "v2.0.0"); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	entries, err := st.ListUpdateJournal(TargetTelemt, 20)
	if err != nil {
		t.Fatalf("ListUpdateJournal: %v", err)
	}
	// ListUpdateJournal returns newest-first; reverse for readability.
	got := make([]string, len(entries))
	for i, e := range entries {
		got[len(entries)-1-i] = e.Phase
	}
	want := []string{PhaseChecking, PhaseDownloading, PhaseVerifying, PhaseStaging, PhaseInstalling, PhaseRestarting, PhaseHealth, PhaseDone}
	if len(got) != len(want) {
		t.Fatalf("phases = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("phase[%d] = %q, want %q (full: %v)", i, got[i], want[i], got)
		}
	}
	for _, e := range entries {
		if e.RunID != "run1" {
			t.Errorf("entry %+v: run_id = %q, want run1", e, e.RunID)
		}
		if e.VersionFrom != "v1.0.0" || e.VersionTo != "v2.0.0" {
			t.Errorf("entry %+v: versions wrong", e)
		}
	}

	calls := runner.CallsSnapshot()
	if len(calls) != 3 {
		t.Fatalf("runner calls = %+v, want 3 (backup install, main install, restart)", calls)
	}
	if calls[0].Kind != host.OpInstallBinary || calls[0].Args[host.ArgDest] != binaryPath+".bak" {
		t.Errorf("call[0] = %+v, want install-binary dest=%s.bak", calls[0], binaryPath)
	}
	if calls[1].Kind != host.OpInstallBinary || calls[1].Args[host.ArgDest] != binaryPath {
		t.Errorf("call[1] = %+v, want install-binary dest=%s", calls[1], binaryPath)
	}
	if calls[2].Kind != host.OpRestartService || calls[2].Args[host.ArgService] != "telemt" {
		t.Errorf("call[2] = %+v, want restart-service service=telemt", calls[2])
	}

	if _, err := os.Stat(filepath.Join(e.stagingDir, TargetTelemt)); !os.IsNotExist(err) {
		t.Errorf("staging dir not cleaned up: stat err = %v", err)
	}
	if len(pub.Published()) == 0 {
		t.Error("no events published to the hub")
	}
	if run, ok := e.ActiveRun(TargetTelemt); ok {
		t.Errorf("ActiveRun after completion = %+v, ok=true, want ok=false", run)
	}
}

func TestApply_ChecksumMismatch_FailsWithoutInstalling(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "telemt")
	os.WriteFile(binaryPath, []byte("old-binary"), 0o755)

	fixture := newFakeReleaseServer(t)
	tarBytes := buildTarGz(t, "telemt", []byte("new-binary"))
	assetName := AssetName("telemt", "x86_64", "musl")
	url := fixture.addAsset(assetName, tarBytes)
	// Wrong checksum on purpose.
	sumURL := fixture.addAsset(assetName+".sha256", []byte("deadbeef  "+assetName+"\n"))
	fixture.releases = []Release{{Tag: "v2.0.0", Assets: []Asset{
		{Name: assetName, BrowserDownloadURL: url},
		{Name: assetName + ".sha256", BrowserDownloadURL: sumURL},
	}}}

	target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", binaryPath: binaryPath, serviceName: "telemt", version: "v1.0.0"}
	runner := newTestRunner()
	e, st := newTestEngine(t, fixture, runner, map[string]Target{TargetTelemt: target}, nil)

	err := e.Apply(context.Background(), TargetTelemt, "v2.0.0")
	if err == nil {
		t.Fatal("Apply: want error on checksum mismatch")
	}

	entries, _ := st.ListUpdateJournal(TargetTelemt, 20)
	if len(entries) == 0 || entries[0].Phase != PhaseFailed {
		t.Fatalf("last journal entry = %+v, want phase=failed", entries)
	}
	if calls := runner.CallsSnapshot(); len(calls) != 0 {
		t.Errorf("runner calls = %+v, want none (verification failed before any install)", calls)
	}
}

func TestApply_LateFailures_RollBack(t *testing.T) {
	tests := []struct {
		name        string
		failInstall bool
		failRestart bool
		failHealth  bool
	}{
		{name: "installing", failInstall: true},
		{name: "restarting", failRestart: true},
		{name: "health", failHealth: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			binaryPath := filepath.Join(dir, "telemt")
			os.WriteFile(binaryPath, []byte("old-binary"), 0o755)

			fixture := newFakeReleaseServer(t)
			tarBytes := buildTarGz(t, "telemt", []byte("new-binary"))
			setupHappyRelease(fixture, TargetTelemt, tarBytes)

			restartCalls := 0
			target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", binaryPath: binaryPath, serviceName: "telemt", version: "v1.0.0"}
			if tc.failHealth {
				target.postRestart = func(context.Context) error { return errors.New("unhealthy") }
			}

			runner := newTestRunner()
			runner.RunFunc = func(op host.Op) (host.Output, error) {
				switch {
				case tc.failInstall && op.Kind == host.OpInstallBinary && op.Args[host.ArgDest] == binaryPath:
					return host.Output{}, errors.New("install failed")
				case tc.failRestart && op.Kind == host.OpRestartService && restartCalls == 0:
					restartCalls++
					return host.Output{}, errors.New("restart failed")
				default:
					return host.Output{}, nil
				}
			}

			e, st := newTestEngine(t, fixture, runner, map[string]Target{TargetTelemt: target}, nil)

			err := e.Apply(context.Background(), TargetTelemt, "v2.0.0")
			if err == nil {
				t.Fatal("Apply: want error")
			}

			entries, _ := st.ListUpdateJournal(TargetTelemt, 20)
			if len(entries) == 0 || entries[0].Phase != PhaseRolledBack {
				t.Fatalf("last journal entry = %+v, want phase=rolled_back", entries)
			}

			calls := runner.CallsSnapshot()
			var sawRestore bool
			for _, c := range calls {
				if c.Kind == host.OpRestoreBinary {
					sawRestore = true
					if c.Args[host.ArgBackup] != binaryPath+".bak" || c.Args[host.ArgDest] != binaryPath {
						t.Errorf("restore-binary args = %+v, want backup=%s.bak dest=%s", c.Args, binaryPath, binaryPath)
					}
				}
			}
			if !sawRestore {
				t.Errorf("runner calls = %+v, want a restore-binary op", calls)
			}
		})
	}
}

// degradedRunner mimics host.SelectRunner's fallback when no privileges
// are available: every Run reports host.ErrPrivilegesUnavailable.
type degradedRunner struct{}

func (degradedRunner) Run(context.Context, host.Op) (host.Output, error) {
	return host.Output{}, host.ErrPrivilegesUnavailable
}

// TestApply_DegradedRunner_FailsCleanlyWithoutPanicking covers the milestone
// invariant that a degraded Runner (no privileges) must never panic or
// block Apply — it fails at the first privileged op (saving the backup,
// in "staging") with a clear, typed error and a "failed" journal entry.
func TestApply_DegradedRunner_FailsCleanlyWithoutPanicking(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "telemt")
	os.WriteFile(binaryPath, []byte("old-binary"), 0o755)

	fixture := newFakeReleaseServer(t)
	tarBytes := buildTarGz(t, "telemt", []byte("new-binary"))
	setupHappyRelease(fixture, TargetTelemt, tarBytes)

	target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", binaryPath: binaryPath, serviceName: "telemt", version: "v1.0.0"}
	e, st := newTestEngine(t, fixture, degradedRunner{}, map[string]Target{TargetTelemt: target}, nil)

	err := e.Apply(context.Background(), TargetTelemt, "v2.0.0")
	if err == nil {
		t.Fatal("Apply with a degraded Runner: want an error, got nil")
	}

	entries, _ := st.ListUpdateJournal(TargetTelemt, 20)
	if len(entries) == 0 || entries[0].Phase != PhaseFailed {
		t.Fatalf("last journal entry = %+v, want phase=failed", entries)
	}
	if !strings.Contains(entries[0].Detail, host.ErrPrivilegesUnavailable.Error()) {
		t.Errorf("failed journal detail = %q, want it to mention %v", entries[0].Detail, host.ErrPrivilegesUnavailable)
	}
	if e.LockHeld() {
		t.Error("engine still locked after a degraded-Runner failure")
	}
}

func TestApply_SecondCall_ReturnsErrBusy(t *testing.T) {
	release := make(chan struct{})
	fixture := newFakeReleaseServer(t)
	tarBytes := buildTarGz(t, "telemt", []byte("new-binary"))
	setupHappyRelease(fixture, TargetTelemt, tarBytes)

	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "telemt")
	os.WriteFile(binaryPath, []byte("old-binary"), 0o755)

	target := &fakeTarget{name: TargetTelemt, repo: "owner/repo", binaryPath: binaryPath, serviceName: "telemt", version: "v1.0.0"}
	panelTarget := &fakeTarget{name: TargetPanel, repo: "owner/panel", binaryPath: filepath.Join(dir, "panel"), serviceName: "panel", version: "v1.0.0"}

	runner := newTestRunner()
	runner.RunFunc = func(op host.Op) (host.Output, error) {
		if op.Kind == host.OpRestartService {
			<-release
		}
		return host.Output{}, nil
	}

	e, _ := newTestEngine(t, fixture, runner, map[string]Target{TargetTelemt: target, TargetPanel: panelTarget}, nil)

	if err := e.StartApply(TargetTelemt, "v2.0.0"); err != nil {
		t.Fatalf("StartApply: %v", err)
	}
	if err := e.Apply(context.Background(), TargetPanel, "v2.0.0"); !errors.Is(err, ErrBusy) {
		t.Fatalf("second Apply err = %v, want ErrBusy", err)
	}

	close(release)
	waitUnlocked(e)
}
