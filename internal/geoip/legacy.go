package geoip

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/oschwald/maxminddb-golang/v2"
)

// ImportLegacyFiles activates local 0.6 sources before serving requests, only
// when no 1.x GeoIP configuration exists. It never downloads or edits sources.
// A verified bundle is published before its settings, so a retry after a crash
// either finishes the import or preserves a later administrator configuration.
func ImportLegacyFiles(dataDir string, settings SettingsStore, dbPath, asnPath string) (bool, error) {
	if dbPath == "" && asnPath == "" {
		return false, nil
	}
	if settings == nil {
		return false, coded(ErrorActivationFailed, nil)
	}
	if _, exists, err := settings.GetSetting(configSettingKey); err != nil {
		return false, coded(ErrorActivationFailed, err)
	} else if exists {
		return false, nil
	}
	if dataDir == "" {
		return false, coded(ErrorDataDirRequired, nil)
	}
	inspectDir, err := os.MkdirTemp(dataDir, ".legacy-geoip-")
	if err != nil {
		return false, coded(ErrorActivationFailed, err)
	}
	defer os.RemoveAll(inspectDir)
	cfg := Config{Enabled: true, Source: SourceFiles, Schedule: ScheduleManual}
	for index, original := range []string{dbPath, asnPath} {
		if original == "" {
			continue
		}
		absolute, err := filepath.Abs(original)
		if err != nil {
			return false, coded(ErrorSourceUnavailable, err)
		}
		probe := filepath.Join(inspectDir, "probe.mmdb")
		if err := copyRegularFile(context.Background(), absolute, probe); err != nil {
			return false, err
		}
		reader, err := maxminddb.Open(probe)
		if err != nil {
			return false, coded(ErrorDatabaseInvalid, err)
		}
		kind := reader.Metadata.DatabaseType
		reader.Close()
		if err := os.Remove(probe); err != nil {
			return false, coded(ErrorActivationFailed, err)
		}
		selected := DatabaseConfig{Enabled: true, Location: absolute}
		switch {
		case index == 1 && databaseTypeMatches(KindASN, kind):
			cfg.ASN = selected
		case index == 0 && databaseTypeMatches(KindCountry, kind):
			cfg.Country = selected
		case index == 0 && databaseTypeMatches(KindCity, kind):
			cfg.City = selected
		default:
			return false, coded(ErrorDatabaseType, nil)
		}
	}
	if err := cfg.Validate(); err != nil {
		return false, coded(ErrorDatabaseInvalid, err)
	}
	manager := NewManager(dataDir, settings)
	defer manager.Close()
	b, oldDir, err := manager.buildBundle(manager.ctx, cfg)
	if err != nil {
		return false, err
	}
	defer b.close()
	encoded, err := json.Marshal(cfg)
	if err != nil {
		return false, coded(ErrorActivationFailed, err)
	}
	if err := settings.SetSetting(configSettingKey, string(encoded)); err != nil {
		return false, coded(ErrorActivationFailed, err)
	}
	if oldDir != "" && oldDir != b.dir {
		_ = cleanupOwnedBundles(filepath.Dir(b.dir), cfg, b, oldDir)
	}
	return true, nil
}
