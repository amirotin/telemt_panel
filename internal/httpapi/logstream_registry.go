package httpapi

import (
	"context"
	"sync"
)

// logStreamRegistry tracks the cancel funcs of active GET /api/events/logs
// requests so server shutdown can end them immediately, the same way
// hub.Close ends /api/events streams (see server.go's Run doc comment) —
// without this, http.Server.Shutdown would wait for each log stream's
// client to disconnect on its own, up to its own shutdown deadline.
type logStreamRegistry struct {
	mu     sync.Mutex
	nextID int
	active map[int]context.CancelFunc
	closed bool
}

// newLogStreamRegistry builds an empty, open logStreamRegistry.
func newLogStreamRegistry() *logStreamRegistry {
	return &logStreamRegistry{active: make(map[int]context.CancelFunc)}
}

// register adds cancel to the set Close cancels. If the registry is
// already closed (shutdown started after this stream's context was
// created but before it got here), cancel runs immediately instead of
// being tracked. The returned deregister func must be called once the
// stream ends on its own, so a long-lived server doesn't accumulate
// entries for connections that already closed normally.
func (l *logStreamRegistry) register(cancel context.CancelFunc) (deregister func()) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		cancel()
		return func() {}
	}
	id := l.nextID
	l.nextID++
	l.active[id] = cancel
	return func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		delete(l.active, id)
	}
}

// Close cancels every currently active stream and marks the registry
// closed, so any stream that registers afterward is canceled immediately
// too. Idempotent, matching hub.Close's shutdown-time semantics (this is
// itself called from a deferred call and a shutdown hook — see server.go).
func (l *logStreamRegistry) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	l.closed = true
	for _, cancel := range l.active {
		cancel()
	}
}
