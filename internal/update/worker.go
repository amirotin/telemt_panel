package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/store"
)

// WorkerConfig contains independent-process dependencies. Store and Worker in
// Engine must be nil: this process never writes the live panel-state store.
type WorkerConfig struct {
	StateDir       string
	DataDir        string
	Engine         EngineConfig
	RecoveryConfig json.RawMessage
	SnapshotPaths  []string
	Health         func(context.Context, string, string) error
	// ProbeCandidate checks operational protocol compatibility before stopping a panel.
	ProbeCandidate func(context.Context, string) error
	Launch         func(context.Context, []string) error
}

type independentWorker struct {
	cfg    WorkerConfig
	e      *Engine
	s      *workerState
	target Target
}

// RunWorker executes queued work under a process lock independent of panel life.
func RunWorker(ctx context.Context, cfg WorkerConfig) error {
	lock, err := waitWorkerLock(ctx, cfg.StateDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	s, err := loadWorkerState(cfg.StateDir)
	if err != nil {
		return err
	}
	if !s.active() {
		return nil
	}
	w, err := newIndependentWorker(cfg, s)
	if err != nil {
		return err
	}
	defer w.e.Close()
	if s.Task.RecoveryReady {
		return w.finishRecovery(ctx)
	}
	if len(s.Task.RecoveryConfig) != 0 {
		if !s.Task.StopIntent && !s.Task.PublishIntent {
			if err := w.phase(PhaseFailed, "update interrupted before publication"); err != nil {
				return err
			}
			return w.cleanup()
		}
		return w.rollback(errors.New("interrupted update"))
	}
	s.Task.RecoveryConfig = append(json.RawMessage(nil), cfg.RecoveryConfig...)
	if len(s.Task.RecoveryConfig) == 0 {
		return errors.New("update worker requires saved recovery configuration")
	}
	if err := saveWorkerState(cfg.StateDir, s); err != nil {
		return err
	}
	if err := w.install(ctx); err != nil {
		// Reload durable intent: a failed terminal write must retain backup and
		// recover even though the attempted in-memory transition cleared flags.
		persisted, readErr := loadWorkerState(cfg.StateDir)
		if readErr != nil {
			return errors.Join(err, readErr)
		}
		w.s = persisted
		if !persisted.active() {
			return err
		}
		if persisted.Task.StopIntent || persisted.Task.PublishIntent {
			return w.rollback(err)
		}
		journalErr := w.phase(PhaseFailed, err.Error())
		if journalErr != nil {
			return errors.Join(err, journalErr)
		}
		cleanupErr := w.cleanup()
		return errors.Join(err, journalErr, cleanupErr)
	}
	return nil
}

func newIndependentWorker(cfg WorkerConfig, s *workerState) (*independentWorker, error) {
	target := cfg.Engine.Targets[s.Task.Status.Target]
	if target == nil {
		return nil, ErrUnknownTarget
	}
	if cfg.Health == nil || cfg.Engine.Runner == nil {
		return nil, errors.New("update worker requires runner and readiness probe")
	}
	if s.Task.Status.Target == TargetPanel && cfg.DataDir == "" {
		return nil, errors.New("panel update requires persistent data directory")
	}
	cfg.Engine.Worker = nil
	cfg.Engine.Store = nil
	cfg.Engine.Hub = nil
	return &independentWorker{cfg: cfg, e: NewEngine(cfg.Engine), s: s, target: target}, nil
}

func (w *independentWorker) phase(phase, detail string) error {
	return w.s.transition(w.cfg.StateDir, phase, detail)
}
func (w *independentWorker) service(ctx context.Context, kind string) error {
	_, err := w.e.runner.Run(ctx, host.Op{Kind: kind, Args: map[string]string{host.ArgService: w.target.ServiceName()}})
	return err
}

func (w *independentWorker) install(ctx context.Context) error {
	task := w.s.Task
	status := task.Status
	releases, err := w.e.github.ListReleases(ctx, w.target.Repo(), w.e.githubToken)
	if err != nil {
		return err
	}
	release, ok := findRelease(releases, status.VersionTo)
	if !ok {
		return fmt.Errorf("release not found: %s", status.VersionTo)
	}
	asset, _ := w.e.assetMatcher(status.Target)(release.Assets)
	if asset == nil {
		return errors.New("no release asset matches this host and build profile")
	}
	runDir := StagingRunDir(w.e.stagingDir, status.Target)
	if err = os.RemoveAll(runDir); err != nil {
		return err
	}
	if err = os.MkdirAll(runDir, 0o700); err != nil {
		return err
	}
	if err = w.phase(PhaseDownloading, ""); err != nil {
		return err
	}
	archive := filepath.Join(runDir, "release.tar.gz")
	if err = w.e.download(ctx, asset.BrowserDownloadURL, archive); err != nil {
		return err
	}
	if err = w.phase(PhaseStaging, ""); err != nil {
		return err
	}
	binary, err := extractSingleBinary(archive, runDir)
	if err != nil {
		return err
	}
	if status.Target == TargetPanel && w.cfg.ProbeCandidate != nil {
		if err = w.cfg.ProbeCandidate(ctx, binary); err != nil {
			return err
		}
	}
	if status.Target == TargetPanel {
		if err := preflightWorkerSnapshots(w.cfg.SnapshotPaths); err != nil {
			return err
		}
	}
	backup := filepath.Join(runDir, "backup")
	if err = copyWorkerFile(w.target.BinaryPath(), backup, 0o755); err != nil {
		return fmt.Errorf("stage current binary: %w", err)
	}
	task.BackupPath = w.target.BinaryPath() + ".bak"
	if err = saveWorkerState(w.cfg.StateDir, w.s); err != nil {
		return err
	}
	if _, err = w.e.runner.Run(ctx, host.Op{Kind: host.OpInstallBinary, Args: map[string]string{host.ArgStaging: backup, host.ArgDest: task.BackupPath}}); err != nil {
		return err
	}
	if err = saveWorkerState(w.cfg.StateDir, w.s); err != nil {
		return err
	}
	if status.Target == TargetPanel {
		task.StopIntent = true
		if err = saveWorkerState(w.cfg.StateDir, w.s); err != nil {
			return err
		}
		if err = w.service(ctx, host.OpStopService); err != nil {
			return fmt.Errorf("stop panel for snapshot: %w", err)
		}
		lock, err := store.AcquireDataDirLock(w.cfg.DataDir)
		if err != nil {
			return err
		}
		task.Snapshots, err = snapshotWorkerFiles(w.cfg.StateDir, w.cfg.SnapshotPaths)
		if err == nil {
			task.SnapshotComplete = true
			err = saveWorkerState(w.cfg.StateDir, w.s)
		}
		err = errors.Join(err, lock.Close())
		if err != nil {
			return err
		}
	}
	task.PublishIntent = true
	if err = w.phase(PhaseInstalling, ""); err != nil {
		return err
	}
	if _, err = w.e.runner.Run(ctx, host.Op{Kind: host.OpInstallBinary, Args: map[string]string{host.ArgStaging: binary, host.ArgDest: w.target.BinaryPath()}}); err != nil {
		return err
	}
	if err = w.phase(PhaseRestarting, ""); err != nil {
		return err
	}
	operation := host.OpRestartService
	if status.Target == TargetPanel {
		operation = host.OpStartService
	}
	if err = w.service(ctx, operation); err != nil {
		return fmt.Errorf("start candidate: %w", err)
	}
	if err = w.phase(PhaseHealth, ""); err != nil {
		return err
	}
	if err = w.cfg.Health(ctx, status.Target, status.VersionTo); err != nil {
		return fmt.Errorf("candidate readiness: %w", err)
	}
	task.StopIntent = false
	task.PublishIntent = false
	if err = w.phase(PhaseDone, ""); err != nil {
		return err
	}
	return w.cleanup()
}

func (w *independentWorker) restore(ctx context.Context, offline bool) error {
	task := w.s.Task
	if !task.PublishIntent && !task.StopIntent {
		return nil
	}
	if !offline || task.Status.Target != TargetPanel {
		if err := w.service(ctx, host.OpStopService); err != nil {
			return fmt.Errorf("stop before rollback: %w", err)
		}
	}
	var release func() error
	if task.Status.Target == TargetPanel {
		lock, err := store.AcquireDataDirLock(w.cfg.DataDir)
		if err != nil {
			return err
		}
		release = lock.Close
		defer release()
	}
	if task.PublishIntent {
		if task.BackupPath == "" {
			return errors.New("no previous binary available")
		}
		if _, err := w.e.runner.Run(ctx, host.Op{Kind: host.OpRestoreBinary, Args: map[string]string{host.ArgBackup: task.BackupPath, host.ArgDest: w.target.BinaryPath()}}); err != nil {
			return fmt.Errorf("restore previous binary: %w", err)
		}
	}
	if task.SnapshotComplete {
		if err := restoreWorkerFiles(task.Snapshots); err != nil {
			return fmt.Errorf("restore previous data: %w", err)
		}
	}
	if offline && task.Status.Target != TargetPanel {
		return w.service(ctx, host.OpStartService)
	}
	return nil
}

func (w *independentWorker) rollback(cause error) error {
	// Cancellation ends the candidate attempt, not restoration of the old service.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	// Publication intent and immutable snapshots already authorize recovery.
	// A full/read-only journal must not prevent restoration of the old service.
	journalErr := w.phase(PhaseRollingBack, cause.Error())
	if err := w.restore(ctx, false); err != nil {
		return errors.Join(cause, journalErr, err, w.phase(PhaseFailed, "rollback incomplete: "+err.Error()))
	}
	if err := w.service(ctx, host.OpStartService); err != nil {
		return errors.Join(cause, journalErr, err, w.phase(PhaseFailed, "old service start failed: "+err.Error()))
	}
	if err := w.finishRecovery(ctx); err != nil {
		return errors.Join(cause, journalErr, err)
	}
	return fmt.Errorf("update rolled back: %w", cause)
}

func (w *independentWorker) finishRecovery(ctx context.Context) error {
	task := w.s.Task
	if err := w.cfg.Health(ctx, task.Status.Target, task.Status.VersionFrom); err != nil {
		return errors.Join(err, w.phase(PhaseFailed, "old version readiness unconfirmed: "+err.Error()))
	}
	task.StopIntent = false
	task.PublishIntent = false
	task.RecoveryReady = false
	if err := w.phase(PhaseRolledBack, task.Status.Detail); err != nil {
		return err
	}
	return w.cleanup()
}

func (w *independentWorker) cleanup() error {
	var errs []error
	if w.s.Task.BackupPath != "" {
		_, err := w.e.runner.Run(context.Background(), host.Op{Kind: host.OpRemoveBinary, Args: map[string]string{host.ArgDest: w.s.Task.BackupPath}})
		errs = append(errs, err)
	}
	for _, path := range []string{w.target.BinaryPath() + ".tmp", w.target.BinaryPath() + ".bak.tmp"} {
		_, err := w.e.runner.Run(context.Background(), host.Op{Kind: host.OpRemoveBinary, Args: map[string]string{host.ArgDest: path}})
		errs = append(errs, err)
	}
	errs = append(errs, os.RemoveAll(StagingRunDir(w.e.stagingDir, w.s.Task.Status.Target)), os.RemoveAll(filepath.Join(w.cfg.StateDir, "snapshot")))
	if err := errors.Join(errs...); err != nil {
		return err
	}
	w.s.Task.RecoveryConfig = nil
	w.s.Task.BackupPath = ""
	w.s.Task.Snapshots = nil
	w.s.Task.SnapshotComplete = false
	return saveWorkerState(w.cfg.StateDir, w.s)
}

// RecoverWorker restores an interrupted publication before the startup wrapper
// execs the panel. An active worker owns recovery; startup must leave it alone.
// Old-version readiness is completed by the independent worker after startup.
func RecoverWorker(ctx context.Context, cfg WorkerConfig) error {
	lock, err := workerLock(cfg.StateDir)
	if errors.Is(err, ErrBusy) {
		return nil
	}
	if err != nil {
		return err
	}
	defer lock.Close()
	s, err := loadWorkerState(cfg.StateDir)
	if err != nil {
		return err
	}
	if !s.active() {
		if s.Task == nil || len(s.Task.RecoveryConfig) == 0 {
			return nil
		}
		w, err := newIndependentWorker(cfg, s)
		if err != nil {
			return err
		}
		defer w.e.Close()
		return w.cleanup()
	}
	if len(s.Task.RecoveryConfig) == 0 {
		return s.transition(cfg.StateDir, PhaseFailed, "queued update interrupted before worker started")
	}
	w, err := newIndependentWorker(cfg, s)
	if err != nil {
		return err
	}
	defer w.e.Close()
	if !s.Task.StopIntent && !s.Task.PublishIntent {
		if err := w.phase(PhaseFailed, "update interrupted before publication"); err != nil {
			return err
		}
		return w.cleanup()
	}
	if !s.Task.RecoveryReady {
		_ = w.phase(PhaseRollingBack, "recovering interrupted update")
		if err := w.restore(ctx, true); err != nil {
			return err
		}
		s.Task.RecoveryReady = true
		// Restoration succeeded. Let the old runtime start even when recording
		// that fact fails; the previous durable intent retains all backup data.
		_ = saveWorkerState(cfg.StateDir, s)
	}
	client, err := NewWorkerClient(cfg.StateDir, cfg.Launch)
	if err == nil {
		_ = client.launch(ctx, client.RegistrationCommand())
	}
	return nil
}
