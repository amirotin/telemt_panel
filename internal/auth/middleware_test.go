package auth

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func newMemoryStore(t *testing.T) store.Store {
	t.Helper()
	m, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	return m
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestRequireSessionNoCookie(t *testing.T) {
	cfg := testConfig("", time.Hour)
	st := newMemoryStore(t)

	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	w := httptest.NewRecorder()
	RequireSession(st, cfg)(okHandler()).ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestRequireSessionUnknownCookie(t *testing.T) {
	cfg := testConfig("", time.Hour)
	st := newMemoryStore(t)

	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "not-a-real-token"})
	w := httptest.NewRecorder()
	RequireSession(st, cfg)(okHandler()).ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestRequireSessionExpired(t *testing.T) {
	cfg := testConfig("", time.Hour)
	st := newMemoryStore(t)

	idHash := HashToken("some-token")
	longAgo := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := st.PutSession(store.Session{IDHash: idHash, Created: longAgo, LastSeen: longAgo}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "some-token"})
	w := httptest.NewRecorder()
	RequireSession(st, cfg)(okHandler()).ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if _, ok, _ := st.GetSession(idHash); ok {
		t.Error("expired session should be deleted lazily")
	}
}

func TestRequireSessionValidSlidesTTL(t *testing.T) {
	cfg := testConfig("", time.Hour)
	st := newMemoryStore(t)

	idHash := HashToken("some-token")
	past := time.Now().Add(-time.Minute)
	if err := st.PutSession(store.Session{IDHash: idHash, Created: past, LastSeen: past}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	var gotUsername, gotIDHash string
	var gotOK1, gotOK2 bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUsername, gotOK1 = UsernameFromContext(r.Context())
		gotIDHash, gotOK2 = SessionIDHashFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	})

	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "some-token"})
	w := httptest.NewRecorder()
	RequireSession(st, cfg)(handler).ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if !gotOK1 || gotUsername != "admin" {
		t.Errorf("username = %q, ok=%v, want admin, true", gotUsername, gotOK1)
	}
	if !gotOK2 || gotIDHash != idHash {
		t.Errorf("idHash = %q, ok=%v, want %q, true", gotIDHash, gotOK2, idHash)
	}

	sess, ok, _ := st.GetSession(idHash)
	if !ok {
		t.Fatal("session should still exist")
	}
	if !sess.LastSeen.After(past) {
		t.Error("LastSeen was not slid forward by RequireSession")
	}
}

func TestRequireSessionRefreshesCookieWhenStale(t *testing.T) {
	ttl := time.Hour
	cfg := testConfig("", ttl)
	st := newMemoryStore(t)

	idHash := HashToken("some-token")
	// Older than ttl/cookieRefreshFraction (1 minute) but well inside ttl,
	// so the session is valid but its cookie is due for a refresh.
	past := time.Now().Add(-2 * time.Minute)
	if err := st.PutSession(store.Session{IDHash: idHash, Created: past, LastSeen: past}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "some-token"})
	w := httptest.NewRecorder()
	RequireSession(st, cfg)(okHandler()).ServeHTTP(w, r)

	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != CookieName {
		t.Fatalf("Set-Cookie = %+v, want one panel_session cookie", cookies)
	}
	if cookies[0].Value != "some-token" {
		t.Errorf("refreshed cookie value = %q, want unchanged %q", cookies[0].Value, "some-token")
	}
	if cookies[0].MaxAge != int(ttl.Seconds()) {
		t.Errorf("refreshed cookie MaxAge = %d, want %d (the full TTL)", cookies[0].MaxAge, int(ttl.Seconds()))
	}
}

func TestRequireSessionDoesNotRefreshFreshCookie(t *testing.T) {
	cfg := testConfig("", time.Hour)
	st := newMemoryStore(t)

	idHash := HashToken("some-token")
	// Well under ttl/cookieRefreshFraction (1 minute) — no refresh needed.
	past := time.Now().Add(-10 * time.Second)
	if err := st.PutSession(store.Session{IDHash: idHash, Created: past, LastSeen: past}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(&http.Cookie{Name: CookieName, Value: "some-token"})
	w := httptest.NewRecorder()
	RequireSession(st, cfg)(okHandler()).ServeHTTP(w, r)

	if cookies := w.Result().Cookies(); len(cookies) != 0 {
		t.Errorf("Set-Cookie = %+v, want none (cookie is still fresh)", cookies)
	}
}

func TestCSRF(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	cfg := testConfig("", time.Hour, trusted...)

	tests := []struct {
		name          string
		method        string
		secFetchSite  string
		origin        string
		host          string
		remoteAddr    string
		forwardedHost string
		wantAllowed   bool
	}{
		{"GET always passes", "GET", "cross-site", "https://evil.example", "panel.example", "1.2.3.4:1", "", true},
		{"same-origin allowed", "POST", "same-origin", "", "panel.example", "1.2.3.4:1", "", true},
		{"none allowed (non-browser client)", "POST", "none", "", "panel.example", "1.2.3.4:1", "", true},
		{"cross-site no origin rejected", "POST", "cross-site", "", "panel.example", "1.2.3.4:1", "", false},
		{"cross-site matching origin allowed", "POST", "cross-site", "https://panel.example", "panel.example", "1.2.3.4:1", "", true},
		{"cross-site mismatched origin rejected", "POST", "cross-site", "https://evil.example", "panel.example", "1.2.3.4:1", "", false},
		{"no sec-fetch-site, matching origin allowed", "PUT", "", "https://panel.example", "panel.example", "1.2.3.4:1", "", true},
		{"no sec-fetch-site, no origin rejected", "DELETE", "", "", "panel.example", "1.2.3.4:1", "", false},
		{"trusted proxy forwarded host honored", "POST", "cross-site", "https://panel.example", "internal:8080", "10.0.0.1:1", "panel.example", true},
		{"untrusted peer forwarded host ignored", "POST", "cross-site", "https://panel.example", "internal:8080", "1.2.3.4:1", "panel.example", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(tt.method, "/api/users", nil)
			r.Host = tt.host
			r.RemoteAddr = tt.remoteAddr
			if tt.secFetchSite != "" {
				r.Header.Set("Sec-Fetch-Site", tt.secFetchSite)
			}
			if tt.origin != "" {
				r.Header.Set("Origin", tt.origin)
			}
			if tt.forwardedHost != "" {
				r.Header.Set("X-Forwarded-Host", tt.forwardedHost)
			}
			w := httptest.NewRecorder()
			CSRF(cfg)(okHandler()).ServeHTTP(w, r)

			gotAllowed := w.Code == http.StatusOK
			if gotAllowed != tt.wantAllowed {
				t.Errorf("allowed = %v (status %d), want %v", gotAllowed, w.Code, tt.wantAllowed)
			}
			if !gotAllowed && w.Code != http.StatusForbidden {
				t.Errorf("rejected status = %d, want 403", w.Code)
			}
		})
	}
}
