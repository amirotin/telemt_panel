package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

const sampleConfig = `# Telemt Panel Configuration
listen = "0.0.0.0:8080"

[telemt]
# Telemt API base URL (no trailing slash)
url = "http://127.0.0.1:9091"

[telemt.auto_update]
enabled = false
# check_interval = "1h"
auto_apply = true

[auth]
username = "admin"  # admin login
password_hash = "$2a$10$x"
jwt_secret = "s"
`

func writeSample(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSaveAutoUpdateSettingsPreservesCommentsAndFormatting(t *testing.T) {
	path := writeSample(t, sampleConfig)

	err := SaveAutoUpdateSettings(path, map[string]AutoUpdateConfig{
		"telemt": {Enabled: true, CheckInterval: "30m", AutoApply: false},
		"panel":  {Enabled: true, CheckInterval: "6h", AutoApply: false},
	})
	if err != nil {
		t.Fatal(err)
	}

	got, _ := os.ReadFile(path)
	s := string(got)

	for _, want := range []string{
		"# Telemt Panel Configuration",
		"# Telemt API base URL (no trailing slash)",
		`username = "admin"  # admin login`,
		`# check_interval = "1h"`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("comment/formatting lost: %q\n---\n%s", want, s)
		}
	}

	// Existing section updated in place; commented key stays commented and a
	// real check_interval is added.
	if !strings.Contains(s, "enabled = true") || !strings.Contains(s, `check_interval = "30m"`) {
		t.Errorf("telemt.auto_update not updated:\n%s", s)
	}
	// Missing [panel.auto_update] section appended.
	if !strings.Contains(s, "[panel.auto_update]") || !strings.Contains(s, `check_interval = "6h"`) {
		t.Errorf("panel.auto_update not appended:\n%s", s)
	}

	// Result must stay parseable and semantically correct.
	var cfg Config
	if err := toml.Unmarshal(got, &cfg); err != nil {
		t.Fatalf("result is not valid TOML: %v\n%s", err, s)
	}
	if !cfg.Telemt.AutoUpdate.Enabled || cfg.Telemt.AutoUpdate.CheckInterval != "30m" || cfg.Telemt.AutoUpdate.AutoApply {
		t.Errorf("telemt values wrong: %+v", cfg.Telemt.AutoUpdate)
	}
	if !cfg.Panel.AutoUpdate.Enabled || cfg.Panel.AutoUpdate.CheckInterval != "6h" {
		t.Errorf("panel values wrong: %+v", cfg.Panel.AutoUpdate)
	}
}

func TestSaveAutoUpdateSettingsIdempotentOutsideSections(t *testing.T) {
	path := writeSample(t, sampleConfig)
	settings := map[string]AutoUpdateConfig{
		"telemt": {Enabled: false, CheckInterval: "1h", AutoApply: true},
	}
	if err := SaveAutoUpdateSettings(path, settings); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(path)
	if err := SaveAutoUpdateSettings(path, settings); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(path)
	if string(first) != string(second) {
		t.Errorf("second save changed the file:\n--- first\n%s\n--- second\n%s", first, second)
	}
}
