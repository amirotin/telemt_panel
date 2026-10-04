package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
	"github.com/amirotin/telemt_panel/internal/store"
)

func TestApply_InterruptedSelfRestart(t *testing.T) {
	for _, tc := range []struct {
		name          string
		target        string
		stopping      bool
		noContext     bool
		signaled      bool
		wantPhase     string
		wantBinary    string
		wantCalls     int
		cancelDelay   time.Duration
		wantGraceWait time.Duration
	}{
		{"stopping panel hands off interrupted restart", TargetPanel, true, false, true, PhaseRestarting, "new-binary", 1, 0, 0},
		{"live panel rolls back interrupted restart", TargetPanel, false, false, true, PhaseRolledBack, "old-binary", 2, 0, 0},
		{"nil lifecycle context retains rollback", TargetPanel, false, true, true, PhaseRolledBack, "old-binary", 2, 0, 0},
		{"ordinary restart failure still rolls back during shutdown", TargetPanel, true, false, false, PhaseRolledBack, "old-binary", 2, 0, 0},
		{"telemt interrupted restart still rolls back during shutdown", TargetTelemt, true, false, true, PhaseRolledBack, "old-binary", 2, 0, 0},
		{"signal before lifecycle cancellation hands off restart", TargetPanel, false, false, true, PhaseRestarting, "new-binary", 1, 50 * time.Millisecond, 0},
		{"live panel rolls back after shutdown grace", TargetPanel, false, false, true, PhaseRolledBack, "old-binary", 2, 0, 100 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			binaryPath := filepath.Join(dir, "binary")
			statePath := filepath.Join(dir, "panel-state.json")
			staging := filepath.Join(dir, "staging")
			if err := os.WriteFile(binaryPath, []byte("old-binary"), 0o755); err != nil {
				t.Fatal(err)
			}
			st, err := store.NewMemory(statePath)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			lifecycle, cancel := context.WithCancel(context.Background())
			defer cancel()
			var panelContext context.Context = lifecycle
			if tc.noContext {
				panelContext = nil
			}
			calls := 0
			var interruptedAt time.Time
			manager := &hosttest.ServiceManager{RestartFunc: func(string) error {
				calls++
				if calls > 1 {
					return nil
				}
				if tc.stopping {
					cancel()
				}
				systemd := host.NewSystemd(func(ctx context.Context, _ string, _ ...string) ([]byte, []byte, error) {
					if tc.signaled {
						return host.OSCmdRunner(ctx, "/bin/sh", "-c", "kill -TERM $$")
					}
					return host.OSCmdRunner(ctx, "false")
				})
				err := systemd.Restart(context.Background(), "panel")
				interruptedAt = time.Now()
				if tc.cancelDelay > 0 {
					go func() {
						timer := time.NewTimer(tc.cancelDelay)
						defer timer.Stop()
						select {
						case <-timer.C:
							cancel()
						case <-lifecycle.Done():
						}
					}()
				}
				return err
			}}
			runner := host.NewDirectRunner(host.AllowLists{
				StagingPrefix: staging, BinaryPaths: []string{binaryPath, binaryPath + ".bak"}, Services: []string{"panel"},
			}, manager, nil)
			fixture := newFakeReleaseServer(t)
			setupHappyRelease(fixture, tc.target, buildTarGz(t, "binary", []byte("new-binary")))
			fixture.releases[0].Tag = "v1.0.0-rc.2"
			github := NewClient()
			github.BaseURL = fixture.URL
			shutdownGrace := 100 * time.Millisecond
			if tc.cancelDelay > 0 {
				shutdownGrace = 0
			}
			e := NewEngine(EngineConfig{
				Runner: runner, Store: st, StagingDir: staging, Github: github, Arch: "x86_64", Variant: "musl",
				Targets:               map[string]Target{tc.target: &fakeTarget{name: tc.target, repo: "owner/repo", binaryPath: binaryPath, serviceName: "panel", version: "1.0.0-rc.1"}},
				PanelLifecycleContext: panelContext,
				PanelShutdownGrace:    shutdownGrace,
			})
			if tc.wantPhase == PhaseRestarting {
				err = e.StartApply(tc.target, "v1.0.0-rc.2")
				if err == nil {
					waitUnlocked(e)
				}
			} else {
				err = e.Apply(context.Background(), tc.target, "v1.0.0-rc.2")
			}
			if tc.wantPhase == PhaseRestarting && err != nil {
				t.Fatalf("expected restart handoff, got %v", err)
			}
			if tc.wantPhase == PhaseRolledBack && err == nil {
				t.Fatal("expected the genuine restart failure to remain an error")
			}
			if tc.wantGraceWait > 0 && time.Since(interruptedAt) < tc.wantGraceWait {
				t.Fatalf("rolled back before shutdown grace elapsed: waited %s; want at least %s", time.Since(interruptedAt), tc.wantGraceWait)
			}
			entries, err := st.ListUpdateJournal(tc.target, 20)
			if err != nil || len(entries) == 0 || entries[0].Phase != tc.wantPhase {
				t.Fatalf("journal = %+v, err=%v; want phase %s", entries, err, tc.wantPhase)
			}
			data, err := os.ReadFile(binaryPath)
			if err != nil || string(data) != tc.wantBinary || calls != tc.wantCalls {
				t.Fatalf("binary=%q, err=%v, restart calls=%d; want %s and %d", data, err, calls, tc.wantBinary, tc.wantCalls)
			}
			if tc.wantPhase != PhaseRestarting {
				return
			}
			for _, entry := range entries {
				if entry.Phase == PhaseDone || entry.Phase == PhaseRollingBack {
					t.Fatalf("old process claimed an outcome before replacement startup: %+v", entry)
				}
			}
			if !errors.Is(lifecycle.Err(), context.Canceled) {
				t.Fatal("fixture lifecycle did not stop")
			}
			if err := st.Close(); err != nil {
				t.Fatal(err)
			}
			replacement, err := store.NewMemory(statePath)
			if err != nil {
				t.Fatal(err)
			}
			defer replacement.Close()
			pending, err := replacement.ListUpdateJournal(TargetPanel, 1)
			if err != nil || len(pending) != 1 || pending[0].Phase != PhaseRestarting {
				t.Fatalf("persisted handoff = %+v, err=%v", pending, err)
			}
			if err := ReconcileStartup(replacement, "1.0.0-rc.2"); err != nil {
				t.Fatal(err)
			}
			completed, _ := replacement.ListUpdateJournal(TargetPanel, 1)
			if len(completed) != 1 || completed[0].Phase != PhaseDone || completed[0].RunID != pending[0].RunID {
				t.Fatalf("new process failed to confirm persisted run: %+v", completed)
			}
		})
	}
}
