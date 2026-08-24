// Package host abstracts everything the panel does to the machine it runs
// on: controlling the telemt and telemt-panel services, and (a later task)
// reading their logs. Every operation sits behind an interface with a
// production implementation per init system (systemd, OpenRC, procd,
// sysvinit, Docker) plus a "none" fallback, and a capability query so the
// UI never assumes an operation exists — it asks Caps() and shows a
// disabled control with a copyable manual command instead of a dead
// button.
package host

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Init system / container-runtime kinds a ServiceManager can report from
// Kind(). These match the host.service_manager config enum one-to-one.
const (
	KindSystemd  = "systemd"
	KindOpenRC   = "openrc"
	KindProcd    = "procd"
	KindSysvinit = "sysvinit"
	KindDocker   = "docker"
	KindNone     = "none"
)

// Log source kinds a LogSource can report from Kind(). Journald/Logread/
// Syslog/Docker/File match the host.log_source config enum one-to-one; None
// is never a config value (log_source has no "none" setting) — it's what
// detection falls back to, and what a LogSource's Kind() reports, when no
// usable source exists on this host.
const (
	LogKindJournald = "journald"
	LogKindLogread  = "logread"
	LogKindSyslog   = "syslog"
	LogKindDocker   = "docker"
	LogKindFile     = "file"
	LogKindNone     = "none"
)

// ServiceStatus is the normalized run state of a managed service.
type ServiceStatus string

// Possible ServiceStatus values. A manager returns Unknown rather than an
// error whenever the underlying tool ran successfully but reported a state
// this package doesn't classify as running or stopped (e.g. systemd's
// "activating"), or whenever Caps().CanStatus is false.
const (
	StatusRunning ServiceStatus = "running"
	StatusStopped ServiceStatus = "stopped"
	StatusUnknown ServiceStatus = "unknown"
)

// ErrManualRestartRequired is returned by Restart when the implementation
// cannot restart the service itself (Caps().CanRestart == false). Callers
// should show ManualRestartHint instead of retrying.
var ErrManualRestartRequired = errors.New("host: manual restart required")

// ErrLogUnavailable is returned by NoneLog's Tail/Stream. It's a defensive
// fallback, not the primary signal — callers are expected to check
// Caps().CanTail/CanStream (both false on NoneLog) before calling either
// method at all, the same way ErrManualRestartRequired backs ServiceCaps.
var ErrLogUnavailable = errors.New("host: log source unavailable")

// ExitError reports a command's nonzero exit code. Managers that key
// status off exit codes (procd) check for this instead of os/exec's
// *exec.ExitError so fake CmdRunners can construct it without spawning a
// real process. The production CmdRunner (see exec.go) converts a real
// *exec.ExitError into this type.
type ExitError struct {
	Code int
}

// Error implements the error interface.
func (e *ExitError) Error() string {
	return fmt.Sprintf("exit status %d", e.Code)
}

// ServiceCaps reports what a ServiceManager implementation can actually do
// on this host.
type ServiceCaps struct {
	CanRestart bool
	CanStatus  bool
	// ManualRestartHint is a copyable shell command shown next to a
	// disabled restart control when CanRestart is false. Empty when
	// CanRestart is true.
	ManualRestartHint string
}

// ServiceManager controls the lifecycle of a system service (telemt,
// telemt-panel). One implementation per init system lives alongside this
// package: systemd.go, openrc.go, procd.go, sysvinit.go, docker.go,
// none.go. Detect and construct the right one via NewServiceManager.
type ServiceManager interface {
	// Kind identifies the implementation; one of the Kind* constants
	// above.
	Kind() string
	// Status reports the service's current run state. May return
	// StatusUnknown with a nil error when the host's tooling can't
	// determine the state.
	Status(ctx context.Context, service string) (ServiceStatus, error)
	// Restart restarts the service. Returns ErrManualRestartRequired
	// when Caps().CanRestart is false.
	Restart(ctx context.Context, service string) error
	// Caps reports what this implementation can actually do on this
	// host.
	Caps() ServiceCaps
}

// LogCaps reports what a LogSource implementation can actually do on this
// host.
type LogCaps struct {
	CanTail   bool
	CanStream bool
}

// LogLine is one normalized log entry. Level is normalized to
// debug|info|warn|error|unknown so the frontend never parses raw log text
// (lesson from v1: an ANSI parser living in a page component).
type LogLine struct {
	TS    time.Time
	Level string
	Unit  string
	Msg   string
}

// LogSource reads a service's log: a bounded tail and a live stream.
// Implementations: journald.go, logread.go, syslog.go, file.go, docker.go
// (DockerLog), plus the NoneLog fallback in none.go.
type LogSource interface {
	// Kind identifies the implementation; one of the LogKind* constants
	// above.
	Kind() string
	// Tail returns up to the last `lines` log entries.
	Tail(ctx context.Context, service string, lines int) ([]LogLine, error)
	// Stream pushes lines as they arrive; the channel closes when ctx is
	// done or the underlying source ends.
	Stream(ctx context.Context, service string) (<-chan LogLine, error)
	// Caps reports what this implementation can actually do on this
	// host.
	Caps() LogCaps
}
