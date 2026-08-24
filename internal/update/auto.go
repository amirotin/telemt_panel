package update

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

// Auto-update mode values (config-independent — these live in the store,
// not config.toml; see AutoSettings).
const (
	AutoModeOff   = "off"
	AutoModeCheck = "check"
	AutoModeApply = "apply"
)

// Store setting keys AutoSettings is persisted under (spec
// 03-update-engine.md: "живут в store", never in config.toml).
const (
	autoSettingKeyTelemt   = "auto_update.telemt"
	autoSettingKeyPanel    = "auto_update.panel"
	autoSettingKeyInterval = "auto_update.interval"
)

// defaultAutoInterval/minAutoInterval bound AutoSettings.Interval: default
// 6h, floor 1h (spec).
const (
	defaultAutoInterval = 6 * time.Hour
	minAutoInterval     = 1 * time.Hour
)

// AutoSettings is the auto-update scheduler's configuration, mirroring
// openapi AutoUpdateSettings.
type AutoSettings struct {
	Telemt   string // off | check | apply
	Panel    string // off | check | apply
	Interval time.Duration
}

// GetAutoSettings reads AutoSettings from the store, filling in defaults
// (off/off/6h) for any key that has never been set — the settings a fresh
// install starts with.
func GetAutoSettings(st store.Store) (AutoSettings, error) {
	out := AutoSettings{Telemt: AutoModeOff, Panel: AutoModeOff, Interval: defaultAutoInterval}

	if v, ok, err := st.GetSetting(autoSettingKeyTelemt); err != nil {
		return AutoSettings{}, err
	} else if ok {
		out.Telemt = v
	}
	if v, ok, err := st.GetSetting(autoSettingKeyPanel); err != nil {
		return AutoSettings{}, err
	} else if ok {
		out.Panel = v
	}
	if v, ok, err := st.GetSetting(autoSettingKeyInterval); err != nil {
		return AutoSettings{}, err
	} else if ok {
		if d, err := time.ParseDuration(v); err == nil && d >= minAutoInterval {
			out.Interval = d
		}
	}
	return out, nil
}

// SetAutoSettings validates s and persists it to the store. An invalid
// mode or an interval below minAutoInterval is rejected without writing
// anything.
func SetAutoSettings(st store.Store, s AutoSettings) error {
	if err := validateAutoMode(s.Telemt); err != nil {
		return err
	}
	if err := validateAutoMode(s.Panel); err != nil {
		return err
	}
	if s.Interval < minAutoInterval {
		return fmt.Errorf("update: auto interval must be >= %s", minAutoInterval)
	}

	if err := st.SetSetting(autoSettingKeyTelemt, s.Telemt); err != nil {
		return err
	}
	if err := st.SetSetting(autoSettingKeyPanel, s.Panel); err != nil {
		return err
	}
	return st.SetSetting(autoSettingKeyInterval, s.Interval.String())
}

func validateAutoMode(m string) error {
	switch m {
	case AutoModeOff, AutoModeCheck, AutoModeApply:
		return nil
	default:
		return fmt.Errorf("update: invalid auto-update mode %q", m)
	}
}

// AutoUpdater is the single per-process scheduler that ticks at the
// configured interval and, per target, checks (publishing an availability
// notice) or applies (via the same Engine lock manual Apply uses) —
// spec 03-update-engine.md: "один тикер на процесс (не по горутине на
// цель)".
type AutoUpdater struct {
	st     store.Store
	engine *Engine

	// after returns a channel that fires after d; defaults to time.After.
	// Tests inject a fake so the scheduler loop can be driven tick-by-tick
	// without a real wait.
	after func(d time.Duration) <-chan time.Time
}

// NewAutoUpdater builds an AutoUpdater reading settings from st and
// applying updates through engine.
func NewAutoUpdater(st store.Store, engine *Engine) *AutoUpdater {
	return &AutoUpdater{st: st, engine: engine, after: time.After}
}

// Run drives the scheduler loop until ctx is canceled: on each tick it
// re-reads AutoSettings (so a live settings change takes effect on the
// next tick without a process restart) and acts on both targets. A
// settings read failure is logged and treated as "off" for that tick
// rather than crashing the loop.
func (a *AutoUpdater) Run(ctx context.Context) {
	for {
		settings, err := GetAutoSettings(a.st)
		if err != nil {
			slog.Error("auto-update: read settings", "err", err)
			settings = AutoSettings{Telemt: AutoModeOff, Panel: AutoModeOff, Interval: defaultAutoInterval}
		}

		select {
		case <-ctx.Done():
			return
		case <-a.after(settings.Interval):
			a.tick(ctx, settings)
		}
	}
}

func (a *AutoUpdater) tick(ctx context.Context, settings AutoSettings) {
	a.tickTarget(ctx, TargetTelemt, settings.Telemt)
	a.tickTarget(ctx, TargetPanel, settings.Panel)
}

// tickTarget acts on one target's mode for the current tick. GitHub
// failures are logged and swallowed here too (see CheckAndPublish's doc
// comment on the 10-minute release cache standing in for real backoff);
// ErrBusy in apply mode is expected whenever the other target's tick (or a
// manual Apply) is already running and is likewise not an error worth
// logging loudly.
func (a *AutoUpdater) tickTarget(ctx context.Context, target, mode string) {
	switch mode {
	case AutoModeOff, "":
		return
	case AutoModeCheck:
		a.engine.CheckAndPublish(ctx, target)
	case AutoModeApply:
		version, ok, err := a.engine.LatestVersion(ctx, target)
		if err != nil {
			slog.Warn("auto-update: check before apply", "target", target, "err", err)
			return
		}
		if !ok {
			return
		}
		if err := a.engine.StartApply(target, version); err != nil && !errors.Is(err, ErrBusy) {
			slog.Error("auto-update: start apply", "target", target, "err", err)
		}
	default:
		slog.Warn("auto-update: unknown mode, skipping", "target", target, "mode", mode)
	}
}
