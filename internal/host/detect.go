package host

import (
	"os"
	"os/exec"
	"time"
)

// Probe holds the filesystem and PATH checks detection relies on,
// injectable so tests can supply fixture values instead of touching the
// real host.
type Probe struct {
	// Stat reports whether path exists.
	Stat func(path string) bool
	// LookPath reports whether name is found on PATH.
	LookPath func(name string) bool
}

// DefaultProbe checks the real filesystem and PATH.
func DefaultProbe() Probe {
	return Probe{
		Stat: func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		},
		LookPath: func(name string) bool {
			_, err := exec.LookPath(name)
			return err == nil
		},
	}
}

// DetectServiceManagerKind returns the init system kind to use: configured
// verbatim when it's not "auto" (config override wins), otherwise the
// first match from p in spec order (01-host-matrix.md §Матрица): systemd,
// openrc, procd, sysvinit, else none. Docker is never auto-detected — it's
// selected only by explicit config, since a container name has to be
// configured for it to mean anything.
func DetectServiceManagerKind(configured string, p Probe) string {
	if configured != "" && configured != "auto" {
		return configured
	}
	switch {
	case p.Stat("/run/systemd/system"):
		return KindSystemd
	case p.Stat("/run/openrc") || p.LookPath("rc-service"):
		return KindOpenRC
	case p.Stat("/etc/openwrt_release"):
		return KindProcd
	case p.Stat("/etc/init.d"):
		return KindSysvinit
	default:
		return KindNone
	}
}

// NewServiceManager detects (or takes from config override) the init
// system and returns the matching ServiceManager, wired to run commands
// through runner.
func NewServiceManager(configured string, p Probe, runner CmdRunner) ServiceManager {
	switch DetectServiceManagerKind(configured, p) {
	case KindSystemd:
		return NewSystemd(runner)
	case KindOpenRC:
		return NewOpenRC(runner)
	case KindProcd:
		return NewProcd(runner)
	case KindSysvinit:
		return NewSysvinit(runner)
	case KindDocker:
		return NewDocker(runner)
	default:
		return NewNone()
	}
}

// detectSyslogPath returns the first syslog file marker p finds, or "" if
// neither exists.
func detectSyslogPath(p Probe) string {
	switch {
	case p.Stat("/var/log/messages"):
		return "/var/log/messages"
	case p.Stat("/var/log/syslog"):
		return "/var/log/syslog"
	default:
		return ""
	}
}

// DetectLogSourceKind returns the log source kind to use: configured
// verbatim when it's not "auto" (config override wins), otherwise derived
// from the already-detected service manager kind and filesystem markers:
// journald follows systemd, logread follows procd, docker follows the
// docker service manager, else a syslog file if one of its markers
// exists, else none. Docker is checked before the syslog file probe
// (amending 01-host-matrix.md's spec-literal ordering, which checked
// syslog first) because a stock Debian/Ubuntu Docker host has its own
// /var/log/syslog for the OS itself, present independent of any
// container — probing it before docker would silently tail the host's
// syslog instead of the container's actual logs.
func DetectLogSourceKind(configured, serviceManagerKind string, p Probe) string {
	if configured != "" && configured != "auto" {
		return configured
	}
	switch {
	case serviceManagerKind == KindSystemd:
		return LogKindJournald
	case serviceManagerKind == KindProcd:
		return LogKindLogread
	case serviceManagerKind == KindDocker:
		return LogKindDocker
	case detectSyslogPath(p) != "":
		return LogKindSyslog
	default:
		return LogKindNone
	}
}

// NewLogSource detects (or takes from config override) the log source and
// returns the matching LogSource, wired to run/start commands through
// runner/starter and, for file-following sources, to poll at pollInterval.
// A "file" source with no configured path, or a "syslog" source when
// neither marker file exists, degrades to NewNoneLog rather than failing —
// this package's invariant is that missing host-side log access must never
// break the panel or be misreported; it surfaces as Caps()=false, not a
// construction error.
func NewLogSource(configured, logFile, serviceManagerKind string, p Probe, runner CmdRunner, starter ProcessStarter, pollInterval time.Duration) LogSource {
	switch DetectLogSourceKind(configured, serviceManagerKind, p) {
	case LogKindJournald:
		return NewJournald(runner, starter)
	case LogKindLogread:
		return NewLogread(runner, starter)
	case LogKindSyslog:
		path := detectSyslogPath(p)
		if path == "" {
			return NewNoneLog()
		}
		return NewSyslog(path, pollInterval)
	case LogKindDocker:
		return NewDockerLog(runner, starter)
	case LogKindFile:
		if logFile == "" {
			return NewNoneLog()
		}
		return NewFile(logFile, pollInterval)
	default:
		return NewNoneLog()
	}
}
