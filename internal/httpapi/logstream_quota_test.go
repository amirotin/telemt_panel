package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/host"
)

func TestEventsLogsQuotaBeforeSourceAndHeaders(t *testing.T) {
	srv, cookie, _, source := newHostTestServer(t)
	source.CapsValue = host.LogCaps{CanStream: true}
	var started, active atomic.Int32
	source.StreamFunc = func(ctx context.Context, _ string) (<-chan host.LogEvent, error) {
		started.Add(1)
		active.Add(1)
		ch := make(chan host.LogEvent)
		go func() { <-ctx.Done(); active.Add(-1); close(ch) }()
		return ch, nil
	}
	_, second := login(t, srv.Handler(), "admin", testPassword)
	_, third := login(t, srv.Handler(), "admin", testPassword)
	panel := httptest.NewServer(srv.Handler())
	t.Cleanup(panel.Close)
	var responses []*http.Response
	t.Cleanup(func() {
		for _, response := range responses {
			_ = response.Body.Close()
		}
	})
	request := func(c *http.Cookie) *http.Response {
		r, err := http.NewRequest(http.MethodGet, panel.URL+"/api/events/logs?service=telemt", nil)
		if err != nil {
			t.Fatal(err)
		}
		r.AddCookie(c)
		response, err := panel.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		responses = append(responses, response)
		return response
	}
	for range 2 {
		if response := request(cookie); response.StatusCode != http.StatusOK {
			t.Fatalf("first streams status=%d", response.StatusCode)
		}
	}
	if response := request(cookie); response.StatusCode != http.StatusTooManyRequests || response.Header.Get("Retry-After") != "5" {
		t.Fatalf("third session stream=%d, retry=%q", response.StatusCode, response.Header.Get("Retry-After"))
	}
	for range 2 {
		if response := request(second); response.StatusCode != http.StatusOK {
			t.Fatalf("second session streams=%d", response.StatusCode)
		}
	}
	for range 7 {
		if response := request(third); response.StatusCode != http.StatusTooManyRequests {
			t.Fatalf("global quota status=%d", response.StatusCode)
		}
	}
	if started.Load() != 4 || active.Load() > 4 {
		t.Fatalf("started=%d active=%d, want4", started.Load(), active.Load())
	}
	if err := srv.sessions.Revoke(auth.HashToken(cookie.Value)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for active.Load() > 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if active.Load() != 2 {
		t.Fatalf("revoked source slots not freed: active=%d", active.Load())
	}
	if response := request(third); response.StatusCode != http.StatusOK {
		t.Fatalf("released capacity unavailable=%d", response.StatusCode)
	}
}

func TestEventsLogsHeadProbeHasNoSourceOrReservation(t *testing.T) {
	srv, cookie, _, source := newHostTestServer(t)
	source.CapsValue = host.LogCaps{CanStream: true}
	var started atomic.Int32
	source.StreamFunc = func(context.Context, string) (<-chan host.LogEvent, error) {
		started.Add(1)
		return make(chan host.LogEvent), nil
	}
	for range 10 {
		r := httptest.NewRequest(http.MethodHead, "/api/events/logs?service=telemt", nil)
		r.AddCookie(cookie)
		ctx, cancel := context.WithCancel(r.Context())
		r = r.WithContext(ctx)
		w := &cancelAfterFlushRecorder{httptest.NewRecorder(), cancel}
		srv.Handler().ServeHTTP(w, r)
		cancel()
		if w.Code != http.StatusNoContent {
			t.Fatalf("HEAD=%d %s", w.Code, w.Body)
		}
	}
	if started.Load() != 0 {
		t.Fatalf("HEAD started %d sources", started.Load())
	}
	if len(srv.logStreams.active) != 0 {
		t.Fatal("HEAD reserved a stream slot")
	}
}
