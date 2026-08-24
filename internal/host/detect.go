package host

import (
	"os"
	"os/exec"
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
