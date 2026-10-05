package auth

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

// ErrSessionExpired means a session cannot authorize further protected data.
var ErrSessionExpired = errors.New("session expired or revoked")

// SessionGuard coordinates durable revocation with active session streams.
type SessionGuard struct {
	mu      sync.Mutex
	st      store.StateStore
	ttl     func() time.Duration
	now     func() time.Time
	streams map[string]map[uint64]context.CancelFunc
	nextID  uint64
	closed  bool
}

// NewSessionGuard creates the shared authorization guard for HTTP and SSE.
func NewSessionGuard(st store.StateStore, ttl func() time.Duration, now func() time.Time) *SessionGuard {
	if now == nil {
		now = time.Now
	}
	return &SessionGuard{st: st, ttl: ttl, now: now, streams: make(map[string]map[uint64]context.CancelFunc)}
}

func (g *SessionGuard) cancelLocked(hash string) {
	for _, cancel := range g.streams[hash] {
		cancel()
	}
	delete(g.streams, hash)
}

func (g *SessionGuard) checkLocked(hash string) error {
	if g.closed {
		return ErrSessionExpired
	}
	session, ok, err := g.st.GetSession(hash)
	if err != nil {
		return err
	}
	if !ok {
		g.cancelLocked(hash)
		return ErrSessionExpired
	}
	if SessionExpired(g.now().Sub(session.LastSeen), g.ttl()) {
		// Expiry itself denies access even if opportunistic deletion fails.
		_ = g.st.DeleteSession(hash)
		g.cancelLocked(hash)
		return ErrSessionExpired
	}
	return nil
}

// Check validates current durable state and TTL without extending LastSeen.
func (g *SessionGuard) Check(hash string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.checkLocked(hash)
}

// Track registers a cancelable stream and closes the authorization/registration
// race. Release cancels and removes the registration exactly once.
func (g *SessionGuard) Track(parent context.Context, hash string) (context.Context, func(), error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if err := parent.Err(); err != nil {
		return nil, nil, err
	}
	if err := g.checkLocked(hash); err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	id := g.nextID
	g.nextID++
	if g.streams[hash] == nil {
		g.streams[hash] = make(map[uint64]context.CancelFunc)
	}
	g.streams[hash][id] = cancel
	if err := g.checkLocked(hash); err != nil {
		cancel()
		g.cancelLocked(hash)
		return nil, nil, err
	}
	var once sync.Once
	return ctx, func() {
		once.Do(func() {
			cancel()
			g.mu.Lock()
			defer g.mu.Unlock()
			delete(g.streams[hash], id)
			if len(g.streams[hash]) == 0 {
				delete(g.streams, hash)
			}
		})
	}, nil
}

// Revoke cancels streams only after the store confirms durable deletion.
func (g *SessionGuard) Revoke(hash string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if err := g.st.DeleteSession(hash); err != nil {
		return err
	}
	g.cancelLocked(hash)
	return nil
}

// RevokeOthers deletes and cancels other sessions under the registration lock.
// A new valid session registered after deletion remains valid.
func (g *SessionGuard) RevokeOthers(keep string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if err := g.st.DeleteOtherSessions(keep); err != nil {
		return err
	}
	for hash := range g.streams {
		if hash == keep {
			continue
		}
		// Login can create a new session while durable deletion completes.
		// Cancel only hashes no longer present in the confirmed store state.
		_, ok, err := g.st.GetSession(hash)
		if err != nil {
			return err
		}
		if !ok {
			g.cancelLocked(hash)
		}
	}
	return nil
}

// Close stops registration and cancels all streams. It is idempotent.
func (g *SessionGuard) Close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	for hash := range g.streams {
		g.cancelLocked(hash)
	}
}
