// Package update implements the host update engine: listing GitHub
// releases (releases.go), semver comparison (semver.go), libc/arch variant
// detection (variant.go), asset matching (assets.go), and — in this file
// plus targets.go/download.go/auto.go/startup.go — the state machine that
// downloads, verifies, installs and health-gates Telemt and panel-self
// updates. See v2/specs/03-update-engine.md.
package update

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/store"
)

// Target names, also used as store.UpdateJournalEntry.Target values and as
// the {target} path parameter of POST /api/updates/{target}/apply.
const (
	TargetTelemt = "telemt"
	TargetPanel  = "panel"
)

// Update run phases, in the order the state machine moves through them.
// Mirrors openapi.yaml UpdateRun.phase exactly.
const (
	PhaseChecking    = "checking"
	PhaseDownloading = "downloading"
	PhaseVerifying   = "verifying"
	PhaseStaging     = "staging"
	PhaseInstalling  = "installing"
	PhaseRestarting  = "restarting"
	PhaseHealth      = "health"
	PhaseDone        = "done"
	PhaseRollingBack = "rolling_back"
	PhaseRolledBack  = "rolled_back"
	PhaseFailed      = "failed"
)

// ErrBusy is returned by Apply/StartApply when another run already holds
// the engine's global lock — one update run per process across both
// targets at once (spec 03-update-engine.md).
var ErrBusy = errors.New("update: another run is in progress")

// ErrUnknownTarget is returned for a target name that isn't "telemt" or
// "panel".
var ErrUnknownTarget = errors.New("update: unknown target")

// Target abstracts the differences between updating Telemt and
// self-updating the panel; everything else (the state machine, journal,
// rollback) is shared.
type Target interface {
	// Name is "telemt" or "panel" — one of the Target* constants.
	Name() string
	// CurrentVersion returns the version currently installed/running.
	CurrentVersion(ctx context.Context) (string, error)
	// Repo is the "owner/repo" GitHub repository releases are listed from.
	Repo() string
	// BinaryPath is the absolute path the binary is installed to.
	BinaryPath() string
	// ServiceName is the service/container name passed to the Runner's
	// restart-service op.
	ServiceName() string
	// PostRestart is called after the service restart succeeds. telemt:
	// polls SDK Health until it responds or a timeout elapses. panel: nil —
	// the NEW process confirms success at its own startup instead (see
	// ConfirmStartup and runPhases' panel special case below), since this
	// process may be replaced by the restart before PostRestart could ever
	// run.
	PostRestart(ctx context.Context) error
}

// RunStatus is one update run's current state, as reported by
// Engine.ActiveRun and published (as runEventWire) to the hub's "update"
// topic on every phase transition.
type RunStatus struct {
	RunID       string
	Target      string
	Phase       string
	VersionFrom string
	VersionTo   string
	StartedAt   time.Time
	// FinishedAt is the zero time until the run reaches a terminal phase
	// (done, rolled_back, failed).
	FinishedAt time.Time
	Detail     string
}

// UpdatePublisher is the hub method the engine and auto-updater push
// status snapshots through — satisfied by *hub.Hub. A narrow interface
// here (instead of importing internal/hub) keeps this package's tests
// independent of the hub's implementation.
type UpdatePublisher interface {
	PublishUpdate(data json.RawMessage)
}

