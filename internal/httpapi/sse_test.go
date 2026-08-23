package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// newFakeTelemtHTTP is a minimal Telemt stand-in serving the couple of
// endpoints the hub's registered topics use.
func newFakeTelemtHTTP(t *testing.T, users []telemt.UserInfo) *telemt.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/users":
			data, _ := json.Marshal(users)
			fmt.Fprintf(w, `{"ok":true,"data":%s,"revision":"r"}`, data)
		case "/v1/health":
			fmt.Fprint(w, `{"ok":true,"data":{"status":"ok","read_only":false},"revision":"r"}`)
		case "/v1/stats/summary":
			fmt.Fprint(w, `{"ok":true,"data":{"uptime_seconds":1,"connections_total":0,"connections_bad_total":0,"handshake_timeouts_total":0,"configured_users":0},"revision":"r"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return telemt.New(srv.URL, "")
}

// newSSETestServer builds a logged-in Server backed by tc and hubCfg,
// returning it and a valid session cookie.
func newSSETestServer(t *testing.T, tc *telemt.Client, hubCfg hub.Config) (*Server, *http.Cookie) {
	t.Helper()
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{Auth: config.AuthConfig{Username: "admin", PasswordHash: hash}}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	hb := hub.New(hubCfg, tc)
	t.Cleanup(hb.Close)
	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}
	return srv, cookie
}

func TestHandleSnapshotReturnsCachedData(t *testing.T) {
	tc := newFakeTelemtHTTP(t, []telemt.UserInfo{{Username: "alice"}})
	srv, cookie := newSSETestServer(t, tc, hub.Config{})

	r := httptest.NewRequest("GET", "/api/snapshot?topics=users", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	data, ok := out["users"]
	if !ok {
		t.Fatal("snapshot response missing the users topic")
	}
	var users []telemt.UserInfo
	if err := json.Unmarshal(data, &users); err != nil || len(users) != 1 || users[0].Username != "alice" {
		t.Fatalf("users = %s", data)
	}
}

func TestHandleSnapshotUnknownTopic(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "")
	srv, cookie := newSSETestServer(t, tc, hub.Config{})

	r := httptest.NewRequest("GET", "/api/snapshot?topics=bogus", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	var body struct{ Code, Message string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Code != "bad_request" || !strings.Contains(body.Message, "bogus") {
		t.Fatalf("body = %+v, want bad_request naming the topic", body)
	}
}

func TestHandleSnapshotRequiresSession(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "")
	srv, _ := newSSETestServer(t, tc, hub.Config{})

	r := httptest.NewRequest("GET", "/api/snapshot?topics=users", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestHandleEventsUnknownTopic(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "")
	srv, cookie := newSSETestServer(t, tc, hub.Config{})

	r := httptest.NewRequest("GET", "/api/events?topics=bogus", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestHandleEventsRequiresSession(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "")
	srv, _ := newSSETestServer(t, tc, hub.Config{})

	r := httptest.NewRequest("GET", "/api/events?topics=users", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// TestHandleEventsWritesInitialSnapshot exercises the connect-time path
// only: it warms the hub's cache via a synchronous Snapshot call (no
// sleeps, no goroutines), then issues the SSE request with an
// already-canceled context so handleEvents writes the initial snapshot and
// returns on its very first select — deterministic, and free of the data
// race a concurrently-streaming ResponseRecorder would have.
func TestHandleEventsWritesInitialSnapshot(t *testing.T) {
	tc := newFakeTelemtHTTP(t, []telemt.UserInfo{{Username: "alice"}})
	srv, cookie := newSSETestServer(t, tc, hub.Config{})

	warmCtx, warmCancel := context.WithTimeout(context.Background(), snapshotFetchTimeout)
	if _, err := srv.hub.Snapshot(warmCtx, []string{"users"}); err != nil {
		t.Fatalf("warm snapshot: %v", err)
	}
	warmCancel()

	r := httptest.NewRequest("GET", "/api/events?topics=users", nil)
	r.AddCookie(cookie)
	reqCtx, reqCancel := context.WithCancel(r.Context())
	reqCancel()
	r = r.WithContext(reqCtx)

	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("cache-control = %q, want no-store", cc)
	}

	body := w.Body.String()
	if !strings.Contains(body, "event: users") {
		t.Fatalf("body missing the initial users snapshot event: %q", body)
	}
	if !strings.Contains(body, `"alice"`) {
		t.Fatalf("body missing the cached user: %q", body)
	}
}
