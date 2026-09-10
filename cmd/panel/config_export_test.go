package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/migration"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/update"
	"golang.org/x/crypto/bcrypt"
)

func exportFixture(t *testing.T, password, tls string, boot bool) (string, *config.Source, *store.Memory) {
	t.Helper()
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	if err := os.Mkdir(dataDir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "legacy.toml")
	raw := fmt.Sprintf(`listen = '127.0.0.1:8443'
base_path = '/panel'
trusted_proxies = ['127.0.0.1/32', '::1/128']
data_dir = %q
[auth]
username = 'operator'
password_hash = %q
jwt_secret = 'PRIVATE_JWT'
[telemt]
url = 'http://unreachable.invalid:1/PRIVATE_URL'
auth_header = 'PRIVATE_HEADER'
binary_path = '/opt/telemt/bin'
service_name = 'custom-telemt'
config_edit_mode = 'file'
[panel]
binary_path = '/opt/panel/bin'
service_name = 'custom-panel'
github_token = 'PRIVATE_TOKEN'
[panel.auto_update]
enabled = true
auto_apply = true
check_interval = '5m'
[users]
data_quota_bytes = 1500000
`, dataDir, password) + tls
	if err := os.WriteFile(path, []byte(raw), 0400); err != nil {
		t.Fatal(err)
	}
	source, err := loadStartupSource(path)
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.NewState(filepath.Join(dataDir, panelStateFile))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = state.Close() })
	if boot {
		if _, err := migration.PrepareLegacyStartup(state, source); err != nil {
			t.Fatal(err)
		}
	}
	return path, source, state
}

func TestConfigExportPreservesRuntimeAndState(t *testing.T) {
	hash, _ := bcrypt.GenerateFromPassword([]byte("PRIVATE_PASSWORD"), bcrypt.MinCost)
	for name, tls := range map[string]string{
		"http":        "",
		"certificate": "[tls]\ncert_file='relative/cert.pem'\nkey_file='relative/key.pem'\n",
		"acme":        "[tls]\nacme_domain='panel.example.com'\nacme_cache_dir='/unopened/cache'\n",
	} {
		for _, password := range []string{"PRIVATE_PASSWORD", string(hash)} {
			t.Run(fmt.Sprintf("%s/plain=%v", name, password == "PRIVATE_PASSWORD"), func(t *testing.T) {
				path, expected, state := exportFixture(t, password, tls, true)
				// Changes made after the initial import must not be reset by export.
				if err := update.SetAutoSettings(state, update.AutoSettings{Telemt: update.AutoModeOff, Panel: update.AutoModeOff, Interval: 12 * time.Hour}); err != nil {
					t.Fatal(err)
				}
				beforeSource, _ := os.ReadFile(path)
				statePath := filepath.Join(expected.Config.DataDir, panelStateFile)
				beforeState, _ := os.ReadFile(statePath)
				outPath := filepath.Join(filepath.Dir(path), "current.toml")
				var out bytes.Buffer
				if err := runConfigCommand([]string{"export", "--config", path, "--out", outPath}, &out); err != nil {
					t.Fatal(err)
				}
				if out.String() != "{\"status\":\"exported\",\"pending\":[],\"not_applied\":[\"user_defaults\"]}\n" {
					t.Fatal("incorrect export report")
				}
				actual, err := loadStartupSource(outPath)
				if err != nil || actual.Format != "current" {
					t.Fatal("export is not a valid current config", err)
				}
				actual.Config.Path = expected.Config.Path
				if !reflect.DeepEqual(actual.Config, expected.Config) {
					t.Fatal("export changed effective configuration or persisted identities")
				}
				contents, _ := os.ReadFile(outPath)
				if bytes.Contains(contents, []byte("PRIVATE_PASSWORD")) || bytes.Contains(contents, []byte("PRIVATE_JWT")) {
					t.Fatal("legacy plaintext password or JWT retained in export")
				}
				info, _ := os.Stat(outPath)
				if info.Mode().Perm() != 0600 {
					t.Fatal("export permissions are not private")
				}
				afterSource, _ := os.ReadFile(path)
				afterState, _ := os.ReadFile(statePath)
				if !bytes.Equal(beforeSource, afterSource) || !bytes.Equal(beforeState, afterState) {
					t.Fatal("export changed its input or state")
				}
				out.Reset()
				if err := runConfigCommand([]string{"export", "--config", path, "--out", outPath}, &out); err == nil || out.Len() != 0 {
					t.Fatal("existing output was accepted")
				}
				afterOutput, _ := os.ReadFile(outPath)
				if !bytes.Equal(contents, afterOutput) {
					t.Fatal("existing output was overwritten")
				}
			})
		}
	}
}