// EngineConfig configures NewEngine. Runner, Store and Targets are
// required; everything else has a production default and exists mainly so
// tests can inject fakes/fixed values.
type EngineConfig struct {
	// Runner executes every privileged op (install/restore binary, restart
	// service) — never exec'd directly, per the milestone's Runner-only
	// invariant. A degraded Runner (host.ErrPrivilegesUnavailable on every
	// call) is accepted here without error; Apply then simply fails at the
	// installing phase with a clear rollback/failed journal entry, rather
	// than the engine refusing to exist.
	Runner host.Runner
	// Store persists the phase journal and reads auto-update settings.
	Store store.Store
	// Targets maps target name ("telemt"/"panel") to its Target
	// implementation.
	Targets map[string]Target
	// StagingDir is the writable directory downloads/extraction happen in;
	// a target subdirectory is cleaned and recreated at the start of every
	// run.
	StagingDir string

	// Github lists releases; defaults to NewClient() (real GitHub API).
	Github *Client
	// GithubToken is sent as a bearer token to raise GitHub's rate limit;
	// optional.
	GithubToken string
	// Hub publishes run status into the SSE "update" topic; nil disables
	// publishing (tests that don't care about it).
	Hub UpdatePublisher

	// HTTPClient downloads release assets; defaults to a client with a 5
	// minute timeout (release tarballs are small, but a stalled connection
	// on a slow router link should not hang forever).
	HTTPClient *http.Client
	// Arch/Variant select which release asset matches this host; default
	// to DetectArch()/DetectLibc(DefaultProbe()).
	Arch, Variant string
	// MaxNewer/MaxOlder bound how many releases ReleasesView returns in
	// each direction; default 10/3.
	MaxNewer, MaxOlder int

	// Now returns the current time; defaults to time.Now. Injected by
	// tests for deterministic journal timestamps.
	Now func() time.Time
	// NewRunID generates a run's id; defaults to an 8 hex-digit
	// crypto/rand value. Injected by tests for deterministic run ids.
	NewRunID func() string
}

// Engine runs the update state machine for both targets, sharing one
// global lock so a Telemt update and a panel self-update can never race
// each other (spec 03-update-engine.md).
type Engine struct {
	runner      host.Runner
	st          store.Store
	targets     map[string]Target
	stagingDir  string
	github      *Client
	githubToken string
	hub         UpdatePublisher
	httpClient  *http.Client
	arch        string
	variant     string
	maxNewer    int
	maxOlder    int
	now         func() time.Time
	newRunID    func() string

	mu           sync.Mutex
	running      bool
	activeTarget string
	runs         map[string]RunStatus
}

// NewEngine builds an Engine from cfg, applying production defaults to
// every optional field left zero.
func NewEngine(cfg EngineConfig) *Engine {
	e := &Engine{
		runner:      cfg.Runner,
		st:          cfg.Store,
		targets:     cfg.Targets,
		stagingDir:  cfg.StagingDir,
		github:      cfg.Github,
		githubToken: cfg.GithubToken,
		hub:         cfg.Hub,
		httpClient:  cfg.HTTPClient,
		arch:        cfg.Arch,
		variant:     cfg.Variant,
		maxNewer:    cfg.MaxNewer,
		maxOlder:    cfg.MaxOlder,
		now:         cfg.Now,
		newRunID:    cfg.NewRunID,
		runs:        make(map[string]RunStatus),
	}
	if e.github == nil {
		e.github = NewClient()
	}
	if e.httpClient == nil {
		e.httpClient = &http.Client{Timeout: 5 * time.Minute}
	}
	if e.arch == "" {
		e.arch = DetectArch()
	}
	if e.variant == "" {
		e.variant = DetectLibc(DefaultProbe())
	}
	if e.maxNewer == 0 {
		e.maxNewer = 10
	}
	if e.maxOlder == 0 {
		e.maxOlder = 3
	}
	if e.now == nil {
		e.now = time.Now
	}
	if e.newRunID == nil {
		e.newRunID = randomRunID
	}
	return e
}

// randomRunID returns an 8 hex-digit run id from crypto/rand (spec:
// "run_id (crypto/rand hex8)").
func randomRunID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is effectively unrecoverable system state;
		// a timestamp-derived id keeps the engine limping rather than
		// panicking mid-update.
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(b)
}

// LockHeld reports whether a run (for either target) currently holds the
// engine's global lock.
func (e *Engine) LockHeld() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

// ActiveRun returns targetName's current run status and true while it is
// the one holding the global lock; false (with a zero RunStatus) once the
// run has finished or if none is in progress.
func (e *Engine) ActiveRun(targetName string) (RunStatus, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.running || e.activeTarget != targetName {
		return RunStatus{}, false
	}
	st, ok := e.runs[targetName]
	return st, ok
}

// tryLock acquires the global lock for targetName, reporting false without
// blocking if another run already holds it.
func (e *Engine) tryLock(targetName string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running {
		return false
	}
	e.running = true
	e.activeTarget = targetName
	return true
}

func (e *Engine) unlock() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.running = false
	e.activeTarget = ""
}

func (e *Engine) setStatus(targetName string, st RunStatus) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.runs[targetName] = st
}

