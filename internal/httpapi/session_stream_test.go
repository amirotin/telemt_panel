package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestSessionStreamRevokeBeforeInitialFrames(t *testing.T) {
	tc := newFakeTelemtHTTP(t, []telemt.UserInfo{{Username: "protected"}})
	srv, cookie := newSSETestServer(t, tc, hub.Config{})
	srv.sseAfterSubscribeHook = func() {
		if err := srv.sessions.Revoke(auth.HashToken(cookie.Value)); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/api/events?topics=users", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "event: users") {
		t.Fatalf("revoked registration response=%d %s", w.Code, w.Body)
	}
}

func TestQuietSessionStreamExpiresWithoutTouch(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "")
	srv, cookie := newSSETestServer(t, tc, hub.Config{Heartbeat: time.Hour})
	srv.cfg.Auth.SessionTTL = "100ms"
	panel := httptest.NewServer(srv.Handler())
	defer panel.Close()
	req, _ := http.NewRequest(http.MethodGet, panel.URL+"/api/events?topics=update", nil)
	req.AddCookie(cookie)
	response, err := panel.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d", response.StatusCode)
	}
	frames := readSSEFrames(response.Body)
	deadline := time.NewTimer(6 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case _, open := <-frames:
			if !open {
				return
			}
		case <-deadline.C:
			t.Fatal("quiet SSE continued beyond session expiry and idle check")
		}
	}
}
