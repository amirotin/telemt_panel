package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"golang.org/x/sys/unix"
)

// WorkerProtocol is the installer/worker registration protocol version.
const WorkerProtocol = 1

type workerRegistration struct {
	Version int      `json:"version"`
	Command []string `json:"command"`
}

type workerTask struct {
	Status           RunStatus        `json:"status"`
	RecoveryConfig   json.RawMessage  `json:"recovery_config,omitempty"`
	BackupPath       string           `json:"backup_path,omitempty"`
	StopIntent       bool             `json:"stop_intent,omitempty"`
	PublishIntent    bool             `json:"publish_intent,omitempty"`
	SnapshotComplete bool             `json:"snapshot_complete,omitempty"`
	Snapshots        []workerSnapshot `json:"snapshots,omitempty"`
	RecoveryReady    bool             `json:"recovery_ready,omitempty"`
}

type workerState struct {
	Version int                        `json:"version"`
	Task    *workerTask                `json:"task,omitempty"`
	Journal []store.UpdateJournalEntry `json:"journal"`
}

// WorkerClient submits durable tasks to an init-managed independent process.
// It never owns or cancels that process and never opens the panel's state store.
type WorkerClient struct {
	stateDir     string
	registration workerRegistration
	launch       func(context.Context, []string) error
}

// NewWorkerClient loads installer registration; missing registration returns os.ErrNotExist.
func NewWorkerClient(stateDir string, launch func(context.Context, []string) error) (*WorkerClient, error) {
	var registration workerRegistration
	if err := readWorkerJSON(filepath.Join(stateDir, "registration.json"), &registration); err != nil {
		return nil, err
	}
	if registration.Version != WorkerProtocol || len(registration.Command) == 0 || !filepath.IsAbs(registration.Command[0]) {
		return nil, errors.New("update: invalid worker registration")
	}
	if launch == nil {
		launch = func(ctx context.Context, argv []string) error {
			return exec.CommandContext(ctx, argv[0], argv[1:]...).Run()
		}
	}
	return &WorkerClient{stateDir: stateDir, registration: registration, launch: launch}, nil
}

// RegistrationCommand returns the fixed init command for permission preflight.
func (c *WorkerClient) RegistrationCommand() []string {
	return append([]string(nil), c.registration.Command...)
}

// ResumeRecovery retries init handoff after an offline restore whose launch failed.
func (c *WorkerClient) ResumeRecovery(ctx context.Context) error {
	lock, err := workerLock(c.stateDir)
	if errors.Is(err, ErrBusy) {
		return nil
	}
	if err != nil {
		return err
	}
	defer lock.Close()
	s, err := loadWorkerState(c.stateDir)
	if err != nil {
		return err
	}
	if !s.active() || len(s.Task.RecoveryConfig) == 0 {
		return nil
	}
	return c.launch(ctx, c.RegistrationCommand())
}

func readWorkerJSON(path string, value any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(value)
}

func loadWorkerState(dir string) (*workerState, error) {
	s := &workerState{Version: WorkerProtocol}
	if err := readWorkerJSON(filepath.Join(dir, "state.json"), s); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, nil
		}
		return nil, err
	}
	if s.Version != WorkerProtocol {
		return nil, errors.New("update: unsupported worker state protocol")
	}
	return s, nil
}

// WorkerStateIdle checks for queued, executing or uncertain work. Installers
// must hold operation.lock across this read and their complete transaction.
func WorkerStateIdle(dir string) error {
	s, err := loadWorkerState(dir)
	if err != nil {
		return err
	}
	if s.active() {
		return ErrBusy
	}
	return nil
}

func syncWorkerDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func saveWorkerState(dir string, s *workerState) error {
	f, err := os.CreateTemp(dir, ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = json.NewEncoder(f).Encode(s); err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), filepath.Join(dir, "state.json")); err != nil {
		return err
	}
	return syncWorkerDir(dir)
}

func workerLock(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "operation.lock"), os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, ErrBusy
		}
		return nil, err
	}
	return f, nil
}

