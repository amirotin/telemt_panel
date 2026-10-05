package auth

import (
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

// A real browser cookie jar drops an active session while requests keep the
// server session alive. No clock override or product changes are used.
func TestAuditActiveCookieSurvivesSlidingTTL(t *testing.T) {
	const ttl = 3 * time.Second
	cfg := testConfig("", ttl)
	st := newMemoryStore(t)
	defer st.Close()
	token := "audit-active-cookie"
	now := time.Now()
	if err := st.PutSession(store.Session{IDHash: HashToken(token), Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse("http://panel.test/api/auth/me")
	jar, _ := cookiejar.New(nil)
	login := httptest.NewRecorder()
	SetSessionCookie(login, httptest.NewRequest(http.MethodGet, u.String(), nil), cfg, token)
	jar.SetCookies(u, login.Result().Cookies())
	h := RequireSession(st, cfg)(okHandler())
	deadline := time.Now().Add(ttl + 200*time.Millisecond)
	requests, refreshes := 0, 0
	for time.Now().Before(deadline) {
		r := httptest.NewRequest(http.MethodGet, u.String(), nil)
		for _, cookie := range jar.Cookies(u) {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		requests++
		if w.Code != http.StatusOK {
			sess, exists, _ := st.GetSession(HashToken(token))
			t.Fatalf("active browser session expired: status=%d requests=%d cookie_refreshes=%d server_session_exists=%t last_seen_age=%s TTL=%s", w.Code, requests, refreshes, exists, time.Since(sess.LastSeen), ttl)
		}
		cookies := w.Result().Cookies()
		refreshes += len(cookies)
		jar.SetCookies(u, cookies)
		time.Sleep(time.Millisecond)
	}
}
