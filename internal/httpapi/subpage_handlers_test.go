package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

const testUserSecret = "0123456789abcdef0123456789abcdef"

func fixtureUsers() []telemt.UserInfo {
	return []telemt.UserInfo{
		{
			Username: "alice",
			Enabled:  true,
			Links: telemt.UserLinks{
				Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=" + testUserSecret},
			},
		},
	}
}

// newSubpageTestServer builds a logged-in Server with the subpage module
// enabled and one fixture user ("alice") served by a fake Telemt.
func newSubpageTestServer(t *testing.T, enabled bool) (*Server, *http.Cookie) {
	t.Helper()
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{
		Auth:    config.AuthConfig{Username: "admin", PasswordHash: hash},
		Subpage: config.SubpageConfig{Enabled: enabled, Secret: "panel-secret"},
	}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	tc := newFakeTelemtHTTP(t, fixtureUsers())
	hb := hub.New(hub.Config{}, tc, st)
	t.Cleanup(hb.Close)

	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}
	return srv, cookie
}

func getSublink(t *testing.T, h http.Handler, cookie *http.Cookie) sublinkResponse {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/users/alice/sublink", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("get sublink status = %d, body = %s", w.Code, w.Body)
	}
	var out sublinkResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode sublink response: %v", err)
	}
	return out
}

// pathOf strips scheme+host from an absolute URL, returning the
// request-target path+query to hit against the test handler directly.
func pathOf(t *testing.T, absoluteURL string) string {
	t.Helper()
	u, err := url.Parse(absoluteURL)
	if err != nil {
		t.Fatalf("parse url %q: %v", absoluteURL, err)
	}
	return u.RequestURI()
}

func TestHandleGetSublinkRequiresSession(t *testing.T) {
	srv, _ := newSubpageTestServer(t, true)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/users/alice/sublink", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestHandleGetSublinkReturnsAbsoluteURL(t *testing.T) {
	srv, cookie := newSubpageTestServer(t, true)
	h := srv.Handler()

	link := getSublink(t, h, cookie)
	if !link.Enabled {
		t.Error("expected enabled=true when subpage.enabled is true")
	}
	if !strings.HasPrefix(link.URL, "http://") || !strings.Contains(link.URL, "/sub/") {
		t.Fatalf("url = %q, want an absolute http://.../sub/<token> URL", link.URL)
	}
}

func TestHandleGetSublinkUnknownUser(t *testing.T) {
	srv, cookie := newSubpageTestServer(t, true)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/users/nobody/sublink", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestHandleSubpageServesPageForValidToken(t *testing.T) {
	srv, cookie := newSubpageTestServer(t, true)
	h := srv.Handler()

	link := getSublink(t, h, cookie)

	r := httptest.NewRequest("GET", pathOf(t, link.URL), nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	if got := w.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy = %q, want no-referrer", got)
	}
	if got := w.Header().Get("X-Robots-Tag"); got != "noindex" {
		t.Errorf("X-Robots-Tag = %q, want noindex", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("Cache-Control = %q, want private, no-store", got)
	}
	if !strings.Contains(w.Body.String(), "alice") {
		t.Error("expected the page to mention the username")
	}
	if !strings.Contains(w.Body.String(), testUserSecret) {
		t.Error("expected the page to contain the raw secret field")
	}
}

func TestHandleSubpageUnknownTokenIsUniform404(t *testing.T) {
	srv, _ := newSubpageTestServer(t, true)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/sub/does-not-exist", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain", ct)
	}
	if body := strings.TrimSpace(w.Body.String()); body != "not found" {
		t.Errorf("body = %q, want %q", body, "not found")
	}
	if loc := w.Header().Get("Location"); loc != "" {
		t.Errorf("unexpected redirect to %q", loc)
	}
}

