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

func TestAuditRevokedSessionStopsNewSSEData(t *testing.T) {
	fake, tc := newMutableFakeTelemtHTTP(t, []telemt.UserInfo{{Username: "before-revoke"}})
	srv, cookie := newSSETestServer(t, tc, hub.Config{UsersInterval: 20 * time.Millisecond, StatsInterval: time.Hour, Heartbeat: 20 * time.Millisecond})
	_, adminCookie := login(t, srv.Handler(), "admin", testPassword)
	if adminCookie == nil {
		t.Fatal("second admin login failed")
	}
	panel := httptest.NewServer(srv.Handler())
	defer panel.Close()
	req, _ := http.NewRequest(http.MethodGet, panel.URL+"/api/events?topics=users", nil)
	req.AddCookie(cookie)
	resp, err := panel.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("SSE status=%d", resp.StatusCode)
	}
	frames := readSSEFrames(resp.Body)
	for {
		frame := nextFrame(t, frames, time.Second)
		if frame.event == "users" {
			break
		}
	}
	revoke := httptest.NewRequest(http.MethodDelete, "/api/auth/sessions/"+auth.HashToken(cookie.Value), nil)
	revoke.AddCookie(adminCookie)
	revoke.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, revoke)
	if w.Code != http.StatusNoContent {
		t.Fatalf("revoke status=%d: %s", w.Code, w.Body.String())
	}
	check := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	check.AddCookie(cookie)
	w = httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, check)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked cookie still authenticates: %d", w.Code)
	}
	// This value did not exist while the session was valid.
	fake.setUsers([]telemt.UserInfo{{Username: "created-after-revoke", ActiveIPList: []string{"203.0.113.42"}, Links: telemt.UserLinks{Classic: []string{"tg://proxy?server=example.test&port=443&secret=NEW_SECRET_CREATED_AFTER_REVOKE"}}}})
	timeout := time.NewTimer(time.Second)
	defer timeout.Stop()
	for {
		select {
		case frame, open := <-frames:
			if !open {
				return
			}
			if frame.event == "users" && strings.Contains(frame.data, "NEW_SECRET_CREATED_AFTER_REVOKE") {
				t.Fatalf("revoked session received new protected data: %s", frame.data)
			}
		case <-timeout.C:
			t.Fatal("revoked session stream stayed open")
		}
	}
}
