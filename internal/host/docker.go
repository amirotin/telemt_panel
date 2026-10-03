package host

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"strconv"
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

// Start starts an existing configured container; it does not create one.
func (d *Docker) Start(ctx context.Context, container string) error {
	return serviceCommand(ctx, d.run, "docker", "start", container)
}

// Stop stops the configured container without removing it or its volumes.
func (d *Docker) Stop(ctx context.Context, container string) error {
	return serviceCommand(ctx, d.run, "docker", "stop", container)
}

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
	case "exited", "dead", "created":
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

// DockerLog reads container logs via the docker CLI, for a Telemt/panel
// instance running inside Docker; `container` is a container name, same
// convention as Docker.Status/Restart above. It's a separate type from
// Docker rather than a second interface on the same type: ServiceManager
// and LogSource each declare their own Caps() with a different return
// type, so one type can't implement both.
type DockerLog struct {
	run   CmdRunner
	start ProcessStarter
}

// NewDockerLog builds a DockerLog LogSource that runs the docker CLI
// through runner (Tail) and starter (Stream).
func NewDockerLog(runner CmdRunner, starter ProcessStarter) *DockerLog {
	return &DockerLog{run: runner, start: starter}
}

// Kind implements LogSource.
func (d *DockerLog) Kind() string { return LogKindDocker }

// Tail implements LogSource via `docker logs --tail N <ctr>`. docker
// writes the container's stdout and stderr to its own stdout/stderr, and
// CmdRunner captures them as two separate buffers, so true chronological
// interleaving isn't recoverable here — both are parsed as log lines and
// concatenated (stdout first).
func (d *DockerLog) Tail(ctx context.Context, container string, lines int) ([]LogLine, error) {
	stdout, stderr, err := d.run(ctx, "docker", "logs", "--tail", strconv.Itoa(lines), container)
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return nil, newLogSourceError(err, commandLogReason(string(stderr)))
	}
	out := splitDockerLines(stdout, container)
	out = append(out, splitDockerLines(stderr, container)...)
	return out, nil
}

// Stream implements LogSource via `docker logs -f <ctr>`, which the
// ProcessStarter runs with stdout and stderr merged into one stream (see
// ProcessStarter's doc comment in exec.go).
func (d *DockerLog) Stream(ctx context.Context, container string) (<-chan LogEvent, error) {
	rc, err := d.start(ctx, "docker", "logs", "-f", container)
	if err != nil {
		return nil, newLogSourceError(err, "")
	}
	return streamCommandLogs(ctx, rc, func(raw []byte) (LogLine, bool) {
		return LogLine{Level: "unknown", Unit: container, Msg: string(raw)}, true
	}), nil
}

// Caps implements LogSource.
func (d *DockerLog) Caps() LogCaps {
	return LogCaps{CanTail: true, CanStream: true}
}

func splitDockerLines(out []byte, container string) []LogLine {
	var lines []LogLine
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		lines = append(lines, LogLine{Level: "unknown", Unit: container, Msg: scanner.Text()})
	}
	return lines
}