// TestHandleSubpageRouteNotRegisteredWhenDisabled: with subpage disabled,
// /sub/{token} is not registered on the mux at all, so it must never reach
// handleSubpage — just ServeMux's own plain-text 404. spaRouter (fix round
// 1, finding 4) routes every /sub/* request straight to mux unconditionally,
// never to webUI, so this holds deterministically regardless of whether
// srv.webUI is set or nil (whether a frontend happens to be built in this
// workspace) — unlike an unmatched non-API path outside /sub/*, which
// internal/webui would answer with the SPA's index.html (exercised
// separately by webui_handler_test.go, via a fake webUI so that outcome
// doesn't depend on `make web` having run either).
func TestHandleSubpageRouteNotRegisteredWhenDisabled(t *testing.T) {
	srv, _ := newSubpageTestServer(t, false)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/sub/anything", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestSublinkRotateInvalidatesOldToken(t *testing.T) {
	srv, cookie := newSubpageTestServer(t, true)
	h := srv.Handler()

	before := getSublink(t, h, cookie)

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("POST", "/api/users/alice/sublink", cookie))
	if w.Code != http.StatusOK {
		t.Fatalf("rotate status = %d, body = %s", w.Code, w.Body)
	}
	var after sublinkResponse
	if err := json.Unmarshal(w.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode rotate response: %v", err)
	}
	if after.URL == before.URL {
		t.Fatal("expected the URL to change after rotation")
	}

	// The old token now 404s.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", pathOf(t, before.URL), nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("old token status = %d, want 404", w.Code)
	}

	// The new token works immediately (no waiting for the lazy refresh
	// window), and the audit log recorded the rotation.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", pathOf(t, after.URL), nil))
	if w.Code != http.StatusOK {
		t.Fatalf("new token status = %d, want 200", w.Code)
	}

	entries, err := srv.st.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(entries) != 1 || entries[0].Action != "sublink.rotate" || entries[0].Subject != "alice" {
		t.Fatalf("audit entries = %+v, want one sublink.rotate for alice", entries)
	}
}