func waitWorkerLock(ctx context.Context, dir string) (*os.File, error) {
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	for {
		f, err := workerLock(dir)
		if !errors.Is(err, ErrBusy) {
			return f, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, ErrBusy
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func (s *workerState) active() bool {
	return s.Task != nil && (!isTerminalPhase(s.Task.Status.Phase) || s.Task.StopIntent || s.Task.PublishIntent)
}

func (s *workerState) transition(dir, phase, detail string) error {
	status := &s.Task.Status
	status.Phase = phase
	status.Detail = detail
	ts := time.Now().UTC()
	if isTerminalPhase(phase) {
		status.FinishedAt = ts
	} else {
		status.FinishedAt = time.Time{}
	}
	s.Journal = append(s.Journal, store.UpdateJournalEntry{Target: status.Target, RunID: status.RunID, Phase: phase, VersionFrom: status.VersionFrom, VersionTo: status.VersionTo, TS: ts, Detail: detail})
	if len(s.Journal) > 400 {
		s.Journal = s.Journal[len(s.Journal)-400:]
	}
	return saveWorkerState(dir, s)
}

// Submit persists the queue before notifying init, closing the queue/start race.
func (c *WorkerClient) Submit(ctx context.Context, target, version, current string) error {
	if target != TargetPanel && target != TargetTelemt {
		return ErrUnknownTarget
	}
	if !versionAllowed(target, version) {
		return ErrUnsupportedVersion
	}
	lock, err := workerLock(c.stateDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	s, err := loadWorkerState(c.stateDir)
	if err != nil {
		return err
	}
	if s.active() {
		return ErrBusy
	}
	s.Task = &workerTask{Status: RunStatus{RunID: randomRunID(), Target: target, VersionFrom: current, VersionTo: version, StartedAt: time.Now().UTC()}}
	if err = s.transition(c.stateDir, PhaseChecking, "queued for independent worker"); err != nil {
		return err
	}
	if err = c.launch(ctx, c.RegistrationCommand()); err != nil {
		return errors.Join(fmt.Errorf("start update worker: %w", err), s.transition(c.stateDir, PhaseFailed, "start worker: "+err.Error()))
	}
	return nil
}

// WithHostControl serializes service actions with queued and executing updates.
func (c *WorkerClient) WithHostControl(run func() error) error {
	lock, err := workerLock(c.stateDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	s, err := loadWorkerState(c.stateDir)
	if err != nil {
		return err
	}
	if s.active() {
		return ErrBusy
	}
	return run()
}

// Busy reports queued work or another process holding the operation lock.
func (c *WorkerClient) Busy() bool {
	lock, err := workerLock(c.stateDir)
	if err != nil {
		return true
	}
	defer lock.Close()
	s, err := loadWorkerState(c.stateDir)
	return err != nil || s.active()
}

func (c *WorkerClient) failUnstarted(now time.Time) error {
	lock, err := workerLock(c.stateDir)
	if errors.Is(err, ErrBusy) {
		return nil
	}
	if err != nil {
		return err
	}
	defer lock.Close()
	s, err := loadWorkerState(c.stateDir)
	if err != nil {
		return err
	}
	if !s.active() || s.Task.Status.Phase != PhaseChecking || len(s.Task.RecoveryConfig) != 0 || now.Sub(s.Task.Status.StartedAt) < 30*time.Second {
		return nil
	}
	return s.transition(c.stateDir, PhaseFailed, "independent update worker did not start within 30 seconds; check the updater service")
}

// ActiveRun returns the on-disk status while the requested target is unfinished.
func (c *WorkerClient) ActiveRun(target string) (RunStatus, bool) {
	s, err := loadWorkerState(c.stateDir)
	if err != nil || !s.active() || s.Task.Status.Target != target {
		return RunStatus{}, false
	}
	return s.Task.Status, true
}

// Journal reads newest-first worker entries without accessing panel-state.json.
func (c *WorkerClient) Journal(target string, limit int) ([]store.UpdateJournalEntry, error) {
	s, err := loadWorkerState(c.stateDir)
	if err != nil {
		return nil, err
	}
	result := make([]store.UpdateJournalEntry, 0)
	for i := len(s.Journal) - 1; i >= 0; i-- {
		if target == "" || s.Journal[i].Target == target {
			result = append(result, s.Journal[i])
			if limit > 0 && len(result) >= limit {
				break
			}
		}
	}
	return result, nil
}

// ReadWorkerRecoveryConfig returns saved configuration until recovery and artifact
// cleanup finish, including interrupted cleanup after a confirmed success.
func ReadWorkerRecoveryConfig(dir string) (json.RawMessage, error) {
	s, err := loadWorkerState(dir)
	if err != nil {
		return nil, err
	}
	if s.Task == nil || len(s.Task.RecoveryConfig) == 0 {
		return nil, os.ErrNotExist
	}
	return s.Task.RecoveryConfig, nil
}

// Journal merges historical in-process entries with the independent journal.
func (e *Engine) Journal(ctx context.Context, target string, limit int) ([]store.UpdateJournalEntry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var entries []store.UpdateJournalEntry
	var err error
	if e.st != nil {
		entries, err = e.st.ListUpdateJournal(target, limit)
		if err != nil {
			return nil, err
		}
	}
	if e.worker != nil {
		external, err := e.worker.Journal(target, limit)
		if err != nil {
			return nil, err
		}
		entries = append(entries, external...)
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].TS.After(entries[j].TS) })
	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
	}
	return entries, nil
}

func (e *Engine) pollWorker() {
	defer e.workers.Done()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	var previous RunStatus
	var nextRecovery time.Time
	for {
		_ = e.worker.failUnstarted(time.Now())
		if time.Now().After(nextRecovery) {
			e.mu.Lock()
			ready := e.ready && !e.closed
			e.mu.Unlock()
			if ready {
				ctx, cancel := context.WithTimeout(e.runContext, 15*time.Second)
				_ = e.worker.ResumeRecovery(ctx)
				cancel()
			}
			nextRecovery = time.Now().Add(10 * time.Second)
		}
		s, err := loadWorkerState(e.worker.stateDir)
		if err == nil && s.Task != nil && s.Task.Status != previous {
			previous = s.Task.Status
			e.publish(previous)
		}
		select {
		case <-e.runContext.Done():
			return
		case <-ticker.C:
		}
	}
}
