package host

import (
	"context"
	"fmt"
	"strings"
)

// Sysvinit manages services through /etc/init.d scripts on plain SysV
// init hosts (no systemd, OpenRC or procd marker present).
type Sysvinit struct {
	run CmdRunner
}

// NewSysvinit builds a Sysvinit ServiceManager that runs
// /etc/init.d/<service> through runner.
func NewSysvinit(runner CmdRunner) *Sysvinit {
	return &Sysvinit{run: runner}
}

// Kind implements ServiceManager.
func (s *Sysvinit) Kind() string { return KindSysvinit }

// Status implements ServiceManager. Plain SysV init scripts don't
// reliably support a `status` action (some no-op, some vary the exit
// code's meaning by script author), so this always reports StatusUnknown
// without running anything; Caps().CanStatus is false accordingly.
func (s *Sysvinit) Status(ctx context.Context, service string) (ServiceStatus, error) {
	return StatusUnknown, nil
}

// Restart implements ServiceManager via `/etc/init.d/<svc> restart`,
// which SysV init scripts are required to support.
func (s *Sysvinit) Restart(ctx context.Context, service string) error {
	_, stderr, err := s.run(ctx, "/etc/init.d/"+service, "restart")
	if err != nil {
		return fmt.Errorf("/etc/init.d/%s restart: %s: %w", service, strings.TrimSpace(string(stderr)), err)
	}
	return nil
}

// Caps implements ServiceManager.
func (s *Sysvinit) Caps() ServiceCaps {
	return ServiceCaps{CanRestart: true, CanStatus: false}
}
