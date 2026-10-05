package auth

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestRequestHostValidationAndTrust(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	tests := []struct {
		name, host, peer string
		forwarded        []string
		want             string
	}{
		{"DNS case", "Panel.Example:8443", "10.0.0.1:1", nil, "panel.example:8443"},
		{"trusted", "internal:8080", "10.0.0.1:1", []string{"PUBLIC.example:443"}, "public.example:443"},
		{"untrusted", "internal:8080", "192.0.2.1:1", []string{"evil.example/path"}, "internal:8080"},
		{"IPv6", "[2001:DB8::1]:8443", "10.0.0.1:1", nil, "[2001:db8::1]:8443"},
		{"empty header", "valid.example", "10.0.0.1:1", []string{""}, ""},
		{"duplicates", "valid.example", "10.0.0.1:1", []string{"one.example", "one.example"}, ""},
		{"comma", "valid.example", "10.0.0.1:1", []string{"one.example,two.example"}, ""},
		{"userinfo", "admin@example.test", "10.0.0.1:1", nil, ""},
		{"scheme", "https://example.test", "10.0.0.1:1", nil, ""},
		{"path", "example.test/path", "10.0.0.1:1", nil, ""},
		{"query", "example.test?x=1", "10.0.0.1:1", nil, ""},
		{"fragment", "example.test#x", "10.0.0.1:1", nil, ""},
		{"newline", "example.test\r\nother.test", "10.0.0.1:1", nil, ""},
		{"empty", "", "10.0.0.1:1", nil, ""},
		{"invalid port", "example.test:65536", "10.0.0.1:1", nil, ""},
		{"invalid IPv6", "[not-ip]", "10.0.0.1:1", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.Host = tt.host
			r.RemoteAddr = tt.peer
			if tt.forwarded != nil {
				r.Header["X-Forwarded-Host"] = tt.forwarded
			}
			got, err := RequestHost(r, trusted)
			if tt.want == "" {
				if err == nil {
					t.Fatalf("host=%q accepted", got)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("host=%q err=%v, want%q", got, err, tt.want)
			}
		})
	}
}
