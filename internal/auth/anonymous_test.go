package auth

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
)

func TestAnonymousHostBoundary(t *testing.T) {
	for _, tc := range []struct {
		host, public, forwarded string
		trusted, allowed        bool
	}{
		{"127.0.0.1:3000", "", "", false, true},
		{"192.168.1.2:3000", "", "", false, true},
		{"[::1]:3000", "", "", false, true},
		{"localhost:3000", "", "", false, true},
		{"attacker.example:3000", "", "", false, false},
		{"panel.example", "https://panel.example/path", "", false, true},
		{"panel.example:443", "https://panel.example", "", false, true},
		{"[2001:db8::1]:8080", "http://[2001:0db8:0:0:0:0:0:1]:8080", "", false, true},
		{"[2001:0db8:0:0:0:0:0:1]:8080", "http://[2001:db8::1]:8080", "", false, true},
		{"panel.example:8080", "http://panel.example:08080", "", false, true},
		{"panel.example", "https://panel.example:00443", "", false, true},
		{"[2001:db8::2]:8080", "http://[2001:0db8:0:0:0:0:0:1]:8080", "", false, false},
		{"panel.example:3000", "https://panel.example", "", false, false},
		{"attacker.example", "https://panel.example", "", false, false},
		{"127.0.0.1:3000", "https://panel.example", "panel.example", true, true},
		{"127.0.0.1:3000", "https://panel.example", "panel.example", false, false},
		{"panel.example", "https://panel.example", "attacker.example", true, false},
		{"127.0.0.1@attacker.example", "", "", false, false},
	} {
		t.Run(tc.host+"/"+tc.forwarded, func(t *testing.T) {
			cfg := &config.Config{PublicURL: tc.public, Auth: config.AuthConfig{Disabled: true}}
			if tc.trusted {
				cfg.TrustedProxyPrefixes = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
			}
			r := httptest.NewRequest("GET", "http://localhost/", nil)
			r.Host = tc.host
			r.RemoteAddr = "127.0.0.1:5000"
			r.Header.Set("X-Forwarded-Host", tc.forwarded)
			w := httptest.NewRecorder()
			RequireSession(nil, cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				name, _ := UsernameFromContext(r.Context())
				if name != "anonymous" {
					t.Fatal(name)
				}
				if _, ok := SessionIDHashFromContext(r.Context()); ok {
					t.Fatal("fabricated session")
				}
				w.WriteHeader(204)
			})).ServeHTTP(w, r)
			if (w.Code == 204) != tc.allowed {
				t.Fatalf("status %d allowed %t", w.Code, tc.allowed)
			}
			if len(w.Result().Cookies()) != 0 {
				t.Fatal("anonymous access must not issue cookies")
			}
		})
	}
}

func TestAnonymousCSRFBoundary(t *testing.T) {
	cfg := &config.Config{Auth: config.AuthConfig{Disabled: true}}
	for _, tc := range []struct {
		site, origin string
		allowed      bool
	}{
		{"same-origin", "http://localhost:3000", true},
		{"", "http://localhost:3000", true},
		{"", "https://localhost:3000", false},
		{"", "http://attacker.example", false},
		{"cross-site", "http://localhost:3000", false},
		{"same-site", "http://localhost:3000", false},
		{"", "", false},
	} {
		r := httptest.NewRequest("POST", "http://localhost:3000/api/users", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Sec-Fetch-Site", tc.site)
		w := httptest.NewRecorder()
		CSRF(cfg)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })).ServeHTTP(w, r)
		if (w.Code == 204) != tc.allowed {
			t.Errorf("%q %q status=%d", tc.site, tc.origin, w.Code)
		}
	}
}
