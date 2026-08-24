package telemt

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// capsServer scripts a fake Telemt backing every capability probe: each
// route's response is configurable independently so tests can exercise one
// flag at a time without hand-rolling an httptest.Server per case.
type capsServer struct {
	mu sync.Mutex

	quotaStatus  int // 0 = 200 with an empty quota list
	runtimeEdge  bool
	runtimeErr   bool // serve a transport-level 500 instead of a gate wrapper
	reloadStatus int  // 0 = 200
	configStatus int  // 0 = 200
}

func newCapsTestClient(t *testing.T, s *capsServer) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		switch r.URL.Path {
		case "/v1/stats/users/quota":
			if s.quotaStatus != 0 {
				w.WriteHeader(s.quotaStatus)
				return
			}
			fmt.Fprint(w, `{"ok":true,"data":{"users":[]},"revision":"r"}`)
		case "/v1/runtime/connections/summary":
			if s.runtimeErr {
				w.WriteHeader(http.StatusInternalServerError)
				fmt.Fprint(w, `{"ok":false,"error":{"code":"internal_error","message":"boom"}}`)
				return
			}
			fmt.Fprintf(w, `{"ok":true,"data":{"enabled":%t},"revision":"r"}`, s.runtimeEdge)
		case "/v1/system/reload/0":
			if s.reloadStatus != 0 {
				w.WriteHeader(s.reloadStatus)
				return
			}
			fmt.Fprint(w, `{"ok":true,"data":{"state":"succeeded"},"revision":"r"}`)
		case "/v1/config":
			if s.configStatus != 0 {
				w.WriteHeader(s.configStatus)
				return
			}
			fmt.Fprint(w, `{"ok":true,"data":{},"revision":"r"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL, "")
}

// TestCapabilitiesProbeTable exercises each flag from a scripted fake,
// independently of the others, per the brief's "capabilities probe table"
// deliverable.
func TestCapabilitiesProbeTable(t *testing.T) {
	tests := []struct {
		name    string
		script  *capsServer
		want    Caps
		wantErr bool
	}{
		{
			name:   "everything present and enabled",
			script: &capsServer{runtimeEdge: true},
			want:   Caps{Quota: true, RuntimeEdge: true, ReloadAPI: true, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true},
		},
		{
			name:   "quota absent on old build",
			script: &capsServer{quotaStatus: http.StatusNotFound},
			want:   Caps{Quota: false, RuntimeEdge: false, ReloadAPI: true, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true},
		},
		{
			name:   "runtime_edge disabled by default",
			script: &capsServer{runtimeEdge: false},
			want:   Caps{Quota: true, RuntimeEdge: false, ReloadAPI: true, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true},
		},
		{
			name:   "runtime_edge probe error degrades to false",
			script: &capsServer{runtimeErr: true},
			want:   Caps{Quota: true, RuntimeEdge: false, ReloadAPI: true, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true},
		},
		{
			name:   "reload_api absent (route 404)",
			script: &capsServer{reloadStatus: http.StatusNotFound},
			want:   Caps{Quota: true, RuntimeEdge: false, ReloadAPI: false, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true},
		},
		{
			name:   "reload_api other error defaults true",
			script: &capsServer{reloadStatus: http.StatusInternalServerError},
			want:   Caps{Quota: true, RuntimeEdge: false, ReloadAPI: true, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true},
		},
		{
			name:   "config_api absent (file-mode build, 404)",
			script: &capsServer{configStatus: http.StatusNotFound},
			want:   Caps{Quota: true, RuntimeEdge: false, ReloadAPI: true, ConfigAPI: false, UserEnableDisable: true, RotateSecret: true},
		},
		{
			name:   "config_api absent (405)",
			script: &capsServer{configStatus: http.StatusMethodNotAllowed},
			want:   Caps{Quota: true, RuntimeEdge: false, ReloadAPI: true, ConfigAPI: false, UserEnableDisable: true, RotateSecret: true},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := newCapsTestClient(t, tc.script)
			got, err := c.Capabilities(context.Background())
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("caps = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestCapabilitiesCachedUntilTTLExpires proves the 5-minute cache: a second
// call within the TTL must not re-probe Telemt, and a call after the
// injected clock advances past it must.
func TestCapabilitiesCachedUntilTTLExpires(t *testing.T) {
	var probes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/stats/users/quota" {
			probes++
		}
		switch r.URL.Path {
		case "/v1/stats/users/quota":
			fmt.Fprint(w, `{"ok":true,"data":{"users":[]},"revision":"r"}`)
		case "/v1/runtime/connections/summary":
			fmt.Fprint(w, `{"ok":true,"data":{"enabled":false},"revision":"r"}`)
		case "/v1/system/reload/0", "/v1/config":
			fmt.Fprint(w, `{"ok":true,"data":{},"revision":"r"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)

	now := time.Now()
	clock := func() time.Time { return now }
	c := newClient(srv.URL, "", clock)

	if _, err := c.Capabilities(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Capabilities(context.Background()); err != nil {
		t.Fatal(err)
	}
	if probes != 1 {
		t.Fatalf("probes = %d, want 1 (second call within TTL must reuse the cache)", probes)
	}

	now = now.Add(capabilityCacheTTL + time.Second)
	if _, err := c.Capabilities(context.Background()); err != nil {
		t.Fatal(err)
	}
	if probes != 2 {
		t.Fatalf("probes = %d, want 2 (call past the TTL must re-probe)", probes)
	}
}

// TestCapabilitiesRotateSecretFlipsLazilyOnRealNotFound covers the
// "flip lazily when a real call 404s" rule: rotate_secret starts true
// (never probed ahead of time), and a genuine route-absent 404 from
// RotateSecret latches it false immediately — even mid-cache-TTL, since the
// lazy flags aren't gated by the probed-flags cache at all.
func TestCapabilitiesRotateSecretFlipsLazilyOnRealNotFound(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/users/bob/rotate-secret":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, "404 page not found")
		default:
			fmt.Fprint(w, `{"ok":true,"data":{"users":[]},"revision":"r"}`)
		}
	})

	caps, err := c.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !caps.RotateSecret {
		t.Fatal("rotate_secret should default true before any real call")
	}

	if _, _, err := c.RotateSecret(context.Background(), "bob"); err == nil {
		t.Fatal("expected RotateSecret to fail against the 404 route")
	}

	caps, err = c.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if caps.RotateSecret {
		t.Fatal("rotate_secret should have flipped false after a real 404")
	}
}

