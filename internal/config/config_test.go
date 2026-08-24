package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func load(t *testing.T, content string) (*Config, error) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return Load(path)
}

const minimal = `
[telemt]
url = "http://127.0.0.1:9091"

[auth]
username = "admin"
password_hash = "$2a$10$x"
`

func TestLoadMinimal(t *testing.T) {
	cfg, err := load(t, minimal)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "0.0.0.0:8080" || cfg.Store.Driver != "memory" {
		t.Errorf("defaults wrong: %+v", cfg)
	}
	if got := cfg.Auth.SessionTTLDuration(); got != 720*time.Hour {
		t.Errorf("default TTL = %v", got)
	}
	if cfg.DataDir != "/var/lib/telemt-panel" {
		t.Errorf("default data_dir = %q, want /var/lib/telemt-panel", cfg.DataDir)
	}
	wantHost := HostConfig{
		ServiceManager:  "auto",
		LogSource:       "auto",
		TelemtService:   "telemt",
		PanelService:    "telemt-panel",
		TelemtContainer: "telemt",
		PanelContainer:  "telemt-panel",
	}
	if cfg.Host != wantHost {
		t.Errorf("default host = %+v, want %+v", cfg.Host, wantHost)
	}
	wantUpdates := UpdatesConfig{
		TelemtRepo:       "telemt/telemt",
		PanelRepo:        "amirotin/telemt_panel",
		TelemtBinaryPath: "/bin/telemt",
		PanelBinaryPath:  "/usr/local/bin/telemt-panel",
	}
	if cfg.Updates != wantUpdates {
		t.Errorf("default updates = %+v, want %+v", cfg.Updates, wantUpdates)
	}
}

func TestLoadDataDirEmptyDisablesMirror(t *testing.T) {
	cfg, err := load(t, `data_dir = ""`+"\n"+minimal)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataDir != "" {
		t.Errorf("data_dir = %q, want empty (mirror disabled)", cfg.DataDir)
	}
}

func TestLoadHostAndUpdatesOverrides(t *testing.T) {
	cfg, err := load(t, minimal+`
[host]
service_manager = "openrc"
log_source = "file"
log_file = "/var/log/telemt.log"
telemt_service = "telemt-custom"
panel_service = "panel-custom"
telemt_container = "telemt-ct"
panel_container = "panel-ct"

[updates]
telemt_repo = "acme/telemt"
panel_repo = "acme/panel"
github_token = "ghp_x"
telemt_binary_path = "/opt/telemt"
panel_binary_path = "/opt/panel"
`)
	if err != nil {
		t.Fatal(err)
	}
	wantHost := HostConfig{
		ServiceManager:  "openrc",
		LogSource:       "file",
		LogFile:         "/var/log/telemt.log",
		TelemtService:   "telemt-custom",
		PanelService:    "panel-custom",
		TelemtContainer: "telemt-ct",
		PanelContainer:  "panel-ct",
	}
	if cfg.Host != wantHost {
		t.Errorf("host = %+v, want %+v", cfg.Host, wantHost)
	}
	wantUpdates := UpdatesConfig{
		TelemtRepo:       "acme/telemt",
		PanelRepo:        "acme/panel",
		GithubToken:      "ghp_x",
		TelemtBinaryPath: "/opt/telemt",
		PanelBinaryPath:  "/opt/panel",
	}
	if cfg.Updates != wantUpdates {
		t.Errorf("updates = %+v, want %+v", cfg.Updates, wantUpdates)
	}
}

func TestLoadValidation(t *testing.T) {
	cases := []struct {
		name, content, wantErr string
	}{
		{"missing telemt url", `[auth]
username = "a"
password_hash = "h"`, "telemt.url"},
		{"missing password", `[telemt]
url = "http://x"
[auth]
username = "a"`, "password_hash"},
		{"sqlite without path", minimal + `
[store]
driver = "sqlite"`, "store.path"},
		{"unknown store driver", minimal + `
[store]
driver = "postgres"`, "unknown driver"},
		{"subpage without secret", minimal + `
[subpage]
enabled = true`, "subpage.secret"},
		{"unknown service manager", minimal + `
[host]
service_manager = "launchd"`, "host.service_manager"},
		{"unknown log source", minimal + `
[host]
log_source = "eventlog"`, "host.log_source"},
		// Top-level keys must precede sections in TOML.
		{"bad trusted proxy", `trusted_proxies = ["not-an-ip"]` + minimal, "trusted_proxies"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := load(t, tc.content)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestLoadTrustedProxiesAndBasePath(t *testing.T) {
	cfg, err := load(t, `
base_path = "panel/"
trusted_proxies = ["127.0.0.1", "10.0.0.0/8"]
`+minimal)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BasePath != "/panel" {
		t.Errorf("base_path = %q", cfg.BasePath)
	}
	if len(cfg.TrustedProxyPrefixes) != 2 || cfg.TrustedProxyPrefixes[0].String() != "127.0.0.1/32" {
		t.Errorf("prefixes = %v", cfg.TrustedProxyPrefixes)
	}
}
