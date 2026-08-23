package subpage

import (
	"sync"
	"time"
)

// requestLimit and requestWindow implement the brief's "30 req/min per
// client IP over /sub/*" rate limit.
const (
	requestLimit    = 30
	requestWindow   = time.Minute
	cleanupInterval = time.Minute
)

// RateLimiter caps the request rate per client IP to /sub/*. It follows
// the same injectable-clock/owned-cleanup-goroutine/Stop shape as
// auth.Limiter, but its semantics differ: every request counts toward the
// limit (auth.Limiter only counts login failures), since /sub/* has no
// separate notion of a "failed" request to gate on.
type RateLimiter struct {
	now func() time.Time

	mu       sync.Mutex
	requests map[string][]time.Time

	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}
}

// NewRateLimiter creates a RateLimiter and starts its cleanup goroutine.
func NewRateLimiter() *RateLimiter {
	return newRateLimiter(time.Now)
}

// newRateLimiter is the injectable-clock constructor used by tests to
// exercise the sliding window without sleeping.
func newRateLimiter(now func() time.Time) *RateLimiter {
	l := &RateLimiter{
		now:      now,
		requests: make(map[string][]time.Time),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go l.cleanupLoop()
	return l
}

// Allow reports whether ip is currently under the request limit and, if
// so, records this request toward it.
func (l *RateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	recent := l.recentLocked(ip)
	if len(recent) >= requestLimit {
		return false
	}
	l.requests[ip] = append(recent, l.now())
	return true
}

// recentLocked returns ip's request timestamps still within the window,
// pruning older ones in place. Callers must hold l.mu.
func (l *RateLimiter) recentLocked(ip string) []time.Time {
	cutoff := l.now().Add(-requestWindow)
	kept := l.requests[ip][:0]
	for _, t := range l.requests[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.requests, ip)
		return nil
	}
	l.requests[ip] = kept
	return kept
}

// cleanupLoop periodically prunes stale per-IP request history so IPs
// that stop requesting don't linger in memory forever.
func (l *RateLimiter) cleanupLoop() {
	defer close(l.done)
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-l.stop:
			return
		case <-ticker.C:
			l.mu.Lock()
			for ip := range l.requests {
				l.recentLocked(ip)
			}
			l.mu.Unlock()
		}
	}
}

// Stop terminates the cleanup goroutine and waits for it to exit. Safe to
// call more than once and safe to call from server shutdown.
func (l *RateLimiter) Stop() {
	l.stopOnce.Do(func() { close(l.stop) })
	<-l.done
}