// TestCapabilitiesRotateSecretWellFormedNotFoundDoesNotFlip proves a
// genuine "user does not exist" 404 (the route exists; the user doesn't)
// is not mistaken for a capability-absent route — the SDK distinguishes by
// the envelope's error code, mirroring httpapi's writeTelemtError.
func TestCapabilitiesRotateSecretWellFormedNotFoundDoesNotFlip(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/users/ghost/rotate-secret":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"ok":false,"error":{"code":"not_found","message":"no such user"},"request_id":1}`)
		default:
			fmt.Fprint(w, `{"ok":true,"data":{"users":[]},"revision":"r"}`)
		}
	})

	if _, _, err := c.RotateSecret(context.Background(), "ghost"); err == nil {
		t.Fatal("expected an error")
	}

	caps, err := c.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !caps.RotateSecret {
		t.Fatal("a well-formed not_found for an existing route must not flip rotate_secret false")
	}
}

// TestCapabilitiesSingleFlightsColdCacheProbe covers fix 2: N concurrent
// Capabilities() calls against a cold (or just-expired) cache must fire
// exactly one 4-probe round, not one round per caller. The first goroutine
// to reach the quota probe is held there (via the release channel) for a
// beat so every other goroutine has time to call Capabilities and block on
// the single-flight guard — without probeMu serializing them, they would
// instead all reach the fake server concurrently and this count would come
// back well above 1.
func TestCapabilitiesSingleFlightsColdCacheProbe(t *testing.T) {
	var quotaCalls, runtimeCalls, reloadCalls, configCalls int32
	var firstIn int32
	release := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/stats/users/quota":
			atomic.AddInt32(&quotaCalls, 1)
			if atomic.AddInt32(&firstIn, 1) == 1 {
				<-release
			}
			fmt.Fprint(w, `{"ok":true,"data":{"users":[]},"revision":"r"}`)
		case "/v1/runtime/connections/summary":
			atomic.AddInt32(&runtimeCalls, 1)
			fmt.Fprint(w, `{"ok":true,"data":{"enabled":false},"revision":"r"}`)
		case "/v1/system/reload/0":
			atomic.AddInt32(&reloadCalls, 1)
			fmt.Fprint(w, `{"ok":true,"data":{},"revision":"r"}`)
		case "/v1/config":
			atomic.AddInt32(&configCalls, 1)
			fmt.Fprint(w, `{"ok":true,"data":{},"revision":"r"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	c := New(srv.URL, "")

	const n = 20
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			if _, err := c.Capabilities(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}

	// Let every goroutine reach Capabilities and pile up on the
	// single-flight guard before releasing the winner's quota probe.
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()

	if quotaCalls != 1 || runtimeCalls != 1 || reloadCalls != 1 || configCalls != 1 {
		t.Fatalf("probe calls = quota:%d runtime:%d reload:%d config:%d, want exactly 1 each (single-flight)",
			quotaCalls, runtimeCalls, reloadCalls, configCalls)
	}
}
