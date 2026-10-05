package telemt

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type testRoundTripper func(*http.Request) (*http.Response, error)

func (f testRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type capabilityRecoveryScript struct {
	version        atomic.Value
	now            atomic.Int64
	mutationAbsent atomic.Bool
	probeAbsent    atomic.Bool
	quotaCalls     atomic.Int32
	mutationCalls  atomic.Int32
}

func newCapabilityRecoveryClient(t *testing.T) (*Client, *capabilityRecoveryScript) {
	t.Helper()
	s := &capabilityRecoveryScript{}
	s.version.Store("3.5.0")
	s.now.Store(time.Unix(1000, 0).UnixNano())
	s.mutationAbsent.Store(true)
	s.probeAbsent.Store(true)
	c := newClient("http://telemt.test", "", func() time.Time { return time.Unix(0, s.now.Load()) })
	c.http.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		w := httptest.NewRecorder()
		s.serve(w, r)
		return w.Result(), nil
	})
	return c, s
}

func (s *capabilityRecoveryScript) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/v1/system/info":
		fmt.Fprintf(w, `{"ok":true,"data":{"version":%q}}`, s.version.Load().(string))
	case r.Method == http.MethodPost:
		s.mutationCalls.Add(1)
		if s.mutationAbsent.Load() {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/rotate-secret") {
			fmt.Fprint(w, `{"ok":true,"data":{"user":{"username":"alice"},"secret":"replacement"}}`)
			return
		}
		fmt.Fprint(w, `{"ok":true,"data":{"username":"alice","enabled":true}}`)
	default:
		if r.URL.Path == "/v1/stats/users/quota" {
			s.quotaCalls.Add(1)
		}
		if s.probeAbsent.Load() {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.Path == "/v1/runtime/connections/summary" {
			fmt.Fprint(w, `{"ok":true,"data":{"enabled":true}}`)
			return
		}
		fmt.Fprint(w, `{"ok":true,"data":{"users":[]}}`)
	}
}

func markBothCapabilitiesAbsent(t *testing.T, c *Client) {
	t.Helper()
	if _, _, err := c.RotateSecret(context.Background(), "alice"); !isRouteAbsent(err) {
		t.Fatalf("RotateSecret error = %v, want route absent", err)
	}
	if _, err := c.SetEnabled(context.Background(), "alice", true); !isRouteAbsent(err) {
		t.Fatalf("SetEnabled error = %v, want route absent", err)
	}
}

func recoveryCaps(t *testing.T, c *Client) Caps {
	t.Helper()
	caps, err := c.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return caps
}

func TestExternalReportN4CapabilitiesAfterUpgrade(t *testing.T) {
	c, s := newCapabilityRecoveryClient(t)
	ctx := context.Background()
	if _, err := c.SystemInfo(ctx); err != nil {
		t.Fatal(err)
	}
	markBothCapabilitiesAbsent(t, c)
	recoveryCaps(t, c)
	s.version.Store("3.5.5")
	s.mutationAbsent.Store(false)
	s.probeAbsent.Store(false)
	s.now.Add(int64(capabilityCacheTTL + time.Second))
	info, err := c.SystemInfo(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.RotateSecret(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SetEnabled(ctx, "alice", true); err != nil {
		t.Fatal(err)
	}
	caps := recoveryCaps(t, c)
	if !caps.RotateSecret || !caps.UserEnableDisable {
		t.Errorf("upgraded version=%s, both mutations succeed, cache TTL expired: rotate_secret=%v user_enable_disable=%v", info.Version, caps.RotateSecret, caps.UserEnableDisable)
	}
}

func TestCapabilitiesVersionChangeRecoversBeforeTTL(t *testing.T) {
	c, s := newCapabilityRecoveryClient(t)
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	markBothCapabilitiesAbsent(t, c)
	if caps := recoveryCaps(t, c); caps != (Caps{}) {
		t.Fatalf("legacy capabilities = %+v, want all false", caps)
	}
	s.version.Store("3.5.5")
	s.probeAbsent.Store(false)
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := Caps{Quota: true, RuntimeEdge: true, ReloadAPI: true, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true}
	if caps := recoveryCaps(t, c); caps != want {
		t.Fatalf("upgraded capabilities = %+v, want %+v before TTL", caps, want)
	}
	if got := s.mutationCalls.Load(); got != 2 {
		t.Fatalf("mutation calls = %d, want only the two explicit calls", got)
	}
}

func TestCapabilitiesNegativeObservationsExpireWithinCachedRound(t *testing.T) {
	c, s := newCapabilityRecoveryClient(t)
	recoveryCaps(t, c)
	s.now.Add(int64(4 * time.Minute))
	markBothCapabilitiesAbsent(t, c)
	s.now.Add(int64(time.Minute))
	if caps := recoveryCaps(t, c); caps.RotateSecret || caps.UserEnableDisable {
		t.Fatalf("one-minute-old negative observations disappeared: %+v", caps)
	}
	s.now.Add(int64(4*time.Minute - time.Nanosecond))
	if caps := recoveryCaps(t, c); caps.RotateSecret || caps.UserEnableDisable {
		t.Fatalf("negative observations expired before five minutes: %+v", caps)
	}
	s.now.Add(1)
	if caps := recoveryCaps(t, c); !caps.RotateSecret || !caps.UserEnableDisable {
		t.Fatalf("negative observations still present at five minutes: %+v", caps)
	}
	if got := s.quotaCalls.Load(); got != 2 {
		t.Fatalf("quota calls = %d, want cached round at negative expiry", got)
	}
	if got := s.mutationCalls.Load(); got != 2 {
		t.Fatalf("mutation calls = %d, want no automatic mutation probing", got)
	}
}

func TestCapabilitiesSuccessfulMutationClearsOwnObservation(t *testing.T) {
	c, s := newCapabilityRecoveryClient(t)
	markBothCapabilitiesAbsent(t, c)
	recoveryCaps(t, c)
	s.mutationAbsent.Store(false)
	if _, _, err := c.RotateSecret(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}
	if caps := recoveryCaps(t, c); !caps.RotateSecret || caps.UserEnableDisable {
		t.Fatalf("rotate success should clear only its observation: %+v", caps)
	}
	if _, err := c.SetEnabled(context.Background(), "alice", true); err != nil {
		t.Fatal(err)
	}
	if caps := recoveryCaps(t, c); !caps.RotateSecret || !caps.UserEnableDisable {
		t.Fatalf("successful operations should restore both capabilities: %+v", caps)
	}
}

func TestCapabilitiesMutationErrorsDoNotMarkRouteAbsent(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		code   string
	}{
		{"missing user", http.StatusNotFound, "not_found"},
		{"authorization", http.StatusUnauthorized, "unauthorized"},
		{"transient", http.StatusServiceUnavailable, "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, s := newCapabilityRecoveryClient(t)
			s.probeAbsent.Store(false)
			base := c.http.Transport
			c.http.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
				if r.Method != http.MethodPost {
					return base.RoundTrip(r)
				}
				w := httptest.NewRecorder()
				w.WriteHeader(tc.status)
				fmt.Fprintf(w, `{"ok":false,"error":{"code":%q,"message":"failure"}}`, tc.code)
				return w.Result(), nil
			})
			if _, _, err := c.RotateSecret(context.Background(), "ghost"); err == nil {
				t.Fatal("expected rotate error")
			}
			if _, err := c.SetEnabled(context.Background(), "ghost", true); err == nil {
				t.Fatal("expected enable error")
			}
			if caps := recoveryCaps(t, c); !caps.RotateSecret || !caps.UserEnableDisable {
				t.Fatalf("%s incorrectly disabled capabilities: %+v", tc.name, caps)
			}
		})
	}
}

