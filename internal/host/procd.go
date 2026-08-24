package host

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Procd manages services through OpenWrt's /etc/init.d scripts.
type Procd struct {
	run CmdRunner
}

// NewProcd builds a Procd ServiceManager that runs /etc/init.d/<service>
// through runner.
func NewProcd(runner CmdRunner) *Procd {
	return &Procd{run: runner}
}

// Kind implements ServiceManager.
func (p *Procd) Kind() string { return KindProcd }

// Status implements ServiceManager via `/etc/init.d/<svc> running`, which
// OpenWrt init scripts signal purely through exit code (0 = running,
// nonzero = stopped); there's no stdout to parse.
func (p *Procd) Status(ctx context.Context, service string) (ServiceStatus, error) {
	_, _, err := p.run(ctx, "/etc/init.d/"+service, "running")
	if err == nil {
		return StatusRunning, nil
	}
	var exitErr *ExitError
	if errors.As(err, &exitErr) {
		return StatusStopped, nil
	}
	return StatusUnknown, err
}

// Restart implements ServiceManager via `/etc/init.d/<svc> restart`.
func (p *Procd) Restart(ctx context.Context, service string) error {
	_, stderr, err := p.run(ctx, "/etc/init.d/"+service, "restart")
	if err != nil {
		return fmt.Errorf("/etc/init.d/%s restart: %s: %w", service, strings.TrimSpace(string(stderr)), err)
	}
	return nil
}

// Caps implements ServiceManager.
func (p *Procd) Caps() ServiceCaps {
	return ServiceCaps{CanRestart: true, CanStatus: true}
}
