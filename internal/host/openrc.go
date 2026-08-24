package host

import (
	"context"
	"fmt"
	"strings"
)

// OpenRC manages services through rc-service.
type OpenRC struct {
	run CmdRunner
}

// NewOpenRC builds an OpenRC ServiceManager that runs rc-service through
// runner.
func NewOpenRC(runner CmdRunner) *OpenRC {
	return &OpenRC{run: runner}
}

// Kind implements ServiceManager.
func (o *OpenRC) Kind() string { return KindOpenRC }

// Status implements ServiceManager via `rc-service <svc> status`, whose
// output ("* status: started"/"stopped"/"crashed") is matched by
// substring — the exact prefix varies across OpenRC versions.
func (o *OpenRC) Status(ctx context.Context, service string) (ServiceStatus, error) {
	out, _, runErr := o.run(ctx, "rc-service", service, "status")
	state := strings.ToLower(strings.TrimSpace(string(out)))
	switch {
	case strings.Contains(state, "started"):
		return StatusRunning, nil
	case strings.Contains(state, "stopped"), strings.Contains(state, "crashed"):
		return StatusStopped, nil
	case state == "":
		if runErr != nil {
			return StatusUnknown, runErr
		}
		return StatusUnknown, nil
	default:
		return StatusUnknown, nil
	}
}

// Restart implements ServiceManager via `rc-service <svc> restart`.
func (o *OpenRC) Restart(ctx context.Context, service string) error {
	_, stderr, err := o.run(ctx, "rc-service", service, "restart")
	if err != nil {
		return fmt.Errorf("rc-service %s restart: %s: %w", service, strings.TrimSpace(string(stderr)), err)
	}
	return nil
}

// Caps implements ServiceManager.
func (o *OpenRC) Caps() ServiceCaps {
	return ServiceCaps{CanRestart: true, CanStatus: true}
}