func TestConfigExportRejectsIncompleteState(t *testing.T) {
	for _, scenario := range []string{"missing", "import-only", "corrupt", "fifo", "changed-password", "bad-marker", "bad-secret"} {
		t.Run(scenario, func(t *testing.T) {
			path, source, state := exportFixture(t, "PRIVATE_PASSWORD", "", false)
			statePath := filepath.Join(source.Config.DataDir, panelStateFile)
			switch scenario {
			case "import-only":
				if _, err := migration.ImportLegacyState(state, source); err != nil {
					t.Fatal(err)
				}
			case "corrupt":
				if err := os.WriteFile(statePath, []byte("PRIVATE_CORRUPT"), 0600); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(statePath, 0600); err != nil {
					t.Fatal(err)
				}
			case "changed-password", "bad-marker", "bad-secret":
				if _, err := migration.PrepareLegacyStartup(state, source); err != nil {
					t.Fatal(err)
				}
				if scenario == "changed-password" {
					raw, _ := os.ReadFile(path)
					if err := os.Chmod(path, 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, bytes.ReplaceAll(raw, []byte("PRIVATE_PASSWORD"), []byte("PRIVATE_CHANGED")), 0600); err != nil {
						t.Fatal(err)
					}
				} else {
					key := "migration.0.6.state"
					if scenario == "bad-secret" {
						key = "migration.0.6.subpage_secret"
					}
					if err := state.SetSetting(key, "PRIVATE_INVALID"); err != nil {
						t.Fatal(err)
					}
				}
			}
			outPath := filepath.Join(filepath.Dir(path), "current.toml")
			var out bytes.Buffer
			err := runConfigCommand([]string{"export", "--config", path, "--out", outPath}, &out)
			if err == nil || out.Len() != 0 || strings.Contains(err.Error(), "PRIVATE") {
				t.Fatal("unsafe state was accepted or secrets leaked")
			}
			if _, err := os.Lstat(outPath); !os.IsNotExist(err) {
				t.Fatal("failed export created output")
			}
		})
	}
}

func TestConfigExportNeverClobbersTargets(t *testing.T) {
	path, _, _ := exportFixture(t, "PRIVATE_PASSWORD", "", true)
	dir := filepath.Dir(path)
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	for _, target := range []string{path, link, fifo, dir, filepath.Join(dir, "PRIVATE_MISSING", "config.toml")} {
		var out bytes.Buffer
		err := runConfigCommand([]string{"export", "--config", path, "--out", target}, &out)
		if err == nil || out.Len() != 0 || strings.Contains(err.Error(), "PRIVATE") {
			t.Fatal("unsafe output accepted or path leaked")
		}
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("source clobbered")
	}
}

func TestConfigExportReportsUnactivatedGeoIP(t *testing.T) {
	path, _, _ := exportFixture(t, "PRIVATE_PASSWORD", "[geoip]\ndb_path='/missing/PRIVATE_CITY.mmdb'\n", true)
	var out bytes.Buffer
	if err := runConfigCommand([]string{"export", "--config", path, "--out", filepath.Join(filepath.Dir(path), "current.toml")}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"geoip_activation"`) || strings.Contains(out.String(), "PRIVATE") {
		t.Fatal("unactivated GeoIP not reported safely")
	}
}

func TestConfigExportRequiresExplicitOutputAndLegacySource(t *testing.T) {
	path, _, _ := exportFixture(t, "PRIVATE_PASSWORD", "", true)
	current := filepath.Join(filepath.Dir(path), "current.toml")
	if err := runConfigCommand([]string{"export", "--config", path, "--out", current}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"export", "--config", path},
		{"check", "--config", path, "--out", current},
		{"export", "--config", current, "--out", current + ".new"},
	} {
		var out bytes.Buffer
		if err := runConfigCommand(args, &out); err == nil || out.Len() != 0 {
			t.Fatal("invalid export command accepted")
		}
	}
}
