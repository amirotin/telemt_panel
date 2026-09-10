// Package migration prepares the supported production 0.6 upgrade path.
package migration

import (
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/update"
)

const legacyStateKey = "migration.0.6.state"

type legacyStateRecord struct {
	Version  int                 `json:"version"`
	Retained *config.LegacyCarry `json:"retained"`
}

// LegacyStateReport contains only fixed labels and scheduler values, not config
// contents. Pending groups remain retained in state for subsequent upgrade steps.
type LegacyStateReport struct {
	Status        string   `json:"status"`
	TelemtMode    string   `json:"imported_telemt_mode"`
	PanelMode     string   `json:"imported_panel_mode"`
	CheckInterval string   `json:"imported_check_interval"`
	Pending       []string `json:"pending"`
}

// ImportLegacyState initializes an empty durable control-plane store once.
// The caller must have exclusive use of the destination (the daemon stopped).
// No authentication, history, GeoIP activation or source-config writes occur.
func ImportLegacyState(state *store.Memory, source *config.Source) (LegacyStateReport, error) {
	if source == nil || source.Format != "0.6" || source.Legacy == nil {
		return LegacyStateReport{}, errors.New("state initialization requires a validated 0.6 configuration")
	}
	if state == nil || !state.StateDurable() {
		return LegacyStateReport{}, errors.New("legacy state initialization requires persistent data_dir")
	}
	if raw, exists, err := state.GetSetting(legacyStateKey); err != nil {
		return LegacyStateReport{}, errors.New("cannot read legacy state marker")
	} else if exists {
		var record legacyStateRecord
		if json.Unmarshal([]byte(raw), &record) != nil || record.Version != 1 || record.Retained == nil {
			return LegacyStateReport{}, errors.New("invalid legacy state marker; existing state was not changed")
		}
		return legacyStateReport("already_imported", record.Retained), nil
	}
	policies, err := state.ListStoragePolicies()
	if err != nil || !slices.Equal(policies, store.DefaultStoragePolicies()) {
		return LegacyStateReport{}, errors.New("legacy state initialization cannot replace existing storage policies")
	}

	// Reuse the scheduler's serializer and the existing atomic empty-store
	// import instead of introducing a separate transaction or state-file writer.
	draft, err := store.NewState("")
	if err != nil {
		return LegacyStateReport{}, err
	}
	defer draft.Close()
	legacy := source.Legacy
	if err := update.SetAutoSettings(draft, update.AutoSettings{
		Telemt: legacyAutoMode(legacy.TelemtAuto.Enabled),
		Panel:  legacyAutoMode(legacy.PanelAuto.Enabled), Interval: 6 * time.Hour,
	}); err != nil {
		return LegacyStateReport{}, err
	}
	encoded, err := json.Marshal(legacyStateRecord{Version: 1, Retained: legacy})
	if err != nil {
		return LegacyStateReport{}, errors.New("cannot prepare legacy state marker")
	}
	if err := draft.SetSetting(legacyStateKey, string(encoded)); err != nil {
		return LegacyStateReport{}, err
	}
	data, err := draft.ExportData()
	if err != nil {
		return LegacyStateReport{}, err
	}
	if err := state.ImportData(data); err != nil {
		if errors.Is(err, store.ErrStoreNotEmpty) {
			return LegacyStateReport{}, errors.New("legacy state initialization requires an empty destination; existing state was not changed")
		}
		return LegacyStateReport{}, errors.New("cannot persist legacy state; initialization was not completed")
	}
	return legacyStateReport("imported", legacy), nil
}

func legacyAutoMode(enabled bool) string {
	if enabled {
		return update.AutoModeCheck
	}
	return update.AutoModeOff
}

func legacyStateReport(status string, legacy *config.LegacyCarry) LegacyStateReport {
	pending := []string{}
	if legacy.GeoIP != (config.LegacyGeoIP{}) {
		pending = append(pending, "geoip_activation")
	}
	if legacy.Users != (config.LegacyUserDefaults{}) {
		pending = append(pending, "user_defaults_review")
	}
	if legacy.MaxNewerReleases != 0 || legacy.MaxOlderReleases != 0 {
		pending = append(pending, "release_limits_review")
	}
	if legacy.TelemtConfigPath != "" {
		pending = append(pending, "unused_telemt_config_path")
	}
	if legacy.InactiveCacheDir != "" {
		pending = append(pending, "inactive_acme_cache")
	}
	return LegacyStateReport{Status: status,
		TelemtMode: legacyAutoMode(legacy.TelemtAuto.Enabled),
		PanelMode:  legacyAutoMode(legacy.PanelAuto.Enabled), CheckInterval: "6h", Pending: pending}
}