func TestCapabilitiesVersionChangeDiscardsOldProbe(t *testing.T) {
	c, s := newCapabilityRecoveryClient(t)
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	base := c.http.Transport
	var quotaCalls atomic.Int32
	c.http.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v1/stats/users/quota" && quotaCalls.Add(1) == 1 {
			w := httptest.NewRecorder()
			w.WriteHeader(http.StatusNotFound)
			close(entered)
			<-release
			return w.Result(), nil
		}
		return base.RoundTrip(r)
	})
	done := make(chan Caps, 1)
	go func() { done <- recoveryCaps(t, c) }()
	<-entered
	s.version.Store("3.5.5")
	s.probeAbsent.Store(false)
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	close(release)
	want := Caps{Quota: true, RuntimeEdge: true, ReloadAPI: true, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true}
	if caps := <-done; caps != want {
		t.Fatalf("old-version probe won over upgrade: %+v", caps)
	}
	if caps := recoveryCaps(t, c); caps != want {
		t.Fatalf("old-version probe was cached over upgrade: %+v", caps)
	}
}

func TestCapabilitiesLateOldVersionMutationIsIgnored(t *testing.T) {
	c, s := newCapabilityRecoveryClient(t)
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	base := c.http.Transport
	c.http.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/rotate-secret") {
			w := httptest.NewRecorder()
			w.WriteHeader(http.StatusMethodNotAllowed)
			close(entered)
			<-release
			return w.Result(), nil
		}
		return base.RoundTrip(r)
	})
	done := make(chan error, 1)
	go func() {
		_, _, err := c.RotateSecret(context.Background(), "alice")
		done <- err
	}()
	<-entered
	s.version.Store("3.5.5")
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; !isRouteAbsent(err) {
		t.Fatalf("old mutation error = %v, want original route absence", err)
	}
	if caps := recoveryCaps(t, c); !caps.RotateSecret {
		t.Fatalf("late old-version mutation disabled upgraded route: %+v", caps)
	}
}

func TestCapabilitiesLateOldVersionInfoIsIgnored(t *testing.T) {
	c, s := newCapabilityRecoveryClient(t)
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	base := c.http.Transport
	var infoCalls atomic.Int32
	c.http.Transport = testRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v1/system/info" && infoCalls.Add(1) == 1 {
			w := httptest.NewRecorder()
			fmt.Fprint(w, `{"ok":true,"data":{"version":"3.5.0"}}`)
			close(entered)
			<-release
			return w.Result(), nil
		}
		return base.RoundTrip(r)
	})
	done := make(chan error, 1)
	go func() {
		_, err := c.SystemInfo(context.Background())
		done <- err
	}()
	<-entered
	s.version.Store("3.5.5")
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	markBothCapabilitiesAbsent(t, c)
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := c.SystemInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if caps := recoveryCaps(t, c); caps.RotateSecret || caps.UserEnableDisable {
		t.Fatalf("late old-version info reset observations for the current version: %+v", caps)
	}
}
