package subpage

import (
	"github.com/amirotin/telemt_panel/internal/ratelimit"
	"time"
)

const (
	requestLimit  = 30
	requestWindow = time.Minute
)

// RateLimiter counts every admitted subscription request per IP.
type RateLimiter struct{ window *ratelimit.Window }

// NewRateLimiter starts the request admission window.
func NewRateLimiter() *RateLimiter { return newRateLimiter(time.Now) }

func newRateLimiter(now func() time.Time) *RateLimiter {
	return &RateLimiter{window: ratelimit.New(requestLimit, requestWindow, now)}
}

// Allow atomically admits and counts a request.
func (l *RateLimiter) Allow(ip string) bool { return l.window.AllowAndCount(ip) }

// Stop stops admission and synchronously releases the cleanup loop.
func (l *RateLimiter) Stop() { l.window.Close() }
