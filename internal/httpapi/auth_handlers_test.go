package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

const testPassword = "s3cr3t-password"

// newTestServer builds a Server backed by a fresh in-memory store and an
// unreachable Telemt client (fine — none of these tests exercise the
// Telemt proxy path itself). The caller must stop the rate limiter.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{
		Auth: config.AuthConfig{
			Username:     "admin",
			PasswordHash: hash,
		},
	}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	tc := telemt.New("http://127.0.0.1:1", "")
	hb := hub.New(hub.Config{}, tc)
	t.Cleanup(hb.Close)
	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)
	return srv
}

func loginRequestJSON(t *testing.T, username, password string) *bytes.Reader {
	t.Helper()
	body, err := json.Marshal(loginRequest{Username: username, Password: password})
	if err != nil {
		t.Fatalf("marshal login request: %v", err)
	}
	return bytes.NewReader(body)
}

// login performs a login request and returns the response and, on success,
// the session cookie.
func login(t *testing.T, h http.Handler, username, password string) (*httptest.ResponseRecorder, *http.Cookie) {
	t.Helper()
	r := httptest.NewRequest("POST", "/api/auth/login", loginRequestJSON(t, username, password))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	for _, c := range w.Result().Cookies() {
		if c.Name == auth.CookieName {
			return w, c
		}
	}
	return w, nil
}

// mutating builds a request that passes the CSRF middleware as a
// same-origin browser request would.
func mutating(method, target string, cookie *http.Cookie) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	return r
}

func TestLoginMeLogoutFlow(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w, cookie := login(t, h, "admin", testPassword)
	if w.Code != http.StatusNoContent {
		t.Fatalf("login status = %d, want 204", w.Code)
	}
	if cookie == nil {
		t.Fatal("login did not set the session cookie")
	}

	// GET /api/auth/me with the session.
	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("me status = %d, want 200", w.Code)
	}
	var me meResponse
	if err := json.Unmarshal(w.Body.Bytes(), &me); err != nil {
		t.Fatalf("decode me response: %v", err)
	}
	if me.Username != "admin" || me.TOTPEnabled || me.Passkeys == nil || len(me.Passkeys) != 0 {
		t.Fatalf("me response = %+v, want {admin false []}", me)
	}

	// Logout.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, mutating("POST", "/api/auth/logout", cookie))
	if w.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, want 204", w.Code)
	}
	cleared := false
	for _, c := range w.Result().Cookies() {
		if c.Name == auth.CookieName && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("logout did not clear the session cookie")
	}

	// The session is gone server-side, not just cookie-cleared client-side.
	r = httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("me after logout status = %d, want 401", w.Code)
	}
}

func TestLoginWrongPassword(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	w, cookie := login(t, h, "admin", "wrong-password")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if cookie != nil {
		t.Fatal("wrong password must not set a session cookie")
	}

	var body struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body.Code != "invalid_credentials" {
		t.Fatalf("error code = %q, want invalid_credentials", body.Code)
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "login.failed" || entries[0].Subject != "admin" {
		t.Fatalf("audit entries = %+v, want one login.failed for admin", entries)
	}
}

func TestLoginWrongUsername(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	// A username that doesn't exist must still be rejected as
	// invalid_credentials (never a different code, and never a different
	// code path that could reveal it via timing — see auth.VerifyCredentials).
	w, cookie := login(t, h, "nobody", testPassword)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if cookie != nil {
		t.Fatal("wrong username must not set a session cookie")
	}

	var body struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body.Code != "invalid_credentials" {
		t.Fatalf("error code = %q, want invalid_credentials", body.Code)
	}
}

// TestLoginUsernameTooLongRejected covers P3.10: a username over
// loginUsernameMaxBytes is rejected as 400 bad_request before the bcrypt
// path, and the audit Subject it records is truncated rather than storing
// the full oversized value.
func TestLoginUsernameTooLongRejected(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	longUsername := strings.Repeat("a", loginUsernameMaxBytes+50)
	w, cookie := login(t, h, longUsername, testPassword)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	if cookie != nil {
		t.Fatal("oversized username must not set a session cookie")
	}

	var body struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body.Code != "bad_request" {
		t.Fatalf("error code = %q, want bad_request", body.Code)
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "login.failed" {
		t.Fatalf("audit entries = %+v, want one login.failed", entries)
	}
	if len(entries[0].Subject) != loginUsernameMaxBytes {
		t.Errorf("audit Subject len = %d, want truncated to %d", len(entries[0].Subject), loginUsernameMaxBytes)
	}
	if entries[0].Subject != longUsername[:loginUsernameMaxBytes] {
		t.Error("audit Subject is not the expected truncated prefix of the oversized username")
	}
}

// TestLoginUsernameTooLongCountsTowardRateLimit covers the "still counted
// by the rate limiter" half of P3.10: an oversized-username attempt must
// consume a failure slot just like a wrong-password attempt, so an
// attacker can't use oversized usernames to bypass the login rate limit.
func TestLoginUsernameTooLongCountsTowardRateLimit(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	longUsername := strings.Repeat("a", loginUsernameMaxBytes+1)
	for i := 0; i < 5; i++ {
		w, _ := login(t, h, longUsername, testPassword)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d: status = %d, want 400", i, w.Code)
		}
	}

	// 6th attempt, even with valid credentials, is rate limited — proving
	// the five oversized-username rejections above each counted as a
	// failure.
	w, cookie := login(t, h, "admin", testPassword)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if cookie != nil {
		t.Fatal("rate-limited login must not set a session cookie")
	}
}

func TestLoginRateLimited(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	for i := 0; i < 5; i++ {
		w, _ := login(t, h, "admin", "wrong-password")
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401", i, w.Code)
		}
	}

	// 6th attempt is rate limited even with the correct password: the
	// limiter gates on IP before credentials are checked.
	w, cookie := login(t, h, "admin", testPassword)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if cookie != nil {
		t.Fatal("rate-limited login must not set a session cookie")
	}
}

