package auth

import (
	"sync"
	"time"
)

// loginFailureLimit and loginFailureWindow implement the brief's "5
// failures/min per client IP" login rate limit.
const (
	loginFailureLimit  = 5
	loginFailureWindow = time.Minute
	cleanupInterval    = time.Minute
)

// Limiter tracks recent login failures per client IP for the login rate
// limit. It owns a background goroutine that periodically evicts stale
// entries so long-running processes don't accumulate one entry per IP
// forever; Stop must be called to release it.
type Limiter struct {
	now func() time.Time

	mu       sync.Mutex
	failures map[string][]time.Time

	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}
}

// NewLimiter creates a Limiter and starts its cleanup goroutine.
func NewLimiter() *Limiter {
	return newLimiter(time.Now)
}

// newLimiter is the injectable-clock constructor used by tests to exercise
// the sliding window without sleeping.
func newLimiter(now func() time.Time) *Limiter {
	l := &Limiter{
		now:      now,
		failures: make(map[string][]time.Time),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go l.cleanupLoop()
	return l
}

// Allow reports whether ip is currently under the failure limit, i.e.
// whether a login attempt from it should proceed to credential checking.
func (l *Limiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.recentLocked(ip)) < loginFailureLimit
}

// RecordFailure records a login failure from ip, counting toward the
// failure limit.
func (l *Limiter) RecordFailure(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures[ip] = append(l.recentLocked(ip), l.now())
}

// recentLocked returns ip's failure timestamps still within the window,
// pruning older ones in place. Callers must hold l.mu.
func (l *Limiter) recentLocked(ip string) []time.Time {
	cutoff := l.now().Add(-loginFailureWindow)
	kept := l.failures[ip][:0]
	for _, t := range l.failures[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.failures, ip)
		return nil
	}
	l.failures[ip] = kept
	return kept
}

// cleanupLoop periodically prunes stale per-IP failure history so IPs that
// stop attempting logins don't linger in memory forever.
func (l *Limiter) cleanupLoop() {
	defer close(l.done)
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-l.stop:
			return
		case <-ticker.C:
			l.mu.Lock()
			for ip := range l.failures {
				l.recentLocked(ip)
			}
			l.mu.Unlock()
		}
	}
}

// Stop terminates the cleanup goroutine and waits for it to exit. Safe to
// call more than once and safe to call from server shutdown.
func (l *Limiter) Stop() {
	l.stopOnce.Do(func() { close(l.stop) })
	<-l.done
}
