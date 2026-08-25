package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestHandleLogsTail_HappyPath(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: true}
	logSrc.TailResult = []host.LogLine{
		{TS: time.Unix(1000, 0).UTC(), Level: "info", Unit: "telemt", Msg: "hello"},
	}
	srv.cfg.Host.TelemtService = "telemt"

	r := httptest.NewRequest("GET", "/api/logs/tail?service=telemt&lines=50", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got []apiLogLine
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Msg != "hello" || got[0].Level != "info" {
		t.Fatalf("got = %+v", got)
	}
	if len(logSrc.TailCalls) != 1 {
		t.Fatalf("TailCalls = %v, want 1 call", logSrc.TailCalls)
	}
	if logSrc.TailCalls[0].Service != "telemt" || logSrc.TailCalls[0].Lines != 50 {
		t.Errorf("TailCalls[0] = %+v, want {telemt 50}", logSrc.TailCalls[0])
	}
}

func TestHandleLogsTail_DefaultLines(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: true}
	srv.cfg.Host.TelemtService = "telemt"

	r := httptest.NewRequest("GET", "/api/logs/tail?service=telemt", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if logSrc.TailCalls[0].Lines != defaultTailLines {
		t.Errorf("Lines = %d, want default %d", logSrc.TailCalls[0].Lines, defaultTailLines)
	}
}

func TestHandleLogsTail_ClampsToMax(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: true}
	srv.cfg.Host.TelemtService = "telemt"

	r := httptest.NewRequest("GET", "/api/logs/tail?service=telemt&lines=999999", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if logSrc.TailCalls[0].Lines != maxTailLines {
		t.Errorf("Lines = %d, want clamped max %d", logSrc.TailCalls[0].Lines, maxTailLines)
	}
}

func TestHandleLogsTail_InvalidLines(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: true}

	for _, lines := range []string{"abc", "-1", "0"} {
		r := httptest.NewRequest("GET", "/api/logs/tail?service=telemt&lines="+lines, nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("lines=%q: status = %d, want 400", lines, w.Code)
		}
	}
}

func TestHandleLogsTail_UnknownService(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: true}

	r := httptest.NewRequest("GET", "/api/logs/tail?service=bogus", nil)
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
		t.Fatalf("body = %+v, want bad_request naming the service", body)
	}
}

func TestHandleLogsTail_CapFalseReturns501(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: false}

	r := httptest.NewRequest("GET", "/api/logs/tail?service=telemt", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", w.Code)
	}
	if len(logSrc.TailCalls) != 0 {
		t.Errorf("Tail was called despite CanTail=false: %v", logSrc.TailCalls)
	}
}

