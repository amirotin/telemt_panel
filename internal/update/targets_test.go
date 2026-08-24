package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// newHealthServer returns an httptest server whose /v1/health handler
// fails until the (failures+1)th call, then succeeds — for
// TestTelemtTarget_PostRestart_RetriesUntilHealthy.
func newHealthServer(t *testing.T, failures int) *httptest.Server {
	t.Helper()
	var calls int32
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if int(n) <= failures {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok","read_only":false}`))
	}))
}

func TestTelemtTarget_PostRestart_RetriesUntilHealthy(t *testing.T) {
	srv := newHealthServer(t, 2) // fails twice, succeeds on the 3rd call
	t.Cleanup(srv.Close)

	// A manually-driven "after" lets the test fire each interval tick
	// without a real wait. PostRestart calls After once for the deadline
	// (first call) and once per loop iteration for the interval
	// (subsequent calls) — using distinct channels keeps the two cases in
	// PostRestart's select unambiguous: the deadline channel is never sent
	// to (this test must resolve via a successful poll, not a timeout).
	deadline := make(chan time.Time)
	interval := make(chan time.Time, 100)
	interval <- time.Now()
	interval <- time.Now()
	interval <- time.Now()

	first := true
	target := &TelemtTarget{
		Client: telemt.New(srv.URL, ""),
		After: func(d time.Duration) <-chan time.Time {
			if first {
				first = false
				return deadline
			}
			return interval
		},
	}

	if err := target.PostRestart(context.Background()); err != nil {
		t.Fatalf("PostRestart: %v", err)
	}
}

func TestTelemtTarget_PostRestart_TimesOut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)

	deadline := make(chan time.Time, 1)
	deadline <- time.Now()
	interval := make(chan time.Time, 100)
	for i := 0; i < 10; i++ {
		interval <- time.Now()
	}

	first := true
	target := &TelemtTarget{
		Client: telemt.New(srv.URL, ""),
		After: func(d time.Duration) <-chan time.Time {
			if first {
				first = false
				return deadline
			}
			return interval
		},
	}

	err := target.PostRestart(context.Background())
	if err == nil {
		t.Fatal("PostRestart: want a timeout error, got nil")
	}
}

func TestPanelTarget(t *testing.T) {
	target := &PanelTarget{Version_: "1.2.3", RepoName: "owner/panel", BinaryPath_: "/bin/panel", ServiceName_: "panel"}

	if target.Name() != TargetPanel {
		t.Errorf("Name() = %q, want %q", target.Name(), TargetPanel)
	}
	v, err := target.CurrentVersion(context.Background())
	if err != nil || v != "1.2.3" {
		t.Errorf("CurrentVersion() = (%q, %v), want (1.2.3, nil)", v, err)
	}
	if target.Repo() != "owner/panel" || target.BinaryPath() != "/bin/panel" || target.ServiceName() != "panel" {
		t.Errorf("field accessors wrong: %+v", target)
	}
	if err := target.PostRestart(context.Background()); err != nil {
		t.Errorf("PostRestart() = %v, want nil (no-op)", err)
	}
}
