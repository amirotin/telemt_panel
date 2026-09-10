package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// serverLogWriter bounds handshake noise without hiding unrelated server errors.
type serverLogWriter struct {
	mu            sync.Mutex
	lastHandshake time.Time
}

func (w *serverLogWriter) Write(p []byte) (int, error) {
	message := strings.TrimSpace(string(p))
	if strings.HasPrefix(message, "http: TLS handshake error") {
		w.mu.Lock()
		if time.Since(w.lastHandshake) < time.Minute {
			w.mu.Unlock()
			return len(p), nil
		}
		w.lastHandshake = time.Now()
		w.mu.Unlock()
	}
	slog.Warn(message)
	return len(p), nil
}

// serveListeners binds every required port before accepting application requests.
// A failed challenge listener must not leave a seemingly successful TLS startup.
func serveListeners(ctx context.Context, main, challenge *http.Server, additional ...*http.Server) error {
	servers := []*http.Server{main}
	if challenge != nil {
		servers = append(servers, challenge)
	}
	for _, srv := range additional {
		if srv != nil {
			servers = append(servers, srv)
		}
	}
	listeners := make([]net.Listener, 0, len(servers))
	defer func() {
		for _, srv := range servers {
			_ = srv.Close()
		}
		for _, ln := range listeners {
			_ = ln.Close()
		}
	}()
	for _, srv := range servers {
		if srv.TLSConfig != nil && srv.ErrorLog == nil {
			srv.ErrorLog = log.New(&serverLogWriter{}, "", 0)
		}
		ln, err := net.Listen("tcp", srv.Addr)
		if err != nil {
			purpose := "panel"
			if srv == challenge {
				purpose = "ACME HTTP-01 (public port 80)"
			} else if srv != main {
				purpose = "subscription"
			}
			return fmt.Errorf("listen %s at %s: check port conflicts and service user bind permissions: %w", purpose, srv.Addr, err)
		}
		listeners = append(listeners, ln)
	}
	// net/http may initialize TLSConfig even in Serve; do not read it after starting goroutines.
	scheme := "http"
	if main.TLSConfig != nil {
		scheme = "https"
	}
	errCh := make(chan error, len(servers))
	for i, srv := range servers {
		ln := listeners[i]
		go func() {
			if srv.TLSConfig != nil {
				errCh <- srv.ServeTLS(ln, "", "")
			} else {
				errCh <- srv.Serve(ln)
			}
		}()
	}
	slog.Info("panel listener started", "addr", main.Addr, "transport", scheme)
	select {
	case err := <-errCh:
		if err == nil {
			err = errors.New("listener stopped unexpectedly")
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var result error
		for _, srv := range servers {
			result = errors.Join(result, srv.Shutdown(shutdownCtx))
		}
		// Close forces completion if draining exceeded its deadline.
		for _, srv := range servers {
			_ = srv.Close()
		}
		for range servers {
			<-errCh
		}
		return result
	}
}
