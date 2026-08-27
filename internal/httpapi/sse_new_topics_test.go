package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

// recvEventOrFail waits up to 2s for the next event on ch, failing the test
// on timeout — mirrors internal/hub's own recvEvent test helper, duplicated
// here since that one is unexported to its package.
func recvEventOrFail(t *testing.T, ch <-chan hub.Event) hub.Event {
	t.Helper()
	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("channel closed unexpectedly")
		}
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for an event")
	}
	panic("unreachable")
}

// TestHandleEventsNewTopicsInitialSnapshot is the golden SSE test for M3
// task-2's three new hub topics (deliverable A/H): subscribing to
// runtime, upstreams and security together against a telemttest fixture
// must deliver one snapshot event per topic on connect, each carrying its
// documented composite fields. Follows TestHandleEventsWritesInitialSnapshot's
// pre-warm-then-cancel pattern (sse_test.go) — a canceled request context
// still lets ResponseRecorder capture whatever was written before the
// handler noticed the cancellation.
func TestHandleEventsNewTopicsInitialSnapshot(t *testing.T) {
	fake := telemttest.New(telemttest.Scenario{RuntimeEdge: true})
	t.Cleanup(fake.Close)
	tc := telemt.New(fake.URL, "")
	srv, cookie := newSSETestServer(t, tc, hub.Config{})

	warmCtx, warmCancel := context.WithTimeout(context.Background(), snapshotFetchTimeout)
	if _, err := srv.hub.Snapshot(warmCtx, []string{"runtime", "upstreams", "security", "stats"}); err != nil {
		t.Fatalf("warm snapshot: %v", err)
	}
	warmCancel()

	r := httptest.NewRequest("GET", "/api/events?topics=runtime,upstreams,security,stats", nil)
	r.AddCookie(cookie)
	reqCtx, reqCancel := context.WithCancel(r.Context())
	reqCancel()
	r = r.WithContext(reqCtx)

	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	body := w.Body.String()

	for _, want := range []string{"event: runtime", "event: upstreams", "event: security", "event: stats"} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q:\n%s", want, body)
		}
	}

	// Spot-check each new topic's documented composite fields actually
	// made it onto the wire (hub.go's runtimeSnapshot/upstreamsSnapshot/
	// securitySnapshot json tags), and that the runtime_edge-gated fields
	// appear too since this fixture has RuntimeEdge on.
	for _, want := range []string{
		`"gates"`, `"me_pool_state"`, `"me_quality"`, `"nat_stun"`, `"me_selftest"`, `"recent_events"`,
		// minimal/upstream_quality: mini-task 2c.
		`"minimal"`, `"upstream_quality"`,
		`"upstreams"`, `"dcs"`, `"me_writers"`,
		`"posture"`, `"whitelist"`, `"effective_limits"`,
		`"ready"`, `"connections_summary"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing field %s:\n%s", want, body)
		}
	}

	// tls_fingerprints was deliberately removed from the "security" topic
	// (M4 task 1 / owner ruling 2026-08-26): ~120 KB per poll for data the
	// dashboard reads on visit through GET /api/telemt/tls-fingerprints.
	// This fixture has RuntimeEdge on, which used to be exactly when the
	// field appeared — so its absence here is the meaningful assertion.
	if strings.Contains(body, `"tls_fingerprints"`) {
		t.Errorf("security topic still carries tls_fingerprints:\n%s", body)
	}
}

// TestHandleEventsNewTopicsSourceErrorWhenUnreachable covers the SSE-level
// half of the "full failure -> source_error" rule for the three new
// topics: an unreachable Telemt must produce source_error events (the same
// ones handleEvents forwards verbatim as SSE frames — see writeSSEEvent),
// not a hang or a panic anywhere in the poll path.
func TestHandleEventsNewTopicsSourceErrorWhenUnreachable(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "") // nothing listens here
	srv, _ := newSSETestServer(t, tc, hub.Config{})

	ch, _, cancel, err := srv.hub.Subscribe([]string{"runtime", "upstreams", "security"})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer cancel()
	for i := 0; i < 3; i++ {
		ev := recvEventOrFail(t, ch)
		if ev.Err != "telemt_unreachable" {
			t.Errorf("topic %q: Err = %q, want telemt_unreachable", ev.Topic, ev.Err)
		}
	}
}
