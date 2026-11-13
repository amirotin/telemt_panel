package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

type blockingSessionDeadlineWriter struct {
	*httptest.ResponseRecorder
	started chan time.Time
	resume  chan struct{}
}

func (w *blockingSessionDeadlineWriter) SetWriteDeadline(deadline time.Time) error {
	w.started <- deadline
	<-w.resume
	return nil
}

func TestSessionStreamReleaseWaitsForDeadlineCallback(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := &Server{cfg: &config.Config{Auth: config.AuthConfig{Disabled: true}}}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		w := &blockingSessionDeadlineWriter{
			ResponseRecorder: httptest.NewRecorder(),
			started:          make(chan time.Time),
			resume:           make(chan struct{}),
		}
		_, release, ok := srv.trackSessionStream(w, httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/events", nil))
		if !ok {
			t.Fatal("stream registration failed")
		}
		cancel()
		if deadline := <-w.started; deadline.After(time.Now()) {
			t.Error("cancellation must immediately interrupt blocked writes")
		}
		released := make(chan struct{})
		go func() {
			release()
			close(released)
		}()
		synctest.Wait()
		select {
		case <-released:
			t.Error("release returned while the deadline callback still uses the response writer")
		default:
		}
		close(w.resume)
		<-released
		release()
	})
}

func TestSessionStreamReleaseStopsDeadlineCallback(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := &Server{cfg: &config.Config{Auth: config.AuthConfig{Disabled: true}}}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		w := &blockingSessionDeadlineWriter{
			ResponseRecorder: httptest.NewRecorder(),
			started:          make(chan time.Time, 1),
			resume:           make(chan struct{}),
		}
		close(w.resume)
		stream, release, ok := srv.trackSessionStream(w, httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/events", nil))
		if !ok {
			t.Fatal("stream registration failed")
		}
		release()
		release()
		cancel()
		synctest.Wait()
		if stream.ctx.Err() == nil {
			t.Error("release did not cancel the stream")
		}
		select {
		case <-w.started:
			t.Error("deadline callback ran after the stream was released")
		default:
		}
	})
}

func TestSessionStreamHTTP2Cancellation(t *testing.T) {
	srv, cookie := newSSETestServer(t, telemt.New("http://127.0.0.1:1", ""), hub.Config{Heartbeat: time.Hour})
	handler := srv.Handler()
	finished := make(chan struct{}, 1)
	panel := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		finished <- struct{}{}
	}))
	panel.EnableHTTP2 = true
	panel.StartTLS()
	defer panel.Close()
	client := panel.Client()
	client.Timeout = 5 * time.Second
	for i := 0; i < 32; i++ {
		ctx, cancel := context.WithCancel(t.Context())
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, panel.URL+"/api/events?topics=update", nil)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		req.AddCookie(cookie)
		response, err := client.Do(req)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK || response.ProtoMajor != 2 {
			cancel()
			response.Body.Close()
			t.Fatalf("stream status=%d protocol=%s", response.StatusCode, response.Proto)
		}
		if i == 31 {
			err = srv.sessions.Revoke(auth.HashToken(cookie.Value))
		} else {
			cancel()
		}
		_, readErr := io.Copy(io.Discard, response.Body)
		response.Body.Close()
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if timed, ok := readErr.(interface{ Timeout() bool }); ok && timed.Timeout() {
			t.Fatalf("stream did not close after cancellation: %v", readErr)
		}
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Fatal("HTTP/2 stream handler did not finish after cancellation")
		}
	}
}

func TestSessionStreamRevokeBeforeInitialFrames(t *testing.T) {
	tc := newFakeTelemtHTTP(t, []telemt.UserInfo{{Username: "protected"}})
	srv, cookie := newSSETestServer(t, tc, hub.Config{})
	srv.sseAfterSubscribeHook = func() {
		if err := srv.sessions.Revoke(auth.HashToken(cookie.Value)); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/api/events?topics=users", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "event: users") {
		t.Fatalf("revoked registration response=%d %s", w.Code, w.Body)
	}
}

func TestQuietSessionStreamExpiresWithoutTouch(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "")
	srv, cookie := newSSETestServer(t, tc, hub.Config{Heartbeat: time.Hour})
	srv.cfg.Auth.SessionTTL = "100ms"
	panel := httptest.NewServer(srv.Handler())
	defer panel.Close()
	req, _ := http.NewRequest(http.MethodGet, panel.URL+"/api/events?topics=update", nil)
	req.AddCookie(cookie)
	response, err := panel.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stream status=%d", response.StatusCode)
	}
	frames := readSSEFrames(response.Body)
	deadline := time.NewTimer(6 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case _, open := <-frames:
			if !open {
				return
			}
		case <-deadline.C:
			t.Fatal("quiet SSE continued beyond session expiry and idle check")
		}
	}
}