// Apply runs one update for targetName to version, synchronously, from
// checking through done/rolled_back/failed — acquiring and releasing the
// global lock itself. Returns ErrBusy immediately (without running
// anything) if another run already holds the lock, or ErrUnknownTarget for
// an unrecognized target name. httpapi's POST handler calls StartApply
// instead, so the HTTP request returns 202 without blocking on the whole
// run; Apply is the form tests drive directly.
func (e *Engine) Apply(ctx context.Context, targetName, version string) error {
	t, ok := e.targets[targetName]
	if !ok {
		return ErrUnknownTarget
	}
	if !e.tryLock(targetName) {
		return ErrBusy
	}
	defer e.unlock()
	return e.runPhases(ctx, targetName, t, version)
}

// StartApply acquires the global lock synchronously — so a concurrent
// second call reliably observes ErrBusy — then runs the update in a new
// goroutine bound to context.Background() (the triggering HTTP request's
// context must not cancel a run that continues after the response is
// sent). Returns nil once the goroutine has been started, not once it has
// finished.
func (e *Engine) StartApply(targetName, version string) error {
	t, ok := e.targets[targetName]
	if !ok {
		return ErrUnknownTarget
	}
	if !e.tryLock(targetName) {
		return ErrBusy
	}
	go func() {
		defer e.unlock()
		if err := e.runPhases(context.Background(), targetName, t, version); err != nil {
			slog.Warn("update: run ended", "target", targetName, "err", err)
		}
	}()
	return nil
}

// isTerminalPhase reports whether phase ends a run (no further
// transitions follow it in the same run).
func isTerminalPhase(phase string) bool {
	switch phase {
	case PhaseDone, PhaseRolledBack, PhaseFailed:
		return true
	default:
		return false
	}
}

// runCtx carries one run's identity across every phase transition.
type runCtx struct {
	RunID       string
	Target      string
	VersionFrom string
	VersionTo   string
	StartedAt   time.Time
}

// transition journals one phase change to the store and publishes the
// resulting RunStatus to the hub. Journal-append failures are logged, not
// returned — the run must keep proceeding even if the store hiccups on one
// write; ListUpdateJournal simply shows a gap.
func (e *Engine) transition(rc *runCtx, phase, detail string) {
	ts := e.now()
	entry := store.UpdateJournalEntry{
		Target:      rc.Target,
		RunID:       rc.RunID,
		Phase:       phase,
		VersionFrom: rc.VersionFrom,
		VersionTo:   rc.VersionTo,
		TS:          ts,
		Detail:      detail,
	}
	if err := e.st.AppendUpdateJournal(entry); err != nil {
		slog.Error("update: append journal", "target", rc.Target, "run_id", rc.RunID, "phase", phase, "err", err)
	}

	status := RunStatus{
		RunID:       rc.RunID,
		Target:      rc.Target,
		Phase:       phase,
		VersionFrom: rc.VersionFrom,
		VersionTo:   rc.VersionTo,
		StartedAt:   rc.StartedAt,
		Detail:      detail,
	}
	if isTerminalPhase(phase) {
		status.FinishedAt = ts
	}
	e.setStatus(rc.Target, status)
	e.publish(status)
}