func TestTelemtInfoRequiresSession(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/telemt/info", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestHealthStaysOpen(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/health", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

func listSessions(t *testing.T, h http.Handler, cookie *http.Cookie) []sessionInfo {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/auth/sessions", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("list sessions status = %d, want 200", w.Code)
	}
	var out []sessionInfo
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode sessions: %v", err)
	}
	return out
}

func TestSessionsListAndRevocation(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	_, cookieA := login(t, h, "admin", testPassword)
	_, cookieB := login(t, h, "admin", testPassword)
	_, cookieC := login(t, h, "admin", testPassword)
	if cookieA == nil || cookieB == nil || cookieC == nil {
		t.Fatal("expected three successful logins")
	}

	sessions := listSessions(t, h, cookieA)
	if len(sessions) != 3 {
		t.Fatalf("len(sessions) = %d, want 3", len(sessions))
	}
	var current, other string
	for _, s := range sessions {
		if s.Current {
			current = s.ID
		} else if s.ID != auth.HashToken(cookieC.Value) {
			other = s.ID
		}
	}
	if current != auth.HashToken(cookieA.Value) {
		t.Fatalf("current session id = %q, want %q", current, auth.HashToken(cookieA.Value))
	}
	if other == "" {
		t.Fatal("expected to find session B's id in the list")
	}

	// Revoke session B by id.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("DELETE", "/api/auth/sessions/"+other, cookieA))
	if w.Code != http.StatusNoContent {
		t.Fatalf("revoke session status = %d, want 204", w.Code)
	}
	if _, ok, _ := srv.st.GetSession(other); ok {
		t.Error("revoked session still present in the store")
	}

	// Revoking an unknown session id is a 404.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, mutating("DELETE", "/api/auth/sessions/does-not-exist", cookieA))
	if w.Code != http.StatusNotFound {
		t.Fatalf("revoke unknown session status = %d, want 404", w.Code)
	}

	// Revoke all others (session C) via DELETE /api/auth/sessions.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, mutating("DELETE", "/api/auth/sessions", cookieA))
	if w.Code != http.StatusNoContent {
		t.Fatalf("revoke others status = %d, want 204", w.Code)
	}

	sessions = listSessions(t, h, cookieA)
	if len(sessions) != 1 || !sessions[0].Current {
		t.Fatalf("sessions after revoke-others = %+v, want just the current session", sessions)
	}
}

// TestSessionsListFiltersAndDeletesExpiredSessions covers P2.6a: a session
// whose LastSeen has aged past the TTL must not appear in the devices list,
// and must be removed from the store as a side effect of listing — the
// same lazy-delete-on-expiry behavior RequireSession applies on use.
func TestSessionsListFiltersAndDeletesExpiredSessions(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	srv.cfg.Auth.SessionTTL = "1h"

	_, current := login(t, h, "admin", testPassword)
	if current == nil {
		t.Fatal("expected a successful login")
	}

	expiredIDHash := auth.HashToken("expired-token")
	longAgo := time.Now().Add(-2 * time.Hour)
	if err := srv.st.PutSession(store.Session{IDHash: expiredIDHash, Created: longAgo, LastSeen: longAgo}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	sessions := listSessions(t, h, current)
	if len(sessions) != 1 || !sessions[0].Current {
		t.Fatalf("sessions = %+v, want just the current one (expired session filtered out)", sessions)
	}
	if _, ok, _ := srv.st.GetSession(expiredIDHash); ok {
		t.Error("expired session should have been lazily deleted from the store by the list call")
	}
}

func TestCSRFAppliesToMutatingAuthRoutes(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}

	r := httptest.NewRequest("POST", "/api/auth/logout", nil)
	r.AddCookie(cookie)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-site logout status = %d, want 403", w.Code)
	}

	var body struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body.Code != "csrf_rejected" {
		t.Fatalf("error code = %q, want csrf_rejected", body.Code)
	}
}
