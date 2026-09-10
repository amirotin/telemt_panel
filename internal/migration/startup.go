package migration

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/geoip"
	"github.com/amirotin/telemt_panel/internal/store"
)

const legacyPasswordKey = "migration.0.6.password_hash"
const legacySubpageKey = "migration.0.6.subpage_secret"

// PrepareLegacyStartup completes mandatory state before authentication or any
// background scheduler starts. Optional GeoIP failures do not prevent login.
func PrepareLegacyStartup(state *store.Memory, source *config.Source) ([]string, error) {
	report, err := ImportLegacyState(state, source)
	if err != nil {
		return nil, err
	}
	warnings := []string{}
	if report.Status == "imported" {
		warnings = append(warnings, "legacy_state_imported_check_only_6h")
		for _, warning := range source.Warnings {
			switch warning {
			case "telemt_config_api_required", "legacy_session_ttl_defaulted", "legacy_sessions_require_login", "legacy_plaintext_password_hashed":
				warnings = append(warnings, warning)
			}
		}
	}
	if source.HasLegacyPlaintextPassword() {
		hash, _, err := state.GetSetting(legacyPasswordKey)
		if err != nil {
			return nil, errors.New("cannot read legacy password identity")
		}
		if !source.ReuseLegacyPasswordHash(hash) {
			if err := state.SetSetting(legacyPasswordKey, source.Config.Auth.PasswordHash); err != nil {
				return nil, errors.New("cannot persist legacy password identity")
			}
		}
	}
	secret, exists, err := state.GetSetting(legacySubpageKey)
	if err != nil {
		return nil, errors.New("cannot read legacy subscription secret")
	}
	if !exists {
		var data [32]byte
		if _, err := rand.Read(data[:]); err != nil {
			return nil, errors.New("cannot generate subscription secret")
		}
		secret = hex.EncodeToString(data[:])
		if err := state.SetSetting(legacySubpageKey, secret); err != nil {
			return nil, errors.New("cannot persist subscription secret")
		}
	} else if len(secret) != 64 {
		return nil, errors.New("invalid persisted legacy subscription secret")
	}
	source.Config.Subpage.Secret = secret

	raw, _, err := state.GetSetting(legacyStateKey)
	var record legacyStateRecord
	if err != nil || json.Unmarshal([]byte(raw), &record) != nil || record.Retained == nil {
		return nil, errors.New("cannot read retained legacy settings")
	}
	if !record.GeoIPComplete {
		paths := record.Retained.GeoIP
		if _, err := geoip.ImportLegacyFiles(source.Config.DataDir, state, paths.DBPath, paths.ASNDBPath); err != nil {
			warnings = append(warnings, "legacy_geoip_activation_failed")
		} else {
			record.GeoIPComplete = true
			encoded, _ := json.Marshal(record)
			if err := state.SetSetting(legacyStateKey, string(encoded)); err != nil {
				return nil, errors.New("cannot persist legacy GeoIP completion")
			}
		}
	}
	if report.Status == "imported" {
		for _, pending := range report.Pending {
			if pending != "geoip_activation" {
				warnings = append(warnings, "legacy_"+pending)
			}
		}
	}
	return warnings, nil
}
