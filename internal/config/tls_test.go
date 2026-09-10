package config

import (
	"strings"
	"testing"
)

func TestTLSConfig(t *testing.T) {
	for _, tt := range []struct{ name, body, mode, wantError string }{
		{"default HTTP", "", "http", ""},
		{"explicit HTTP", `[tls]
mode = "http"`, "http", ""},
		{"legacy cert", `[tls]
cert_file = "/cert.pem"
key_file = "/key.pem"`, "certificate", ""},
		{"ACME", `[tls]
mode = "acme"
acme_domain = "Panel.Example.com."`, "acme", ""},
		{"legacy ACME", `[tls]
acme_domain = "panel.example.com"`, "acme", ""},
		{"missing key", `[tls]
cert_file = "/cert.pem"`, "", "both"},
		{"mixed", `[tls]
cert_file = "/cert.pem"
key_file = "/key.pem"
acme_domain = "panel.example.com"`, "", "exclusive"},
		{"no silent downgrade", `[tls]
mode = "http"
acme_domain = "panel.example.com"`, "", "explicitly disable"},
		{"unknown", `[tls]
mode = "auto"`, "", "unknown"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := load(t, minimal+"\n"+tt.body)
			if tt.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantError) {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.TLS.Mode != tt.mode {
				t.Fatalf("mode = %s", cfg.TLS.Mode)
			}
			if tt.mode == "acme" && (cfg.TLS.AcmeDomain != "panel.example.com" || cfg.TLS.AcmeCacheDir != "/var/lib/telemt-panel/certs") {
				t.Fatalf("ACME normalization = %+v", cfg.TLS)
			}
		})
	}
}

func TestACMEValidation(t *testing.T) {
	for _, domain := range []string{"", "localhost", "127.0.0.1", "::1", "*.example.com", "https://example.com", "example.com:443", "a..com", "-a.com", "a-.com", " a.com", "a.com/path"} {
		c := TLSConfig{Mode: "acme", AcmeDomain: domain}
		if c.Normalize(":8443", "/data") == nil {
			t.Errorf("accepted domain %q", domain)
		}
	}
	for _, listen := range []string{":80", ":0", ":65536", "8443", ":https"} {
		c := TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com"}
		if c.Normalize(listen, "/data") == nil {
			t.Errorf("accepted listen %q", listen)
		}
	}
	c := TLSConfig{Mode: "acme", AcmeDomain: "panel.example.com"}
	if c.Normalize(":8443", "") == nil {
		t.Fatal("accepted process-local cache")
	}
	c.AcmeCacheDir = "/persistent/certs"
	if err := c.Normalize(":8443", ""); err != nil {
		t.Fatal(err)
	}
}