// TestHandleSubpageUsesQuotaEntryUsedBytesOverLifetimeTotal covers finding
// 4: handleSubpage must feed the /sub/{token} page a QuotaList entry (same
// graceful-degradation helper the /api/users handlers use) rather than
// letting the page fall back to UserInfo's lifetime TotalOctets alone —
// otherwise a user reset via POST reset-quota shows "quota exhausted"
// forever, since TotalOctets never resets.
func TestHandleSubpageUsesQuotaEntryUsedBytesOverLifetimeTotal(t *testing.T) {
	u := aliceFixture()
	dataQuota := uint64(10 << 30)
	u.DataQuotaBytes = &dataQuota
	u.TotalOctets = dataQuota // lifetime counter alone would read "exhausted"

	fake := newFakeTelemt(u)
	fake.hasQuota = true
	fake.quota = map[string]telemt.QuotaEntry{
		"alice": {DataQuotaBytes: dataQuota, UsedBytes: 1 << 30, LastResetEpochSecs: 1700000000},
	}
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	link := getSublink(t, h, cookie)
	r := httptest.NewRequest("GET", pathOf(t, link.URL), nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	body := w.Body.String()
	if strings.Contains(body, `class="status status-quota_exhausted"`) {
		t.Error("expected the reset-aware used_bytes, not lifetime TotalOctets, to decide the status")
	}
	if !strings.Contains(body, "1.0 GiB") {
		t.Errorf("expected the quota entry's used_bytes rendered as 1.0 GiB; body:\n%s", body)
	}
}

// TestHandleSubpageWithoutQuotaCapabilityFallsBackToTotalOctets covers the
// degraded path: an older Telemt build with no quota-list capability must
// still render the page from UserInfo's TotalOctets, unchanged from
// before this fix.
func TestHandleSubpageWithoutQuotaCapabilityFallsBackToTotalOctets(t *testing.T) {
	u := aliceFixture()
	dataQuota := uint64(10 << 30)
	u.DataQuotaBytes = &dataQuota
	u.TotalOctets = 2 << 30

	fake := newFakeTelemt(u)
	fake.hasQuota = false
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	link := getSublink(t, h, cookie)
	r := httptest.NewRequest("GET", pathOf(t, link.URL), nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if body := w.Body.String(); !strings.Contains(body, "2.0 GiB") {
		t.Errorf("expected the TotalOctets fallback rendered as 2.0 GiB; body:\n%s", body)
	}
}

// TestHandleSubpageRenderFailureReturns500 covers the other half of
// finding 4: handleSubpage renders into a buffer before writing any
// status line, so a render failure (here, a link whose secret is too long
// for the QR encoder) surfaces as a real 500 instead of the previous
// behavior of a 200 with a truncated or empty body.
func TestHandleSubpageRenderFailureReturns500(t *testing.T) {
	// The token/sublink URL is derived from the Classic link's secret
	// (subpage.ExtractSecret, which validates that it's exactly 32 hex
	// chars), so that one stays well-formed; a second, TLS link carries a
	// secret far too long for the QR encoder to force RenderPage to fail
	// once the page actually renders.
	hugeSecret := strings.Repeat("a", 4000)
	u := telemt.UserInfo{
		Username: "alice",
		Enabled:  true,
		Links: telemt.UserLinks{
			Classic: []string{"tg://proxy?server=1.2.3.4&port=443&secret=" + testUserSecret},
			TLS:     []string{"tg://proxy?server=1.2.3.4&port=443&secret=" + hugeSecret},
		},
	}
	fake := newFakeTelemt(u)
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	link := getSublink(t, h, cookie)
	r := httptest.NewRequest("GET", pathOf(t, link.URL), nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type = %q, want text/plain", ct)
	}
	if body := strings.TrimSpace(w.Body.String()); body != "internal error" {
		t.Errorf("body = %q, want %q", body, "internal error")
	}
}

// getSubpage issues GET /sub/{token} (path from an absolute sublink URL)
// against h and returns the response.
func getSubpage(t *testing.T, h http.Handler, absoluteURL string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", pathOf(t, absoluteURL), nil))
	return w
}

// TestHandleSubpageSecretRotationInvalidatesOldTokenViaVerifyOnHit covers
// P1.3: a rotate-secret call whose own best-effort index refresh FAILS
// must still make the old token 404 immediately, because handleSubpage
// re-verifies every cache hit against the user's current secret and nonce
// rather than trusting the (possibly stale) index — the fix does not
// depend on the refresh succeeding.
func TestHandleSubpageSecretRotationInvalidatesOldTokenViaVerifyOnHit(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	before := getSublink(t, h, cookie)
	// Prime the index with a cache hit for the old token.
	if w := getSubpage(t, h, before.URL); w.Code != http.StatusOK {
		t.Fatalf("priming request status = %d, want 200: %s", w.Code, w.Body)
	}

	// Arm the index's own Refresh() to fail on its next Users() call —
	// the one rotate-secret's hook is about to make — while everything
	// else (the rotate-secret call itself, handleSubpage's own fetch of
	// the fresh user afterward) keeps working.
	fake.failUsersOnNthCall(1)

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("POST", "/api/users/alice/rotate-secret", cookie))
	if w.Code != http.StatusOK {
		t.Fatalf("rotate-secret status = %d, want 200: %s", w.Code, w.Body)
	}

	// The old token must 404 immediately — a genuine cache hit that
	// verify-on-hit catches, not a miss left by a successful refresh.
	w = getSubpage(t, h, before.URL)
	if w.Code != http.StatusNotFound {
		t.Fatalf("old token status = %d, want 404: %s", w.Code, w.Body)
	}
	if body := strings.TrimSpace(w.Body.String()); body != "not found" {
		t.Errorf("body = %q, want %q", body, "not found")
	}

	// Simulate the eventual catch-up (the next lazy refresh, or another
	// admin action) so the new token is reachable too.
	if err := srv.subIndex.Refresh(context.Background()); err != nil {
		t.Fatalf("catch-up Refresh: %v", err)
	}
	after := getSublink(t, h, cookie)
	if after.URL == before.URL {
		t.Fatal("expected the sublink URL to change after secret rotation")
	}
	if w := getSubpage(t, h, after.URL); w.Code != http.StatusOK {
		t.Fatalf("new token status = %d, want 200: %s", w.Code, w.Body)
	}
}

// TestHandlePatchUserSecretInvalidatesOldTokenViaVerifyOnHit is the same
// scenario as TestHandleSubpageSecretRotationInvalidatesOldTokenViaVerifyOnHit
// but for PATCH /api/users/{username} with a "secret" field — the brief's
// second refresh-hook trigger.
func TestHandlePatchUserSecretInvalidatesOldTokenViaVerifyOnHit(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	before := getSublink(t, h, cookie)
	if w := getSubpage(t, h, before.URL); w.Code != http.StatusOK {
		t.Fatalf("priming request status = %d, want 200: %s", w.Code, w.Body)
	}

	fake.failUsersOnNthCall(1)

	const newSecret = "99999999999999999999999999999999"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutatingJSON(t, "PATCH", "/api/users/alice", cookie, map[string]any{"secret": newSecret}))
	if w.Code != http.StatusOK {
		t.Fatalf("patch status = %d, want 200: %s", w.Code, w.Body)
	}

	w = getSubpage(t, h, before.URL)
	if w.Code != http.StatusNotFound {
		t.Fatalf("old token status = %d, want 404: %s", w.Code, w.Body)
	}
	if body := strings.TrimSpace(w.Body.String()); body != "not found" {
		t.Errorf("body = %q, want %q", body, "not found")
	}

	if err := srv.subIndex.Refresh(context.Background()); err != nil {
		t.Fatalf("catch-up Refresh: %v", err)
	}
	after := getSublink(t, h, cookie)
	if after.URL == before.URL {
		t.Fatal("expected the sublink URL to change after a secret patch")
	}
	if w := getSubpage(t, h, after.URL); w.Code != http.StatusOK {
		t.Fatalf("new token status = %d, want 200: %s", w.Code, w.Body)
	}
}

