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

// Start starts the configured service without enabling it at boot.
func (s *Systemd) Start(ctx context.Context, service string) error {
	return serviceCommand(ctx, s.run, "systemctl", "start", service)
}

// Stop stops the configured service without disabling it at boot.
func (s *Systemd) Stop(ctx context.Context, service string) error {
	return serviceCommand(ctx, s.run, "systemctl", "stop", service)
}

// Status implements ServiceManager via `systemctl is-active`. systemctl
// exits nonzero for every state but "active", so the state is read from
// stdout, not the exit code.
func (s *Systemd) Status(ctx context.Context, service string) (ServiceStatus, error) {
	state, err := s.DetailedState(ctx, service)
	switch state {
	case "active":
		return StatusRunning, err
	case "inactive", "failed":
		return StatusStopped, err
	default:
		return StatusUnknown, err
	}
}

// DetailedState returns the systemd state from a single is-active command.
// Recognized non-active states have a nonzero exit code but remain valid observations.
func (s *Systemd) DetailedState(ctx context.Context, service string) (string, error) {
	out, _, runErr := s.run(ctx, "systemctl", "is-active", service)
	switch state := strings.TrimSpace(string(out)); state {
	case "active", "inactive", "failed", "activating", "deactivating", "reloading", "unknown":
		return state, nil
	case "":
		return "unknown", runErr
	default:
		return "unknown", nil
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
