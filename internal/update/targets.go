package update

import (
	"context"
	"fmt"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// defaultHealthTimeout/defaultHealthInterval are TelemtTarget.PostRestart's
// defaults: poll for up to 90s, every 2s, per spec 03-update-engine.md
// ("N попыток с backoff" — a fixed short interval within a bounded total
// window; there is nothing to back off from since Health is cheap and
// idempotent).
const (
	defaultHealthTimeout  = 90 * time.Second
	defaultHealthInterval = 2 * time.Second
)

// TelemtTarget is the Target implementation for updating the Telemt
// binary: version and health come from the Telemt SDK client.
type TelemtTarget struct {
	Client       *telemt.Client
	RepoName     string
	BinaryPath_  string
	ServiceName_ string

	// HealthTimeout/HealthInterval override PostRestart's polling window;
	// zero means the defaults above. After returns a channel that fires
	// after d — defaults to time.After; tests inject a fake to control the
	// poll loop without a real wait.
	HealthTimeout  time.Duration
	HealthInterval time.Duration
	After          func(d time.Duration) <-chan time.Time
}

// Name implements Target.
func (t *TelemtTarget) Name() string { return TargetTelemt }

// CurrentVersion implements Target via the SDK's system-info endpoint.
func (t *TelemtTarget) CurrentVersion(ctx context.Context) (string, error) {
	info, err := t.Client.SystemInfo(ctx)
	if err != nil {
		return "", err
	}
	return info.Version, nil
}

// Repo implements Target.
func (t *TelemtTarget) Repo() string { return t.RepoName }

// BinaryPath implements Target.
func (t *TelemtTarget) BinaryPath() string { return t.BinaryPath_ }

// ServiceName implements Target.
func (t *TelemtTarget) ServiceName() string { return t.ServiceName_ }

// PostRestart implements Target: polls SDK Health until it responds
// without error or the timeout elapses.
func (t *TelemtTarget) PostRestart(ctx context.Context) error {
	timeout := t.HealthTimeout
	if timeout <= 0 {
		timeout = defaultHealthTimeout
	}
	interval := t.HealthInterval
	if interval <= 0 {
		interval = defaultHealthInterval
	}
	after := t.After
	if after == nil {
		after = time.After
	}

	deadline := after(timeout)
	var lastErr error
	for {
		_, err := t.Client.Health(ctx)
		if err == nil {
			return nil
		}
		lastErr = err

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline:
			return fmt.Errorf("telemt did not become healthy within %s: %w", timeout, lastErr)
		case <-after(interval):
		}
	}
}

// PanelTarget is the Target implementation for the panel's own
// self-update: version is the build-time version string, and there is no
// health probe (see PostRestart).
type PanelTarget struct {
	Version_     string
	RepoName     string
	BinaryPath_  string
	ServiceName_ string
}

// Name implements Target.
func (t *PanelTarget) Name() string { return TargetPanel }

// CurrentVersion implements Target: the version baked in at build time.
func (t *PanelTarget) CurrentVersion(context.Context) (string, error) {
	return t.Version_, nil
}

// Repo implements Target.
func (t *PanelTarget) Repo() string { return t.RepoName }

// BinaryPath implements Target.
func (t *PanelTarget) BinaryPath() string { return t.BinaryPath_ }

// ServiceName implements Target.
func (t *PanelTarget) ServiceName() string { return t.ServiceName_ }

// PostRestart implements Target: a no-op. The NEW process (the one
// actually running the updated binary) is the only one that can confirm
// success — see ConfirmStartup and runPhases' panel special case, which
// never even calls this method.
func (t *PanelTarget) PostRestart(context.Context) error { return nil }
