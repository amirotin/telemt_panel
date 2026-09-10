package migration

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
)

// PrepareLegacyExport reuses identities established by compatibility startup.
// It only changes the in-memory config; it never imports or writes state. The
// panel must be stopped so the exported config and state describe one snapshot.
func PrepareLegacyExport(state *store.Memory, source *config.Source) (LegacyStateReport, error) {
	if source == nil || source.Config == nil || source.Legacy == nil || source.Format != "0.6" || state == nil {
		return LegacyStateReport{}, errors.New("export requires a 0.6 configuration and initialized panel state")
	}
	raw, _, err := state.GetSetting(legacyStateKey)
	var record legacyStateRecord
	if err != nil || json.Unmarshal([]byte(raw), &record) != nil || record.Version != 1 || record.Retained == nil {
		return LegacyStateReport{}, errors.New("export requires completed 1.x compatibility startup with this legacy configuration")
	}
	if source.HasLegacyPlaintextPassword() {
		hash, _, err := state.GetSetting(legacyPasswordKey)
		if err != nil || !source.ReuseLegacyPasswordHash(hash) {
			return LegacyStateReport{}, errors.New("legacy password identity is missing or changed; start 1.x with this legacy configuration before export")
		}
	}
	secret, _, err := state.GetSetting(legacySubpageKey)
	decoded, decodeErr := hex.DecodeString(secret)
	if err != nil || decodeErr != nil || len(decoded) != 32 {
		return LegacyStateReport{}, errors.New("legacy subscription identity is missing or invalid; complete 1.x compatibility startup before export")
	}
	source.Config.Subpage.Secret = secret
	report := legacyStateReport("exported", record.Retained)
	if record.GeoIPComplete {
		report.Pending = slices.DeleteFunc(report.Pending, func(value string) bool { return value == "geoip_activation" })
	}
	return report, nil
}
