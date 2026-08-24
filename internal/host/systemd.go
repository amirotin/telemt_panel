package host

import (
	"context"
	"fmt"
	"strings"
)

// Systemd manages services through systemctl.
type Systemd struct {
	run CmdRunner
}

// NewSystemd builds a Systemd ServiceManager that runs systemctl through
// runner.
func NewSystemd(runner CmdRunner) *Systemd {
	return &Systemd{run: runner}
}

// Kind implements ServiceManager.
func (s *Systemd) Kind() string { return KindSystemd }

// Status implements ServiceManager via `systemctl is-active`. systemctl
// exits nonzero for every state but "active", so the state is read from
// stdout, not the exit code.
func (s *Systemd) Status(ctx context.Context, service string) (ServiceStatus, error) {
	out, _, runErr := s.run(ctx, "systemctl", "is-active", service)
	switch strings.TrimSpace(string(out)) {
	case "active":
		return StatusRunning, nil
	case "inactive", "failed":
		return StatusStopped, nil
	case "":
		if runErr != nil {
			return StatusUnknown, runErr
		}
		return StatusUnknown, nil
	default:
		// activating, deactivating, reloading, unknown, ...
		return StatusUnknown, nil
	}
}

// Restart implements ServiceManager via `systemctl restart`.
func (s *Systemd) Restart(ctx context.Context, service string) error {
	_, stderr, err := s.run(ctx, "systemctl", "restart", service)
	if err != nil {
		return fmt.Errorf("systemctl restart %s: %s: %w", service, strings.TrimSpace(string(stderr)), err)
	}
	return nil
}

// Caps implements ServiceManager.
func (s *Systemd) Caps() ServiceCaps {
	return ServiceCaps{CanRestart: true, CanStatus: true}
}
