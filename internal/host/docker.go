package host

import (
	"context"
	"fmt"
	"strings"
)

// Docker manages a Telemt (or panel) instance running in a container: the
// `service` argument passed to Status/Restart is the container name, not
// a systemd-style unit — the caller resolves it from config
// (host.telemt_container) before calling.
type Docker struct {
	run CmdRunner
}

// NewDocker builds a Docker ServiceManager that runs the docker CLI
// through runner.
func NewDocker(runner CmdRunner) *Docker {
	return &Docker{run: runner}
}

// Kind implements ServiceManager.
func (d *Docker) Kind() string { return KindDocker }

// Status implements ServiceManager via
// `docker inspect -f {{.State.Status}} <container>`. "restarting" is
// mid-cycle — neither reliably up nor down — so it maps to StatusUnknown,
// matching the transitional-state convention systemd's Status uses for
// activating/deactivating/reloading, rather than being lumped in with the
// container's settled-down states.
func (d *Docker) Status(ctx context.Context, container string) (ServiceStatus, error) {
	out, _, runErr := d.run(ctx, "docker", "inspect", "-f", "{{.State.Status}}", container)
	switch strings.TrimSpace(string(out)) {
	case "running":
		return StatusRunning, nil
	case "exited", "dead", "created", "paused":
		return StatusStopped, nil
	case "":
		if runErr != nil {
			return StatusUnknown, runErr
		}
		return StatusUnknown, nil
	default:
		return StatusUnknown, nil
	}
}

// Restart implements ServiceManager via `docker restart <container>`.
func (d *Docker) Restart(ctx context.Context, container string) error {
	_, stderr, err := d.run(ctx, "docker", "restart", container)
	if err != nil {
		return fmt.Errorf("docker restart %s: %s: %w", container, strings.TrimSpace(string(stderr)), err)
	}
	return nil
}

// Caps implements ServiceManager.
func (d *Docker) Caps() ServiceCaps {
	return ServiceCaps{CanRestart: true, CanStatus: true}
}
