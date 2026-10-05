package httpapi

import (
	"context"
	"errors"
	"sync"
)

// ErrLogStreamLimit means process or session log-stream capacity is exhausted.
var ErrLogStreamLimit = errors.New("log stream limit reached")
var errLogStreamsClosed = errors.New("log streams are closed")

type logStreamRegistration struct {
	session string
	cancel  context.CancelFunc
}

// logStreamRegistry tracks the cancel funcs of active GET /api/events/logs
// requests so server shutdown can end them immediately, the same way
// hub.Close ends /api/events streams (see server.go's Run doc comment) —
// without this, http.Server.Shutdown would wait for each log stream's
// client to disconnect on its own, up to its own shutdown deadline.
type logStreamRegistry struct {
	mu         sync.Mutex
	nextID     int
	active     map[int]logStreamRegistration
	perSession map[string]int
	closed     bool
}

// newLogStreamRegistry builds an empty, open logStreamRegistry.
func newLogStreamRegistry() *logStreamRegistry {
	return &logStreamRegistry{active: make(map[int]logStreamRegistration), perSession: make(map[string]int)}
}

func logStreamSessionKey(hash string) string {
	if hash == "" {
		return "anonymous"
	}
	return hash
}

func (l *logStreamRegistry) capacityErrorLocked(key string) error {
	if l.closed {
		return errLogStreamsClosed
	}
	if len(l.active) >= 4 || l.perSession[key] >= 2 {
		return ErrLogStreamLimit
	}
	return nil
}

func (l *logStreamRegistry) capacityError(hash string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.capacityErrorLocked(logStreamSessionKey(hash))
}

// TryRegister atomically admits a source before response headers or processes.
func (l *logStreamRegistry) TryRegister(hash string, cancel context.CancelFunc) (func(), error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := logStreamSessionKey(hash)
	if err := l.capacityErrorLocked(key); err != nil {
		return nil, err
	}
	id := l.nextID
	l.nextID++
	l.active[id] = logStreamRegistration{key, cancel}
	l.perSession[key]++
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			if _, exists := l.active[id]; !exists {
				return
			}
			delete(l.active, id)
			l.perSession[key]--
			if l.perSession[key] == 0 {
				delete(l.perSession, key)
			}
		})
	}, nil
}

// Close cancels every currently active stream and marks the registry
// closed, so any stream that registers afterward is canceled immediately
// too. Idempotent, matching hub.Close's shutdown-time semantics (this is
// itself called from a deferred call and a shutdown hook — see server.go).
func (l *logStreamRegistry) Close() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	active := l.active
	l.active = make(map[int]logStreamRegistration)
	clear(l.perSession)
	l.mu.Unlock()
	for _, registration := range active {
		registration.cancel()
	}
}
