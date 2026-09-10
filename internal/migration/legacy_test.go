package migration

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/update"
)

func legacySource() *config.Source {
	return &config.Source{Format: "0.6", Config: &config.Config{}, Legacy: &config.LegacyCarry{
		TelemtAuto:       config.LegacyAutoUpdate{Enabled: true, AutoApply: true, CheckInterval: "5m"},
		PanelAuto:        config.LegacyAutoUpdate{Enabled: true, CheckInterval: "24h"},
		GeoIP:            config.LegacyGeoIP{DBPath: "/not-opened/city.mmdb", ASNDBPath: "relative/asn.mmdb"},
		Users:            config.LegacyUserDefaults{MaxTCPConns: 12, DataQuotaBytes: 1500000},
		MaxNewerReleases: 9, MaxOlderReleases: 3, TelemtConfigPath: "/old/telemt.toml", InactiveCacheDir: "/old/certs",
	}}
}

func TestLegacyStateImportIsAtomicPersistentAndIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	state, err := store.NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	source := legacySource()
	source.Config.Auth.PasswordHash = "PRIVATE_HASH"
	source.Config.Telemt.AuthHeader = "PRIVATE_API_TOKEN"
	source.Config.Updates.GithubToken = "PRIVATE_GITHUB_TOKEN"
	report, err := ImportLegacyState(state, source)
	if err != nil || report.Status != "imported" || len(report.Pending) != 3 || !reflect.DeepEqual(report.NotApplied, []string{"user_defaults", "release_limits"}) {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	state, err = store.NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	auto, err := update.GetAutoSettings(state)
	if err != nil || auto.Telemt != update.AutoModeCheck || auto.Panel != update.AutoModeCheck || auto.Interval != 6*time.Hour {
		t.Fatalf("unexpected scheduler: %+v, %v", auto, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || bytes.Contains(data, []byte("PRIVATE")) {
		t.Fatal("state read failed or startup credentials copied")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("state is not private")
	}
	raw, _, _ := state.GetSetting(legacyStateKey)
	var record legacyStateRecord
	if json.Unmarshal([]byte(raw), &record) != nil || !reflect.DeepEqual(record.Retained, source.Legacy) {
		t.Fatal("legacy values were lost")
	}
	portable, _ := state.ExportData()
	if len(portable.Sessions) != 0 || len(portable.WebAuthnCredentials) != 0 || !store.PortableHistoryEmpty(portable) || len(portable.Settings) != 2 {
		t.Fatal("import created authentication, history or active GeoIP settings")
	}
	changed := update.AutoSettings{Telemt: update.AutoModeApply, Panel: update.AutoModeOff, Interval: 12 * time.Hour}
	if err := update.SetAutoSettings(state, changed); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	source.Legacy.PanelAuto.Enabled = false
	report, err = ImportLegacyState(state, source)
	after, _ := os.ReadFile(path)
	actual, _ := update.GetAutoSettings(state)
	if err != nil || report.Status != "already_imported" || !bytes.Equal(before, after) || actual != changed {
		t.Fatal("repeat import changed administrator settings")
	}
}

func TestLegacyStateImportUsesCheckOrOffAndSixHours(t *testing.T) {
	for _, telemtEnabled := range []bool{false, true} {
		for _, panelEnabled := range []bool{false, true} {
			state, _ := store.NewState(filepath.Join(t.TempDir(), "state.json"))
			source := legacySource()
			source.Legacy.TelemtAuto.Enabled = telemtEnabled
			source.Legacy.PanelAuto.Enabled = panelEnabled
			source.Legacy.PanelAuto.AutoApply = true
			source.Legacy.PanelAuto.CheckInterval = "invalid-old-interval"
			if _, err := ImportLegacyState(state, source); err != nil {
				t.Fatal(err)
			}
			auto, err := update.GetAutoSettings(state)
			if err != nil || (auto.Telemt == update.AutoModeCheck) != telemtEnabled || (auto.Panel == update.AutoModeCheck) != panelEnabled || auto.Telemt == update.AutoModeApply || auto.Panel == update.AutoModeApply || auto.Interval != 6*time.Hour {
				t.Fatal("approved migration policy changed")
			}
			state.Close()
		}
	}
}

func TestLegacyStateImportRefusesExistingOrInvalidState(t *testing.T) {
	for _, marker := range []string{"", "PRIVATE_BAD_JSON", `{"version":2,"retained":{}}`, `{"version":1}`} {
		path := filepath.Join(t.TempDir(), "state.json")
		state, _ := store.NewState(path)
		if marker == "" {
			if err := state.SetSetting("existing", "PRIVATE_EXISTING"); err != nil {
				t.Fatal(err)
			}
		} else if err := state.SetSetting(legacyStateKey, marker); err != nil {
			t.Fatal(err)
		}
		before, _ := os.ReadFile(path)
		_, err := ImportLegacyState(state, legacySource())
		after, _ := os.ReadFile(path)
		if err == nil || strings.Contains(err.Error(), "PRIVATE") || !bytes.Equal(before, after) {
			t.Fatal("existing state overwritten or error leaked values")
		}
		state.Close()
	}
	volatile, _ := store.NewState("")
	if _, err := ImportLegacyState(volatile, legacySource()); err == nil {
		t.Fatal("volatile import accepted")
	}
}

func TestLegacyStateImportWriteFailureCanBeRetried(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	state, _ := store.NewState(path)
	defer state.Close()
	// A directory at the destination forces the atomic rename to fail even as root.
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportLegacyState(state, legacySource()); err == nil {
		t.Fatal("write failure ignored")
	}
	data, _ := state.ExportData()
	if len(data.Settings) != 0 {
		t.Fatal("partial import remained in memory")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatal("temporary state file leaked")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportLegacyState(state, legacySource()); err != nil {
		t.Fatalf("retry failed: %v", err)
	}
}

func TestLegacyStateImportPreservesExistingStoragePolicies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	state, _ := store.NewState(path)
	defer state.Close()
	policies := store.DefaultStoragePolicies()
	policies[0].Enabled = false
	if err := state.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	if _, err := ImportLegacyState(state, legacySource()); err == nil {
		t.Fatal("custom policies overwritten")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("destination changed on rejection")
	}
}

func TestLegacyDefaultsAreArchivedWithoutApplyingOrRepeatingWarnings(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")
	state, err := store.NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	defer state.Close()
	source := legacySource()
	source.Config.DataDir = dir
	source.Legacy.GeoIP = config.LegacyGeoIP{}
	source.Legacy.TelemtConfigPath = ""
	source.Legacy.InactiveCacheDir = ""
	// An old absolute expiry must not become a new-account default again.
	source.Legacy.Users.Expiration = "2020-01-01T00:00:00Z"
	warnings, err := PrepareLegacyStartup(state, source)
	if err != nil || !slices.Contains(warnings, "legacy_user_defaults_not_applied") || !slices.Contains(warnings, "legacy_release_limits_not_applied") {
		t.Fatalf("warnings=%v err=%v", warnings, err)
	}
	before, _ := os.ReadFile(path)
	report, err := ImportLegacyState(state, source)
	if err != nil || len(report.Pending) != 0 || !slices.Equal(report.NotApplied, []string{"user_defaults", "release_limits"}) {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	warnings, err = PrepareLegacyStartup(state, source)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("repeat startup warnings=%v err=%v", warnings, err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("report or repeat startup rewrote archived values")
	}
	raw, _, _ := state.GetSetting(legacyStateKey)
	var record legacyStateRecord
	if json.Unmarshal([]byte(raw), &record) != nil || !reflect.DeepEqual(record.Retained, source.Legacy) {
		t.Fatal("archived defaults or release limits lost")
	}
	data, err := state.ExportData()
	if err != nil || len(data.Settings) != 3 || len(data.Sessions) != 0 || !store.PortableHistoryEmpty(data) {
		t.Fatal("compatibility startup activated unexpected settings or data")
	}
}
