package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIndependentAccessValidation(t *testing.T) {
	for _, tc := range []struct {
		name, panelListen, subListen, public, path, panelMode, subMode string
		wantErr                                                        bool
	}{
		{"HTTP", "127.0.0.1:8080", "127.0.0.1:8081", "http://links.example:8081", "/clients", "http", "http", false},
		{"proxy", "127.0.0.1:8080", "127.0.0.1:8081", "https://links.example/clients/", "/clients", "http", "http", false},
		{"same port", "127.0.0.1:8080", "0.0.0.0:8080", "", "/clients", "http", "http", true},
		{"path mismatch", ":8080", ":8081", "https://links.example/other", "/clients", "http", "http", true},
		{"credentials", ":8080", ":8081", "https://admin:pass@links.example", "/clients", "http", "http", true},
		{"query", ":8080", ":8081", "https://links.example?secret=x", "/clients", "http", "http", true},
		{"prefix traversal", ":8080", ":8081", "", "/a/../b", "http", "http", true},
		{"ACME reserved", ":80", ":8444", "https://links.example", "/clients", "http", "acme", true},
		{"independent ACME", ":8443", ":8444", "https://links.example:8444", "/clients", "acme", "acme", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &Config{Listen: tc.panelListen, DataDir: t.TempDir(), TLS: TLSConfig{Mode: tc.panelMode}, Subpage: SubpageConfig{Enabled: true, Listen: tc.subListen, PublicURL: tc.public, BasePath: tc.path, TLS: TLSConfig{Mode: tc.subMode}}}
			if tc.panelMode == "acme" {
				cfg.TLS.AcmeDomain = "admin.example"
				cfg.TLS.AcmeCacheDir = filepath.Join(cfg.DataDir, "certs")
			}
			if tc.subMode == "acme" {
				cfg.Subpage.TLS.AcmeDomain = "links.example"
			}
			err := cfg.NormalizeAccess()
			if (err != nil) != tc.wantErr {
				t.Fatalf("NormalizeAccess()=%v", err)
			}
		})
	}
}

func TestSaveSubscriptionPreservesIdentityAndPanel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.toml")
	if err := os.WriteFile(path, []byte(transportFixture), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := OpenTLSFile(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var key string
	for _, enabled := range []bool{true, false, true} {
		snapshot, err := f.Read()
		if err != nil {
			t.Fatal(err)
		}
		candidate := TLSCandidate{Enabled: enabled, Listen: "127.0.0.1:8081", BasePath: "/clients", PublicURL: "https://links.example", TLS: TLSConfig{Mode: "http"}}
		if err := f.SaveAccess(snapshot.Revision, candidate, true, true); err != nil {
			t.Fatal(err)
		}
		cfg, err := Load(path)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Listen != "127.0.0.1:8080" || cfg.BasePath != "/admin" || cfg.Subpage.Enabled != enabled || cfg.Subpage.Secret == "" {
			t.Fatal("endpoint or identity not preserved")
		}
		if key != "" && key != cfg.Subpage.Secret {
			t.Fatal("toggle rotated subscription identity")
		}
		key = cfg.Subpage.Secret
	}
}
