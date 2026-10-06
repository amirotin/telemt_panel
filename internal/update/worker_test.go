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

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/store"
)

func newWorkerTestClient(t *testing.T, launch func(context.Context, []string) error) *WorkerClient {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "registration.json"), []byte(`{"version":1,"command":["/bin/true"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := NewWorkerClient(dir, launch)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestWorkerQueueBlocksHostControlsBeforeWorkerStarts(t *testing.T) {
	client := newWorkerTestClient(t, func(context.Context, []string) error { return nil })
	if err := client.Submit(context.Background(), TargetPanel, "v1.1.0", "v1.0.0"); err != nil {
		t.Fatal(err)
	}
	second, err := NewWorkerClient(client.stateDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.WithHostControl(func() error { t.Fatal("host control entered while queued"); return nil }); !errors.Is(err, ErrBusy) {
		t.Fatalf("host control = %v", err)
	}
	if err := second.Submit(context.Background(), TargetTelemt, "v3.5.14", "v3.5.13"); !errors.Is(err, ErrBusy) {
		t.Fatalf("second update = %v", err)
	}
}

func TestWorkerLaunchFailureIsDurableAndReleasesQueue(t *testing.T) {
	client := newWorkerTestClient(t, func(context.Context, []string) error { return errors.New("unit missing") })
	if err := client.Submit(context.Background(), TargetPanel, "v1.1.0", "v1.0.0"); err == nil {
		t.Fatal("launch succeeded")
	}
	entries, err := client.Journal(TargetPanel, 10)
	if err != nil || len(entries) == 0 || entries[0].Phase != PhaseFailed {
		t.Fatalf("journal = %+v, %v", entries, err)
	}
	if err := client.WithHostControl(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
}

type workerFixtureRunner struct{ before func(host.Op) error }

func (r workerFixtureRunner) Run(_ context.Context, op host.Op) (host.Output, error) {
	if r.before != nil {
		if err := r.before(op); err != nil {
			return host.Output{}, err
		}
	}
	switch op.Kind {
	case host.OpInstallBinary, host.OpRestoreBinary:
		source := op.Args[host.ArgStaging]
		if source == "" {
			source = op.Args[host.ArgBackup]
		}
		data, err := os.ReadFile(source)
		if err != nil {
			return host.Output{}, err
		}
		return host.Output{}, os.WriteFile(op.Args[host.ArgDest], data, 0o755)
	case "remove-binary":
		err := os.Remove(op.Args[host.ArgDest])
		if errors.Is(err, os.ErrNotExist) {
			err = nil
		}
		return host.Output{}, err
	}
	return host.Output{}, nil
}

func workerFixture(t *testing.T) (*WorkerClient, WorkerConfig, string) {
	t.Helper()
	client := newWorkerTestClient(t, func(context.Context, []string) error { return nil })
	dir := t.TempDir()
	binary := filepath.Join(dir, "panel")
	if err := os.WriteFile(binary, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	fixture := newFakeReleaseServer(t)
	name := AssetName("telemt-panel", "x86_64", "musl")
	url := fixture.addAsset(name, buildTarGz(t, "panel", []byte("candidate")))
	fixture.releases = []Release{{Tag: "v1.1.0", Assets: []Asset{{Name: name, BrowserDownloadURL: url}}}}
	gh := NewClient()
	gh.BaseURL = fixture.URL
	cfg := WorkerConfig{StateDir: client.stateDir, DataDir: dir, RecoveryConfig: json.RawMessage(`{"saved":true}`), Engine: EngineConfig{
		Runner: workerFixtureRunner{}, Github: gh, StagingDir: filepath.Join(dir, "staging"), Arch: "x86_64", Variant: "musl",
		Targets: map[string]Target{TargetPanel: &fakeTarget{name: TargetPanel, repo: "owner/repo", binaryPath: binary, serviceName: "panel"}},
	}, Health: func(context.Context, string, string) error { return nil }}
	if err := client.Submit(context.Background(), TargetPanel, "v1.1.0", "v1.0.0"); err != nil {
		t.Fatal(err)
	}
	return client, cfg, binary
}

func TestWorkerUpdatesWithoutChecksumAndCleansArtifacts(t *testing.T) {
	client, cfg, binary := workerFixture(t)
	if err := RunWorker(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(binary)
	if err != nil || string(data) != "candidate" {
		t.Fatalf("binary=%q, %v", data, err)
	}
	entries, err := client.Journal(TargetPanel, 1)
	if err != nil || len(entries) != 1 || entries[0].Phase != PhaseDone {
		t.Fatalf("journal=%+v,%v", entries, err)
	}
	if _, err := os.Stat(binary + ".bak"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup left: %v", err)
	}
	if _, err := os.Stat(StagingRunDir(cfg.Engine.StagingDir, TargetPanel)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging left: %v", err)
	}
}

func TestWorkerFailedCandidateRestoresStateAndConfirmsOldVersion(t *testing.T) {
	client, cfg, binary := workerFixture(t)
	state := filepath.Join(cfg.DataDir, "panel-state.json")
	if err := os.WriteFile(state, []byte("old state"), 0o640); err != nil {
		t.Fatal(err)
	}
	cfg.SnapshotPaths = []string{state, filepath.Join(cfg.DataDir, "history.db"), filepath.Join(cfg.DataDir, "history.db-wal")}
	var versions []string
	cfg.Health = func(_ context.Context, _ string, version string) error {
		versions = append(versions, version)
		if version == "v1.1.0" {
			if err := os.WriteFile(state, []byte("new incompatible state"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(cfg.DataDir, "history.db-wal"), []byte("candidate WAL"), 0o600); err != nil {
				t.Fatal(err)
			}
			return errors.New("candidate never became ready")
		}
		return nil
	}
	if err := RunWorker(context.Background(), cfg); err == nil {
		t.Fatal("failed candidate reported success")
	}
	data, _ := os.ReadFile(binary)
	if string(data) != "old" {
		t.Fatalf("binary=%q", data)
	}
	data, _ = os.ReadFile(state)
	if string(data) != "old state" {
		t.Fatalf("state=%q", data)
	}
	info, _ := os.Stat(state)
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("restored mode=%v", info.Mode())
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "history.db-wal")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("candidate WAL left: %v", err)
	}
	if len(versions) != 2 || versions[1] != "v1.0.0" {
		t.Fatalf("health versions=%v", versions)
	}
	entries, _ := client.Journal(TargetPanel, 1)
	if len(entries) != 1 || entries[0].Phase != PhaseRolledBack {
		t.Fatalf("journal=%+v", entries)
	}
}

func TestWorkerRecoverySkipsLiveWorkerAndRestoresBeforeStartup(t *testing.T) {
	client, cfg, binary := workerFixture(t)
	if err := os.WriteFile(binary+".bak", []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("broken"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := loadWorkerState(client.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	s.Task.RecoveryConfig = cfg.RecoveryConfig
	s.Task.BackupPath = binary + ".bak"
	s.Task.PublishIntent = true
	s.Task.StopIntent = true
	if err := s.transition(client.stateDir, PhaseRestarting, ""); err != nil {
		t.Fatal(err)
	}
	lock, err := workerLock(client.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := RecoverWorker(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(binary)
	if string(data) != "broken" {
		t.Fatalf("active worker rollback happened: %q", data)
	}
	lock.Close()
	var operations []string
	cfg.Engine.Runner = workerFixtureRunner{before: func(op host.Op) error { operations = append(operations, op.Kind); return nil }}
	cfg.Health = func(context.Context, string, string) error {
		t.Fatal("wrapper waited for its own readiness")
		return nil
	}
	cfg.Launch = func(context.Context, []string) error { return errors.New("init unavailable") }
	if err := RecoverWorker(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(binary)
	if string(data) != "old" {
		t.Fatalf("restored binary=%q", data)
	}
	for _, op := range operations {
		if op == host.OpStopService || op == host.OpStartService || op == host.OpRestartService {
			t.Fatalf("wrapper lifecycle deadlock: %v", operations)
		}
	}
	if _, err := os.Stat(binary + ".bak"); err != nil {
		t.Fatalf("backup removed before old health: %v", err)
	}
	cfg.Health = func(_ context.Context, _ string, version string) error {
		if version != "v1.0.0" {
			t.Fatalf("version=%s", version)
		}
		return nil
	}
	if err := RunWorker(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	entries, _ := client.Journal(TargetPanel, 1)
	if len(entries) != 1 || entries[0].Phase != PhaseRolledBack {
		t.Fatalf("journal=%+v", entries)
	}
}

func TestWorkerEngineCloseLeavesQueuedWorkAndMergesJournal(t *testing.T) {
	client := newWorkerTestClient(t, func(context.Context, []string) error { return nil })
	fixture := newFakeReleaseServer(t)
	target := &fakeTarget{name: TargetPanel, version: "v1.0.0"}
	engine, state := newTestEngine(t, fixture, newTestRunner(), map[string]Target{TargetPanel: target}, nil)
	engine.worker = client
	if err := state.AppendUpdateJournal(store.UpdateJournalEntry{Target: TargetPanel, RunID: "legacy", Phase: PhaseDone, TS: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := engine.StartApply(TargetPanel, "v1.1.0"); err != nil {
		t.Fatal(err)
	}
	engine.Close()
	if _, active := client.ActiveRun(TargetPanel); !active {
		t.Fatal("closing panel canceled independent queued task")
	}
	journal, err := engine.Journal(context.Background(), TargetPanel, 10)
	if err != nil || len(journal) != 2 || journal[1].RunID != "legacy" {
		t.Fatalf("journal=%+v,%v", journal, err)
	}
}

func TestWorkerFailedStartRollsBackAndRetainsUncertainBackup(t *testing.T) {
	for _, oldHealthy := range []bool{true, false} {
		t.Run(fmt.Sprint(oldHealthy), func(t *testing.T) {
			client, cfg, binary := workerFixture(t)
			starts := 0
			cfg.Engine.Runner = workerFixtureRunner{before: func(op host.Op) error {
				if op.Kind == host.OpStartService {
					starts++
					if starts == 1 {
						return errors.New("candidate service cannot start")
					}
				}
				return nil
			}}
			cfg.Health = func(_ context.Context, _ string, version string) error {
				if version != "v1.0.0" {
					t.Fatalf("unexpected health check %q", version)
				}
				if !oldHealthy {
					return errors.New("old readiness uncertain")
				}
				return nil
			}
			if err := RunWorker(context.Background(), cfg); err == nil {
				t.Fatal("failed start reported success")
			}
			data, _ := os.ReadFile(binary)
			if string(data) != "old" {
				t.Fatalf("binary=%q", data)
			}
			_, err := os.Stat(binary + ".bak")
			if oldHealthy && !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("backup cleanup=%v", err)
			}
			if !oldHealthy && err != nil {
				t.Fatalf("uncertain backup removed: %v", err)
			}
			if client.Busy() == oldHealthy {
				t.Fatalf("busy=%v oldHealthy=%v", client.Busy(), oldHealthy)
			}
		})
	}
}

func TestWorkerPersistsIntentBeforeProtectedOperations(t *testing.T) {
	client, cfg, binary := workerFixture(t)
	var sawStop, sawInstall bool
	cfg.Engine.Runner = workerFixtureRunner{before: func(op host.Op) error {
		s, err := loadWorkerState(client.stateDir)
		if err != nil {
			t.Fatal(err)
		}
		if op.Kind == host.OpStopService {
			sawStop = true
			if !s.Task.StopIntent {
				t.Fatal("stop without durable intent")
			}
		}
		if op.Kind == host.OpInstallBinary && op.Args[host.ArgDest] == binary {
			sawInstall = true
			if !s.Task.PublishIntent || !s.Task.SnapshotComplete || s.Task.BackupPath == "" {
				t.Fatalf("incomplete recovery before install: %+v", s.Task)
			}
		}
		return nil
	}}
	if err := RunWorker(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if !sawStop || !sawInstall {
		t.Fatal("fixture did not execute stop and install")
	}
}

func TestWorkerCancellationAfterPublicationStillRestoresOldVersion(t *testing.T) {
	client, cfg, binary := workerFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg.Health = func(ctx context.Context, _ string, version string) error {
		if version == "v1.1.0" {
			cancel()
			return ctx.Err()
		}
		if err := ctx.Err(); err != nil {
			t.Fatalf("rollback inherited canceled context: %v", err)
		}
		return nil
	}
	if err := RunWorker(ctx, cfg); err == nil {
		t.Fatal("canceled update succeeded")
	}
	data, _ := os.ReadFile(binary)
	if string(data) != "old" {
		t.Fatalf("binary=%q", data)
	}
	entries, _ := client.Journal(TargetPanel, 1)
	if len(entries) != 1 || entries[0].Phase != PhaseRolledBack {
		t.Fatalf("journal=%+v", entries)
	}
}

func TestWorkerRejectsUnrestorableSnapshotBeforeStopping(t *testing.T) {
	_, cfg, binary := workerFixture(t)
	cfg.SnapshotPaths = []string{filepath.Join(t.TempDir(), "absent-parent", "config.toml")}
	cfg.Engine.Runner = workerFixtureRunner{before: func(op host.Op) error {
		if op.Kind == host.OpStopService {
			t.Fatal("stopped panel before verifying snapshot can be restored")
		}
		return nil
	}}
	if err := RunWorker(context.Background(), cfg); err == nil {
		t.Fatal("unrestorable snapshot accepted")
	}
	data, _ := os.ReadFile(binary)
	if string(data) != "old" {
		t.Fatalf("binary=%q", data)
	}
}

func TestWorkerStartupFinishesInterruptedSuccessfulCleanup(t *testing.T) {
	client, cfg, binary := workerFixture(t)
	if err := os.WriteFile(binary+".bak", []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary+".tmp", []byte("incomplete staging"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := loadWorkerState(client.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	s.Task.RecoveryConfig = cfg.RecoveryConfig
	s.Task.BackupPath = binary + ".bak"
	if err := s.transition(client.stateDir, PhaseDone, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadWorkerRecoveryConfig(client.stateDir); err != nil {
		t.Fatalf("successful cleanup metadata unavailable: %v", err)
	}
	if err := RecoverWorker(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{binary + ".bak", binary + ".tmp"} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("cleanup retained %s: %v", path, err)
		}
	}
	if _, err := ReadWorkerRecoveryConfig(client.stateDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("finished recovery config retained: %v", err)
	}
}

func TestWorkerQueuedStartTimeoutReleasesOnlyUnclaimedTask(t *testing.T) {
	client := newWorkerTestClient(t, func(context.Context, []string) error { return nil })
	if err := client.Submit(context.Background(), TargetPanel, "v1.1.0", "v1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := client.failUnstarted(time.Now()); err != nil {
		t.Fatal(err)
	}
	if !client.Busy() {
		t.Fatal("fresh queue expired")
	}
	lock, err := workerLock(client.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.failUnstarted(time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	lock.Close()
	if !client.Busy() {
		t.Fatal("active execution lock ignored")
	}
	if err := client.failUnstarted(time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if client.Busy() {
		t.Fatal("unstarted accepted init task blocked updates forever")
	}
	entries, _ := client.Journal(TargetPanel, 1)
	if len(entries) != 1 || entries[0].Phase != PhaseFailed {
		t.Fatalf("journal=%+v", entries)
	}
}

func TestWorkerJournalFailureDoesNotPreventDurableRollback(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission fault requires nonroot fixture")
	}
	client, cfg, binary := workerFixture(t)
	t.Cleanup(func() { _ = os.Chmod(client.stateDir, 0o700) })
	oldChecked := false
	cfg.Health = func(_ context.Context, _ string, version string) error {
		if version == "v1.1.0" {
			if err := os.Chmod(client.stateDir, 0o500); err != nil {
				t.Fatal(err)
			}
			return errors.New("candidate unhealthy while journal unavailable")
		}
		oldChecked = true
		return nil
	}
	if err := RunWorker(context.Background(), cfg); err == nil {
		t.Fatal("journal fault disappeared")
	}
	data, _ := os.ReadFile(binary)
	if string(data) != "old" || !oldChecked {
		t.Fatalf("rollback blocked by journal fault: binary=%q health=%v", data, oldChecked)
	}
	if _, err := os.Stat(binary + ".bak"); err != nil {
		t.Fatalf("unconfirmed recovery backup removed: %v", err)
	}
}

func TestWorkerStartupRestoresDespiteJournalWriteFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission fault requires nonroot fixture")
	}
	client, cfg, binary := workerFixture(t)
	if err := os.WriteFile(binary+".bak", []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("broken"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := loadWorkerState(client.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	s.Task.RecoveryConfig = cfg.RecoveryConfig
	s.Task.BackupPath = binary + ".bak"
	s.Task.PublishIntent = true
	s.Task.StopIntent = true
	if err := s.transition(client.stateDir, PhaseRestarting, ""); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(client.stateDir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(client.stateDir, 0o700) })
	if err := RecoverWorker(context.Background(), cfg); err != nil {
		t.Fatalf("restored startup must proceed even while journal unavailable: %v", err)
	}
	data, _ := os.ReadFile(binary)
	if string(data) != "old" {
		t.Fatalf("restored binary=%q", data)
	}
	if _, err := os.Stat(binary + ".bak"); err != nil {
		t.Fatalf("recovery backup removed: %v", err)
	}
}

func TestWorkerResumesOrphanedPrepublicationTask(t *testing.T) {
	launches := 0
	client := newWorkerTestClient(t, func(context.Context, []string) error { launches++; return nil })
	if err := client.Submit(context.Background(), TargetPanel, "v1.1.0", "v1.0.0"); err != nil {
		t.Fatal(err)
	}
	s, err := loadWorkerState(client.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	s.Task.RecoveryConfig = json.RawMessage(`{"saved":true}`)
	if err := s.transition(client.stateDir, PhaseDownloading, ""); err != nil {
		t.Fatal(err)
	}
	lock, err := workerLock(client.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.ResumeRecovery(context.Background()); err != nil {
		t.Fatal(err)
	}
	if launches != 1 {
		t.Fatal("restarted active worker")
	}
	lock.Close()
	if err := client.ResumeRecovery(context.Background()); err != nil {
		t.Fatal(err)
	}
	if launches != 2 {
		t.Fatal("orphaned started task was never resumed")
	}
}

func TestWorkerBackupPublicationErrorStillCleansPublishedBackup(t *testing.T) {
	_, cfg, binary := workerFixture(t)
	cfg.Engine.Runner = workerFixtureRunner{before: func(op host.Op) error {
		if op.Kind == host.OpInstallBinary && op.Args[host.ArgDest] == binary+".bak" {
			if err := os.WriteFile(binary+".bak", []byte("old"), 0o755); err != nil {
				t.Fatal(err)
			}
			return errors.New("backup published but directory fsync failed")
		}
		return nil
	}}
	if err := RunWorker(context.Background(), cfg); err == nil {
		t.Fatal("backup durability failure accepted")
	}
	if _, err := os.Stat(binary + ".bak"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("published backup leaked: %v", err)
	}
	data, _ := os.ReadFile(binary)
	if string(data) != "old" {
		t.Fatalf("live binary=%q", data)
	}
}

func TestWorkerRecoveryRecreatesVolatileDataDirectories(t *testing.T) {
	client, cfg, binary := workerFixture(t)
	cfg.DataDir = filepath.Join(t.TempDir(), "volatile", "data")
	path := filepath.Join(cfg.DataDir, "history", "rows.db")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("old durable snapshot"), 0o640); err != nil {
		t.Fatal(err)
	}
	snapshots, err := snapshotWorkerFiles(client.stateDir, []string{path})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary+".bak", []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := loadWorkerState(client.stateDir)
	if err != nil {
		t.Fatal(err)
	}
	s.Task.RecoveryConfig = cfg.RecoveryConfig
	s.Task.BackupPath = binary + ".bak"
	s.Task.StopIntent = true
	s.Task.PublishIntent = true
	s.Task.Snapshots = snapshots
	s.Task.SnapshotComplete = true
	if err := s.transition(client.stateDir, PhaseRestarting, ""); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(cfg.DataDir); err != nil {
		t.Fatal(err)
	}
	if err := RecoverWorker(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "old durable snapshot" {
		t.Fatalf("recovered data=%q,%v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("recovered metadata=%v,%v", info, err)
	}
}