func TestHandleLogsTail_SourceErrorReturns502(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: true}
	logSrc.TailErr = errors.New("journalctl: command not found")

	r := httptest.NewRequest("GET", "/api/logs/tail?service=telemt", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

func TestHandleLogsTail_DockerUsesContainerName(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.KindValue = host.LogKindDocker
	logSrc.CapsValue = host.LogCaps{CanTail: true}
	srv.cfg.Host.TelemtContainer = "telemt-ctr"

	r := httptest.NewRequest("GET", "/api/logs/tail?service=telemt", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if logSrc.TailCalls[0].Service != "telemt-ctr" {
		t.Errorf("Service = %q, want the configured container name", logSrc.TailCalls[0].Service)
	}
}

func TestHandleLogsTail_PanelService(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: true}
	srv.cfg.Host.PanelService = "telemt-panel"

	r := httptest.NewRequest("GET", "/api/logs/tail?service=panel", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if logSrc.TailCalls[0].Service != "telemt-panel" {
		t.Errorf("Service = %q, want telemt-panel", logSrc.TailCalls[0].Service)
	}
}

func TestHandleLogsTail_DockerUsesPanelContainerName(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.KindValue = host.LogKindDocker
	logSrc.CapsValue = host.LogCaps{CanTail: true}
	srv.cfg.Host.PanelService = "telemt-panel"
	srv.cfg.Host.PanelContainer = "panel-ctr"

	r := httptest.NewRequest("GET", "/api/logs/tail?service=panel", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	if logSrc.TailCalls[0].Service != "panel-ctr" {
		t.Errorf("Service = %q, want the configured panel container name (not PanelService)", logSrc.TailCalls[0].Service)
	}
}

func TestHandleLogsTail_RequiresSession(t *testing.T) {
	srv, _, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanTail: true}

	r := httptest.NewRequest("GET", "/api/logs/tail?service=telemt", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestHandleEventsLogs_UnknownService(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanStream: true}

	r := httptest.NewRequest("GET", "/api/events/logs?service=bogus", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestHandleEventsLogs_CapFalseReturns501(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanStream: false}

	r := httptest.NewRequest("GET", "/api/events/logs?service=telemt", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", w.Code)
	}
}

func TestHandleEventsLogs_RequiresSession(t *testing.T) {
	srv, _, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanStream: true}

	r := httptest.NewRequest("GET", "/api/events/logs?service=telemt", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// TestHandleEventsLogs_StreamsAndEndsOnDisconnect exercises the SSE log
// stream end-to-end over a real network connection (httptest.Server, not
// ResponseRecorder), the same pattern sse_test.go uses for /api/events: a
// fake LogSource.Stream feeds lines through a channel the test controls,
// the client reads them as `event: log` SSE frames, and closing the
// response body must let the handler (and the fake's feeding goroutine,
// via ctx cancellation) exit instead of hanging.
func TestHandleEventsLogs_StreamsAndEndsOnDisconnect(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanStream: true}

	lineCh := make(chan host.LogLine)
	streamCtxDone := make(chan struct{})
	logSrc.StreamFunc = func(ctx context.Context, service string) (<-chan host.LogLine, error) {
		out := make(chan host.LogLine)
		go func() {
			defer close(out)
			defer close(streamCtxDone)
			for {
				select {
				case l := <-lineCh:
					select {
					case out <- l:
					case <-ctx.Done():
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
		return out, nil
	}

	panelSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(panelSrv.Close)

	req, err := http.NewRequest(http.MethodGet, panelSrv.URL+"/api/events/logs?service=telemt", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}

	frames := readSSEFrames(resp.Body)

	lineCh <- host.LogLine{Level: "info", Unit: "telemt", Msg: "first line"}
	frame := nextFrame(t, frames, 2*time.Second)
	if frame.event != "log" || !strings.Contains(frame.data, "first line") {
		t.Fatalf("frame = %+v, want an event:log frame carrying 'first line'", frame)
	}

	resp.Body.Close()

	select {
	case <-streamCtxDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Stream's context was never canceled after the client disconnected")
	}
}

// TestHandleEventsLogs_HeartbeatIsObservableEvent covers backlog item 5's
// heartbeat reconciliation for the log-stream SSE handler specifically —
// it must stay consistent with handleEvents (sse.go), both now emitting the
// spec's `event: heartbeat` / `data: {}` frame instead of the old `: hb`
// comment a client couldn't observe at all.
func TestHandleEventsLogs_HeartbeatIsObservableEvent(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanStream: true}
	srv.logStreamHeartbeat = 15 * time.Millisecond

	logSrc.StreamFunc = func(ctx context.Context, service string) (<-chan host.LogLine, error) {
		out := make(chan host.LogLine)
		go func() {
			defer close(out)
			<-ctx.Done() // never sends a line — only heartbeats should flow
		}()
		return out, nil
	}

	panelSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(panelSrv.Close)

	req, err := http.NewRequest(http.MethodGet, panelSrv.URL+"/api/events/logs?service=telemt", nil)
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

	frame := nextFrame(t, readSSEFrames(resp.Body), 2*time.Second)
	if frame.event != "heartbeat" || frame.data != "{}" {
		t.Fatalf("frame = %+v, want event:heartbeat data:{}", frame)
	}
}

func TestHandleEventsLogs_StreamStartErrorReturns502(t *testing.T) {
	srv, cookie, _, logSrc := newHostTestServer(t)
	logSrc.CapsValue = host.LogCaps{CanStream: true}
	logSrc.StreamErr = errors.New("logread: not found")

	r := httptest.NewRequest("GET", "/api/events/logs?service=telemt", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

// TestServer_Run_ShutsDownPromptlyWithAnOpenLogStream mirrors
// server_test.go's TestRunShutsDownPromptlyWithAnOpenSSEClient for the log
// stream's own shutdown hook (server.go registers logStreams.Close
// alongside hub.Close): an open GET /api/events/logs client must not stall
// Shutdown waiting for it to disconnect on its own — the fake Stream here
// only ever closes its channel when its ctx is canceled, so if the
// registry's Close didn't cancel it, Run would hang until srv.Run's own
// 10s Shutdown deadline instead of returning promptly.
func TestServer_Run_ShutsDownPromptlyWithAnOpenLogStream(t *testing.T) {
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
	tc := telemt.New("http://127.0.0.1:1", "")
	hb := hub.New(hub.Config{}, tc, st)
	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)

	logSrc := &hosttest.LogSource{CapsValue: host.LogCaps{CanStream: true}}
	logSrc.StreamFunc = func(ctx context.Context, service string) (<-chan host.LogLine, error) {
		out := make(chan host.LogLine)
		go func() {
			<-ctx.Done()
			close(out)
		}()
		return out, nil
	}
	srv.logSrc = logSrc

	_, cookie := login(t, srv.Handler(), "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() { runDone <- srv.Run(ctx) }()
	waitForListener(t, addr)

	req, err := http.NewRequest(http.MethodGet, "http://"+addr+"/api/events/logs?service=telemt", nil)
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

	start := time.Now()
	cancel()

	select {
	case runErr := <-runDone:
		if runErr != nil {
			t.Fatalf("Run returned %v, want nil", runErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return within 2s of the shutdown signal — the open log stream stalled it")
	}
	if elapsed := time.Since(start); elapsed >= 9*time.Second {
		t.Fatalf("Run took %s to return, want well under the 10s shutdown deadline", elapsed)
	}
}
