package auth

import (
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
)

func testConfig(basePath string, ttl time.Duration, trusted ...netip.Prefix) *config.Config {
	return &config.Config{
		BasePath:             basePath,
		TrustedProxyPrefixes: trusted,
		Auth: config.AuthConfig{
			Username:     "admin",
			PasswordHash: "$2a$10$abcdefghijklmnopqrstuv", // unused by session tests
			SessionTTL:   ttl.String(),
		},
	}
}

func TestNewTokenIsUniqueAndOpaque(t *testing.T) {
	a, err := NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	b, err := NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	if a == b {
		t.Fatal("NewToken produced identical tokens")
	}
	if len(a) < 32 {
		t.Fatalf("token looks too short for 32 bytes of entropy: %q", a)
	}
}

func TestHashTokenDeterministic(t *testing.T) {
	tok, err := NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	h1, h2 := HashToken(tok), HashToken(tok)
	if h1 != h2 {
		t.Fatalf("HashToken not deterministic: %q != %q", h1, h2)
	}
	if h1 == tok {
		t.Fatal("HashToken returned the token unchanged")
	}
	if len(h1) != 64 { // hex SHA-256
		t.Fatalf("HashToken length = %d, want 64", len(h1))
	}
}

func TestCookiePath(t *testing.T) {
	tests := []struct {
		basePath string
		want     string
	}{
		{"", "/"},
		{"/panel", "/panel/"},
	}
	for _, tt := range tests {
		if got := cookiePath(tt.basePath); got != tt.want {
			t.Errorf("cookiePath(%q) = %q, want %q", tt.basePath, got, tt.want)
		}
	}
}

func TestSetSessionCookie(t *testing.T) {
	cfg := testConfig("/panel", time.Hour)
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	w := httptest.NewRecorder()

	SetSessionCookie(w, r, cfg, "tok-123")

	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("got %d cookies, want 1", len(cookies))
	}
	c := cookies[0]
	if c.Name != CookieName {
		t.Errorf("Name = %q, want %q", c.Name, CookieName)
	}
	if c.Value != "tok-123" {
		t.Errorf("Value = %q, want tok-123", c.Value)
	}
	if c.Path != "/panel/" {
		t.Errorf("Path = %q, want /panel/", c.Path)
	}
	if !c.HttpOnly {
		t.Error("HttpOnly = false, want true")
	}
	if raw := w.Header().Get("Set-Cookie"); !strings.Contains(raw, "SameSite=Strict") {
		t.Errorf("Set-Cookie = %q, want SameSite=Strict", raw)
	}
	if c.MaxAge != 3600 {
		t.Errorf("MaxAge = %d, want 3600", c.MaxAge)
	}
	if c.Secure {
		t.Error("Secure = true for a plain HTTP request behind no trusted proxy")
	}
}

func TestSetSessionCookieSecure(t *testing.T) {
	trusted := netip.MustParsePrefix("127.0.0.1/32")
	cfg := testConfig("", time.Hour, trusted)
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.RemoteAddr = "127.0.0.1:5555"
	r.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()

	SetSessionCookie(w, r, cfg, "tok-123")

	if !w.Result().Cookies()[0].Secure {
		t.Error("Secure = false, want true behind a trusted TLS-terminating proxy")
	}
}

func TestClearSessionCookieExpires(t *testing.T) {
	cfg := testConfig("", time.Hour)
	r := httptest.NewRequest("POST", "/api/auth/logout", nil)
	w := httptest.NewRecorder()

	ClearSessionCookie(w, r, cfg)

	c := w.Result().Cookies()[0]
	if c.MaxAge >= 0 {
		t.Errorf("MaxAge = %d, want negative (expire now)", c.MaxAge)
	}
	if c.Value != "" {
		t.Errorf("Value = %q, want empty", c.Value)
	}
}