// TestHandleSubpageNonceRotationFailingRefreshStillInvalidatesOldToken is
// the audit's original scenario: sublink rotation's own best-effort
// Refresh (the pre-existing "force an immediate index rebuild" call) can
// fail, and before this fix the old token would then keep resolving.
// verify-on-hit must catch it regardless.
func TestHandleSubpageNonceRotationFailingRefreshStillInvalidatesOldToken(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	before := getSublink(t, h, cookie)
	if w := getSubpage(t, h, before.URL); w.Code != http.StatusOK {
		t.Fatalf("priming request status = %d, want 200: %s", w.Code, w.Body)
	}

	// writeSublink makes two GET /v1/users calls when rotating: one to find
	// the user/secret, then the refresh hook's own Refresh() call — fail
	// the second (the refresh), not the first.
	fake.failUsersOnNthCall(2)

	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("POST", "/api/users/alice/sublink", cookie))
	if w.Code != http.StatusOK {
		t.Fatalf("rotate sublink status = %d, want 200: %s", w.Code, w.Body)
	}
	var after sublinkResponse
	if err := json.Unmarshal(w.Body.Bytes(), &after); err != nil {
		t.Fatalf("decode rotate response: %v", err)
	}

	w = getSubpage(t, h, before.URL)
	if w.Code != http.StatusNotFound {
		t.Fatalf("old token status = %d, want 404: %s", w.Code, w.Body)
	}
	if body := strings.TrimSpace(w.Body.String()); body != "not found" {
		t.Errorf("body = %q, want %q", body, "not found")
	}

	if err := srv.subIndex.Refresh(context.Background()); err != nil {
		t.Fatalf("catch-up Refresh: %v", err)
	}
	if w := getSubpage(t, h, after.URL); w.Code != http.StatusOK {
		t.Fatalf("new token status = %d, want 200: %s", w.Code, w.Body)
	}
}

// TestHandleSubpageStaleTokenUniform404MatchesUnknownToken is the
// byte-level assertion the brief requires: verify-on-hit's 404 must be
// indistinguishable from an unknown token's — same status, same headers,
// same body — so a caller can never learn a token used to be valid.
func TestHandleSubpageStaleTokenUniform404MatchesUnknownToken(t *testing.T) {
	fake := newFakeTelemt(aliceFixture())
	srv, cookie := newUsersTestServer(t, fake, true)
	h := srv.Handler()

	before := getSublink(t, h, cookie)
	if w := getSubpage(t, h, before.URL); w.Code != http.StatusOK {
		t.Fatalf("priming request status = %d, want 200: %s", w.Code, w.Body)
	}
	fake.failUsersOnNthCall(1)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, mutating("POST", "/api/users/alice/rotate-secret", cookie))
	if w.Code != http.StatusOK {
		t.Fatalf("rotate-secret status = %d, want 200: %s", w.Code, w.Body)
	}

	stale := getSubpage(t, h, before.URL)
	unknown := getSubpage(t, h, "http://example.invalid/sub/does-not-exist")

	if stale.Code != unknown.Code {
		t.Fatalf("status: stale=%d unknown=%d", stale.Code, unknown.Code)
	}
	if stale.Body.String() != unknown.Body.String() {
		t.Fatalf("body: stale=%q unknown=%q", stale.Body.String(), unknown.Body.String())
	}
	if !reflect.DeepEqual(stale.Header(), unknown.Header()) {
		t.Fatalf("headers: stale=%v unknown=%v", stale.Header(), unknown.Header())
	}
}

func TestSubpageRateLimited(t *testing.T) {
	srv, _ := newSubpageTestServer(t, true)
	h := srv.Handler()

	for i := 0; i < 30; i++ {
		r := httptest.NewRequest("GET", "/sub/some-token", nil)
		r.RemoteAddr = "203.0.113.7:1234"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d rate limited early", i)
		}
	}

	r := httptest.NewRequest("GET", "/sub/some-token", nil)
	r.RemoteAddr = "203.0.113.7:1234"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if body := strings.TrimSpace(w.Body.String()); body != "too many requests" {
		t.Errorf("body = %q, want %q", body, "too many requests")
	}

	// A different client IP is unaffected.
	r = httptest.NewRequest("GET", "/sub/some-token", nil)
	r.RemoteAddr = "198.51.100.9:1234"
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code == http.StatusTooManyRequests {
		t.Fatal("a different client IP was rate limited by another IP's usage")
	}
}
