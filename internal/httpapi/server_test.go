package httpapi

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

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
