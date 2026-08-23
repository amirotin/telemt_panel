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