// runEventWire is RunStatus's JSON shape on the hub's "update" topic —
// mirrors openapi UpdateRun, with FinishedAt as an omittable pointer since
// time.Time's zero value is not what encoding/json's omitempty treats as
// "empty".
type runEventWire struct {
	RunID       string     `json:"run_id"`
	Target      string     `json:"target"`
	Phase       string     `json:"phase"`
	VersionFrom string     `json:"version_from,omitempty"`
	VersionTo   string     `json:"version_to"`
	StartedAt   time.Time  `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
	Detail      string     `json:"detail,omitempty"`
}

func (e *Engine) publish(s RunStatus) {
	if e.hub == nil {
		return
	}
	w := runEventWire{
		RunID: s.RunID, Target: s.Target, Phase: s.Phase,
		VersionFrom: s.VersionFrom, VersionTo: s.VersionTo,
		StartedAt: s.StartedAt, Detail: s.Detail,
	}
	if !s.FinishedAt.IsZero() {
		w.FinishedAt = &s.FinishedAt
	}
	data, err := json.Marshal(w)
	if err != nil {
		slog.Error("update: marshal run event", "err", err)
		return
	}
	e.hub.PublishUpdate(data)
}

// fail journals phase's failure as PhaseFailed and returns the run's final
// error. Used for every failure before installing — nothing has touched
// the installed binary yet, so there is nothing to roll back.
func (e *Engine) fail(rc *runCtx, phase, detail string) error {
	e.transition(rc, PhaseFailed, fmt.Sprintf("%s: %s", phase, detail))
	return fmt.Errorf("update %s: %s: %s", rc.Target, phase, detail)
}

// rollback journals rolling_back, restores backupPath via the Runner and
// restarts the service, then journals rolled_back — or, if there is no
// backup to restore (binaryPath didn't exist before this run, e.g. a
// first-ever install), journals failed instead since there is nothing to
// roll back to.
func (e *Engine) rollback(ctx context.Context, rc *runCtx, target Target, backupPath, failedPhase string, cause error) error {
	e.transition(rc, PhaseRollingBack, fmt.Sprintf("%s failed: %v", failedPhase, cause))

	if backupPath == "" {
		e.transition(rc, PhaseFailed, fmt.Sprintf("no backup available to roll back after %s failure: %v", failedPhase, cause))
		return fmt.Errorf("update %s: %s failed, no backup to roll back to: %w", rc.Target, failedPhase, cause)
	}

	if _, err := e.runner.Run(ctx, host.Op{Kind: host.OpRestoreBinary, Args: map[string]string{
		host.ArgBackup: backupPath, host.ArgDest: target.BinaryPath(),
	}}); err != nil {
		e.transition(rc, PhaseFailed, fmt.Sprintf("rollback restore failed: %v", err))
		return fmt.Errorf("update %s: rollback restore: %w", rc.Target, err)
	}
	if _, err := e.runner.Run(ctx, host.Op{Kind: host.OpRestartService, Args: map[string]string{
		host.ArgService: target.ServiceName(),
	}}); err != nil {
		e.transition(rc, PhaseFailed, fmt.Sprintf("rollback restart failed: %v", err))
		return fmt.Errorf("update %s: rollback restart: %w", rc.Target, err)
	}

	e.transition(rc, PhaseRolledBack, fmt.Sprintf("%s failed: %v", failedPhase, cause))
	return fmt.Errorf("update %s: %s failed, rolled back: %w", rc.Target, failedPhase, cause)
}

// assetBaseName maps a target name to the release asset name prefix (see
// AssetName): Telemt's own releases publish "telemt-*", the panel's
// publish "telemt-panel-*".
func assetBaseName(targetName string) string {
	if targetName == TargetPanel {
		return "telemt-panel"
	}
	return "telemt"
}

// runPhases drives one run through the full state machine. See engine.go's
// package doc and v2/specs/03-update-engine.md for the phase diagram.
func (e *Engine) runPhases(ctx context.Context, targetName string, target Target, version string) error {
	rc := &runCtx{RunID: e.newRunID(), Target: targetName, VersionTo: version, StartedAt: e.now()}
	if cv, err := target.CurrentVersion(ctx); err == nil {
		rc.VersionFrom = cv
	}

	e.transition(rc, PhaseChecking, "")

	releases, err := e.github.ListReleases(ctx, target.Repo(), e.githubToken)
	if err != nil {
		return e.fail(rc, PhaseChecking, "list releases: "+err.Error())
	}
	rel, ok := findRelease(releases, version)
	if !ok {
		return e.fail(rc, PhaseChecking, "release not found: "+version)
	}
	matcher := NewAssetMatcher(assetBaseName(targetName), e.arch, e.variant)
	bin, sum := matcher(rel.Assets)
	if bin == nil {
		return e.fail(rc, PhaseChecking, "no release asset matches this host's arch/libc")
	}

	runDir := filepath.Join(e.stagingDir, targetName)
	if err := os.RemoveAll(runDir); err != nil {
		return e.fail(rc, PhaseChecking, "clean staging dir: "+err.Error())
	}
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return e.fail(rc, PhaseChecking, "create staging dir: "+err.Error())
	}
	// Staging cleanup on both exits (spec): whatever path runPhases returns
	// through below, the per-run staging directory never outlives the run.
	// The one thing deliberately outside runDir is the backup file — it is
	// written to a fixed sibling of the binary path so it survives across
	// runs and can be restored from a later run's rollback too.
	defer os.RemoveAll(runDir)

	e.transition(rc, PhaseDownloading, "")
	tarPath := filepath.Join(runDir, "release.tar.gz")
	if err := e.download(ctx, bin.BrowserDownloadURL, tarPath); err != nil {
		return e.fail(rc, PhaseDownloading, err.Error())
	}
	var expectedSum string
	if sum != nil {
		sumPath := filepath.Join(runDir, "release.sha256")
		if err := e.download(ctx, sum.BrowserDownloadURL, sumPath); err != nil {
			return e.fail(rc, PhaseDownloading, "download checksum: "+err.Error())
		}
		data, err := os.ReadFile(sumPath)
		if err != nil {
			return e.fail(rc, PhaseDownloading, "read checksum: "+err.Error())
		}
		expectedSum = parseChecksumFile(string(data))
	}

	e.transition(rc, PhaseVerifying, "")
	if expectedSum != "" {
		actual, err := sha256File(tarPath)
		if err != nil {
			return e.fail(rc, PhaseVerifying, err.Error())
		}
		if !strings.EqualFold(actual, expectedSum) {
			return e.fail(rc, PhaseVerifying, "checksum mismatch")
		}
	}
	// No published checksum asset: proceed without verification rather
	// than failing every update for a release that simply didn't publish
	// one (AssetMatcher already treats the checksum as optional).

	e.transition(rc, PhaseStaging, "")
	binPath, err := extractSingleBinary(tarPath, runDir)
	if err != nil {
		return e.fail(rc, PhaseStaging, err.Error())
	}

	// Back up the currently installed binary before overwriting it. Reading
	// it is a plain, unprivileged filesystem read (release binaries are
	// installed world-readable) — only the WRITE to the fixed backup
	// destination needs the Runner, since that destination lives under the
	// same protected directory as the binary itself. A target with nothing
	// installed yet (first-ever install) has no backup and therefore no
	// rollback path; that is surfaced by rollback's backupPath=="" case.
	var backupPath string
	if current, readErr := os.ReadFile(target.BinaryPath()); readErr == nil {
		tmpBackup := filepath.Join(runDir, "backup")
		if err := os.WriteFile(tmpBackup, current, 0o755); err != nil {
			return e.fail(rc, PhaseStaging, "stage backup: "+err.Error())
		}
		candidate := target.BinaryPath() + ".bak"
		if _, err := e.runner.Run(ctx, host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
			host.ArgStaging: tmpBackup, host.ArgDest: candidate,
		}}); err != nil {
			return e.fail(rc, PhaseStaging, "save backup: "+err.Error())
		}
		backupPath = candidate
	} else if !os.IsNotExist(readErr) {
		return e.fail(rc, PhaseStaging, "read current binary: "+readErr.Error())
	}

	e.transition(rc, PhaseInstalling, "")
	if _, err := e.runner.Run(ctx, host.Op{Kind: host.OpInstallBinary, Args: map[string]string{
		host.ArgStaging: binPath, host.ArgDest: target.BinaryPath(),
	}}); err != nil {
		return e.rollback(ctx, rc, target, backupPath, PhaseInstalling, err)
	}

	e.transition(rc, PhaseRestarting, "")
	if _, err := e.runner.Run(ctx, host.Op{Kind: host.OpRestartService, Args: map[string]string{
		host.ArgService: target.ServiceName(),
	}}); err != nil {
		return e.rollback(ctx, rc, target, backupPath, PhaseRestarting, err)
	}

	if targetName == TargetPanel {
		// Panel self-update: this process may be replaced by the restart
		// above at any moment. The journal rule (spec 03 §Журнал) forbids
		// claiming success before a live process of the new version has
		// confirmed it — the last journal entry stays "restarting" here;
		// ConfirmStartup completes it (done/rolled_back) from the new
		// process's own startup path.
		return nil
	}

	e.transition(rc, PhaseHealth, "")
	if err := target.PostRestart(ctx); err != nil {
		return e.rollback(ctx, rc, target, backupPath, PhaseHealth, err)
	}

	e.transition(rc, PhaseDone, "")
	return nil
}
