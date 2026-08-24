package httpapi

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// TestStagingPrefix_EmptyDataDirIsAbsoluteUnderTempDir covers finding 4: an
// empty data_dir (the documented RAM-only-state config) must not produce
// the relative path "staging" — every install op's validatePathShape
// check (privexec.go) rejects a relative staging prefix outright.
func TestStagingPrefix_EmptyDataDirIsAbsoluteUnderTempDir(t *testing.T) {
	got := stagingPrefix("")
	if !filepath.IsAbs(got) {
		t.Fatalf("stagingPrefix(\"\") = %q, want an absolute path", got)
	}
	if !strings.HasPrefix(got, os.TempDir()) {
		t.Errorf("stagingPrefix(\"\") = %q, want it under os.TempDir() %q", got, os.TempDir())
	}
}

func TestStagingPrefix_NonEmptyDataDirJoinsStaging(t *testing.T) {
	got := stagingPrefix("/var/lib/telemt-panel")
	want := filepath.Join("/var/lib/telemt-panel", "staging")
	if got != want {
		t.Errorf("stagingPrefix(%q) = %q, want %q", "/var/lib/telemt-panel", got, want)
	}
}

// TestAllowedServiceNames_IncludesContainerNamesWhenTheyDiffer covers
// finding 3's allow-list half: both the plain service name and the docker
// container name must be allow-listed whenever they differ, since
// restart-service and read-journal each resolve their own name from a
// potentially different Kind() (service manager vs. log source).
func TestAllowedServiceNames_IncludesContainerNamesWhenTheyDiffer(t *testing.T) {
	cfg := config.HostConfig{
		TelemtService:   "telemt",
		PanelService:    "telemt-panel",
		TelemtContainer: "telemt-ctr",
		PanelContainer:  "panel-ctr",
	}
	got := allowedServiceNames(cfg)
	want := []string{"telemt", "telemt-panel", "telemt-ctr", "panel-ctr"}
	if len(got) != len(want) {
		t.Fatalf("allowedServiceNames = %v, want %v", got, want)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("allowedServiceNames[%d] = %q, want %q (full: %v)", i, got[i], w, got)
		}
	}
}

// TestAllowedServiceNames_NoDuplicateWhenContainerMatchesService covers
// the non-docker case: a container name that happens to equal the plain
// service name (or is unset) must not be listed twice.
func TestAllowedServiceNames_NoDuplicateWhenContainerMatchesService(t *testing.T) {
	cfg := config.HostConfig{
		TelemtService:   "telemt",
		PanelService:    "telemt-panel",
		TelemtContainer: "telemt", // same as TelemtService
		PanelContainer:  "",       // unset
	}
	got := allowedServiceNames(cfg)
	want := []string{"telemt", "telemt-panel"}
	if len(got) != len(want) {
		t.Fatalf("allowedServiceNames = %v, want %v", got, want)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("allowedServiceNames[%d] = %q, want %q (full: %v)", i, got[i], w, got)
		}
	}
}

// TestAPIUnknownPathReturnsJSON404 covers P2.6b: an unmatched /api/* path
// must get the panel's {code,message} envelope, not ServeMux's default
// plain-text 404.
func TestAPIUnknownPathReturnsJSON404(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	r := httptest.NewRequest(http.MethodGet, "/api/nope", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var body struct{ Code, Message string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v (body: %s)", err, w.Body.String())
	}
	if body.Code != "not_found" {
		t.Fatalf("error code = %q, want not_found", body.Code)
	}
}

// TestAPIWrongMethodReturnsJSON405WithAllow covers P2.6b: a known /api/*
// path hit with the wrong method must get a JSON 405 with the Allow header
// ServeMux itself computes (the actual set of methods registered for that
// path), not a plain-text body.
func TestAPIWrongMethodReturnsJSON405WithAllow(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	// GET /api/auth/me is registered; DELETE is not.
	r := httptest.NewRequest(http.MethodDelete, "/api/auth/me", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
	if allow := w.Header().Get("Allow"); allow == "" {
		t.Error("Allow header missing on 405 response")
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var body struct{ Code, Message string }
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error body: %v (body: %s)", err, w.Body.String())
	}
	if body.Code != "method_not_allowed" {
		t.Fatalf("error code = %q, want method_not_allowed", body.Code)
	}
}

// TestSubUnknownPathStaysPlainText covers P2.6b's scope boundary: the
// JSON fallback applies to /api/* only — /sub/* (public, no cookie) must
// keep ServeMux's default plain-text 404 unchanged.
func TestSubUnknownPathStaysPlainText(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.Subpage.Enabled = true
	srv.cfg.Subpage.Secret = "test-secret-at-least-32-bytes-long!!"
	h := srv.Handler()

	r := httptest.NewRequest(http.MethodGet, "/sub/bad", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct == "application/json" {
		t.Fatal("Content-Type = application/json, want /sub/* to stay plain text")
	}
}

// freeAddr reserves an ephemeral TCP port and immediately releases it so a
// test's own *http.Server (started via Run, which only accepts an address
// string, not a pre-made listener) can bind it a moment later.
func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve free port: %v", err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatalf("release reserved port: %v", err)
	}
	return addr
}

// waitForListener busy-polls (no sleeps: Run starts ListenAndServe on its
// own goroutine, with no readiness signal this test can otherwise wait on)
// until addr accepts a TCP connection, or fails the test after 2s.
func waitForListener(t *testing.T, addr string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 50*time.Millisecond)
		if err == nil {
			conn.Close()
			return
		}
	}
	t.Fatalf("server never started listening on %s", addr)
}

// TestRunShutsDownPromptlyWithAnOpenSSEClient covers finding 2: Shutdown
// must not stall for anywhere near its 10s deadline just because an SSE
// client is still connected. Run registers hub.Close as an on-shutdown
// hook, which closes every subscriber channel the moment Shutdown starts;
// the SSE handler's loop then exits on the next select (channel closed)
// instead of waiting for the client to disconnect on its own, which it
// never does in this test.
func TestRunShutsDownPromptlyWithAnOpenSSEClient(t *testing.T) {
	tc := newFakeTelemtHTTP(t, []telemt.UserInfo{{Username: "alice"}})

	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	addr := freeAddr(t)
	cfg := &config.Config{
		Listen: addr,
		Auth:   config.AuthConfig{Username: "admin", PasswordHash: hash},
	}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	hb := hub.New(hub.Config{Heartbeat: 15 * time.Millisecond}, tc)
	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)

	// Log in offline (in-process, no network) purely to mint a valid
	// session cookie for the real network request below.
	_, cookie := login(t, srv.Handler(), "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() { runDone <- srv.Run(ctx) }()

	waitForListener(t, addr)

	req, err := http.NewRequest(http.MethodGet, "http://"+addr+"/api/events?topics=users", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	// Confirm the stream actually delivered data before triggering
	// shutdown, so this test proves a *live* stream doesn't stall it.
	buf := make([]byte, 512)
	if _, err := resp.Body.Read(buf); err != nil {
		t.Fatalf("read initial snapshot: %v", err)
	}

	start := time.Now()
	cancel()

	select {
	case runErr := <-runDone:
		if runErr != nil {
			t.Fatalf("Run returned %v, want nil", runErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return within 2s of the shutdown signal — the open SSE client stalled it")
	}
	if elapsed := time.Since(start); elapsed >= 9*time.Second {
		t.Fatalf("Run took %s to return, want well under the 10s shutdown deadline", elapsed)
	}
}
