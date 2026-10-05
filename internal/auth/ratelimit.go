package auth

import (
	"github.com/amirotin/telemt_panel/internal/ratelimit"
	"time"
)

const (
	loginFailureLimit  = 5
	loginFailureWindow = time.Minute
)

// Limiter counts failed login checks and checks still in flight per IP.
type Limiter struct{ window *ratelimit.Window }

// NewLimiter starts the login admission window.
func NewLimiter() *Limiter { return newLimiter(time.Now) }

func newLimiter(now func() time.Time) *Limiter {
	return &Limiter{window: ratelimit.New(loginFailureLimit, loginFailureWindow, now)}
}

// Allow checks capacity without consuming it, for WebAuthn begin.
func (l *Limiter) Allow(ip string) bool { return l.window.Available(ip) }

// Acquire reserves capacity until the credential check finishes.
func (l *Limiter) Acquire(ip string) (func(bool), bool) { return l.window.TryReserve(ip) }

// RecordFailure records a completed legacy check. New callers use Acquire.
func (l *Limiter) RecordFailure(ip string) { l.window.AllowAndCount(ip) }

// Stop stops admission and synchronously releases the cleanup loop.
func (l *Limiter) Stop() { l.window.Close() }
