package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
)

func TestLoadRejectsUnknownKeysWithoutValues(t *testing.T) {
	for _, tc := range []struct{ name, prefix, suffix, keys string }{
		{"top-level", "lissten = 'SECRET_TOKEN'\n", "", "lissten"},
		{"nested", "", "passwrod_hash = 'SECRET_PASSWORD'", "auth.passwrod_hash"},
		{"several-sorted", "z_unknown = 'SECRET_TOKEN'\na_unknown = 17\n", "passwrod_hash = 'SECRET_PASSWORD'", "a_unknown, auth.passwrod_hash, z_unknown"},
		{"empty-table", "", "\n[unknown]\n", "unknown"},
		{"nested-empty-table", "", "\n[host.extra]\n", "host.extra"},
		{"dotted", "host.log_sorce = 'SECRET_TOKEN'\n", "", "host.log_sorce"},
		{"inline", "host = { log_sorce = 'SECRET_TOKEN' }\n", "", "host.log_sorce"},
		{"quoted", "", "\n[\"strange.section\"]\n", `"strange.section"`},
		{"quoted-dotted", "host.\"log.source\" = 'SECRET_TOKEN'\n", "", `host."log.source"`},
		{"ignored-internal", "Path = 'SECRET_TOKEN'\n", "", "Path"},
		{"array-deduplicated", "[[unknown]]\nvalue='SECRET_TOKEN'\n[[unknown]]\nvalue='SECRET_PASSWORD'\n", "", "unknown, unknown.value"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			content := tc.prefix + minimal + "\n" + tc.suffix
			path := filepath.Join(t.TempDir(), "config.toml")
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				cfg, err := Load(path)
				if cfg != nil || err == nil {
					t.Fatal("unknown keys accepted")
				}
				want := "unknown config keys: " + tc.keys
				if err.Error() != want {
					t.Fatalf("error = %q, want %q", err, want)
				}
				if strings.Contains(err.Error(), "SECRET_") {
					t.Fatal("secret value disclosed")
				}
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != content {
				t.Fatalf("config mutated: %v", err)
			}
		})
	}
}

func TestLoadStrictAllDeclaredFieldsAndExample(t *testing.T) {
	cfg, err := load(t, minimal)
	if err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err := toml.NewEncoder(&encoded).Encode(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := load(t, encoded.String()); err != nil {
		t.Fatalf("declared fields rejected: %v", err)
	}
	if _, err := Load(filepath.Join("..", "..", "config.example.toml")); err != nil {
		t.Fatalf("example rejected: %v", err)
	}
}

func TestLoadStillRejectsDuplicateAndWrongType(t *testing.T) {
	for _, content := range []string{"listen = 123\n" + minimal, "listen = 'a'\nlisten = 'b'\n" + minimal, minimal + "\nusername = 'again'"} {
		if cfg, err := load(t, content); err == nil || cfg != nil || !strings.HasPrefix(err.Error(), "parse config:") {
			t.Fatalf("syntax/type error changed: %v", err)
		}
	}
}
