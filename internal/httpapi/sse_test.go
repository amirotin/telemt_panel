package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

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
	t.Cleanup(srv.subLimiter.Stop)

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

// mutableFakeTelemtHTTP is a Telemt stand-in whose /v1/users response can
// be changed mid-test, for exercising the hub's poller against a real
// upstream server rather than a pre-canceled request.
type mutableFakeTelemtHTTP struct {
	mu    sync.Mutex
	users []telemt.UserInfo
}

func newMutableFakeTelemtHTTP(t *testing.T, users []telemt.UserInfo) (*mutableFakeTelemtHTTP, *telemt.Client) {
	t.Helper()
	f := &mutableFakeTelemtHTTP{users: users}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/users" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.mu.Lock()
		u := f.users
		f.mu.Unlock()
		data, _ := json.Marshal(u)
		fmt.Fprintf(w, `{"ok":true,"data":%s,"revision":"r"}`, data)
	}))
	t.Cleanup(srv.Close)
	return f, telemt.New(srv.URL, "")
}

func (f *mutableFakeTelemtHTTP) setUsers(users []telemt.UserInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users = users
}

// sseFrame is one parsed SSE frame (blank-line delimited); comment lines
// (heartbeats) are not surfaced as frames.
type sseFrame struct {
	id    string
	event string
	data  string
}

// readSSEFrames scans r for SSE frames in a background goroutine, sending
// each one on the returned channel; the channel closes when r is exhausted
// or errors (in particular, when the response body is closed client-side).
func readSSEFrames(r io.Reader) <-chan sseFrame {
	out := make(chan sseFrame, 16)
	go func() {
		defer close(out)
		scanner := bufio.NewScanner(r)
		var cur sseFrame
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case line == "":
				if cur.event != "" || cur.data != "" {
					out <- cur
				}
				cur = sseFrame{}
			case strings.HasPrefix(line, ":"):
				// comment line (heartbeat) — not a frame field
			case strings.HasPrefix(line, "id: "):
				cur.id = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				cur.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				cur.data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return out
}

// nextFrame waits up to timeout for the next frame from frames.
func nextFrame(t *testing.T, frames <-chan sseFrame, timeout time.Duration) sseFrame {
	t.Helper()
	select {
	case f, ok := <-frames:
		if !ok {
			t.Fatal("SSE stream closed unexpectedly")
		}
		return f
	case <-time.After(timeout):
		t.Fatal("timed out waiting for an SSE frame")
	}
	panic("unreachable")
}

// TestHandleEventsStreamsUpdatesAndReplaysOnReconnect exercises the SSE
// endpoint end-to-end over a real network connection (httptest.Server, not
// ResponseRecorder): a client reads the initial snapshot, observes a
// streamed update after the fake upstream's data changes, disconnects, and
// reconnects with Last-Event-ID set to the initial snapshot's id — which
// must replay exactly the missed update instead of a fresh snapshot.
func TestHandleEventsStreamsUpdatesAndReplaysOnReconnect(t *testing.T) {
	fake, tc := newMutableFakeTelemtHTTP(t, []telemt.UserInfo{{Username: "alice"}})

	interval := 20 * time.Millisecond
	srv, cookie := newSSETestServer(t, tc, hub.Config{UsersInterval: interval, StatsInterval: time.Hour, Grace: time.Second})

	panelSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(panelSrv.Close)

	req1, err := http.NewRequest(http.MethodGet, panelSrv.URL+"/api/events?topics=users", nil)
	if err != nil {
		t.Fatal(err)
	}
	req1.AddCookie(cookie)
	resp1, err := http.DefaultClient.Do(req1)
	if err != nil {
		t.Fatalf("first connect: %v", err)
	}
	t.Cleanup(func() { resp1.Body.Close() })
	if resp1.StatusCode != http.StatusOK {
		t.Fatalf("first connect status = %d, want 200", resp1.StatusCode)
	}

	frames1 := readSSEFrames(resp1.Body)

	initial := nextFrame(t, frames1, 2*time.Second)
	if initial.event != "users" || !strings.Contains(initial.data, "alice") {
		t.Fatalf("initial frame = %+v, want the users snapshot with alice", initial)
	}
	initialID := initial.id
	if initialID == "" {
		t.Fatal("initial frame carries no id")
	}

	// Change the upstream data and observe the streamed update on the same
	// open connection.
	fake.setUsers([]telemt.UserInfo{{Username: "bob"}})
	updated := nextFrame(t, frames1, 2*time.Second)
	if updated.event != "users" || !strings.Contains(updated.data, "bob") {
		t.Fatalf("updated frame = %+v, want the bob update", updated)
	}

	resp1.Body.Close()

	// Reconnect with Last-Event-ID at the initial snapshot: the bob update
	// must come back via replay, not a fresh (already-current) snapshot,
	// and with the same id as when it first streamed.
	req2, err := http.NewRequest(http.MethodGet, panelSrv.URL+"/api/events?topics=users", nil)
	if err != nil {
		t.Fatal(err)
	}
	req2.AddCookie(cookie)
	req2.Header.Set("Last-Event-ID", initialID)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	t.Cleanup(func() { resp2.Body.Close() })
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("reconnect status = %d, want 200", resp2.StatusCode)
	}

	frames2 := readSSEFrames(resp2.Body)
	replayed := nextFrame(t, frames2, 2*time.Second)
	if replayed.event != "users" || !strings.Contains(replayed.data, "bob") {
		t.Fatalf("replayed frame = %+v, want the missed bob update", replayed)
	}
	if replayed.id != updated.id {
		t.Fatalf("replayed id = %s, want %s (the same event, replayed)", replayed.id, updated.id)
	}
}
