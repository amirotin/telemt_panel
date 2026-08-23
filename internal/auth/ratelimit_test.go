package auth

import (
	"testing"
	"time"
)

// clock is a manually advanced time source for deterministic rate-limiter
// tests — no sleeps.
type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func TestLimiterAllowsUnderLimit(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	l := newLimiter(c.now)
	defer l.Stop()

	for i := 0; i < loginFailureLimit; i++ {
		if !l.Allow("1.2.3.4") {
			t.Fatalf("Allow() = false before %d failures recorded", i)
		}
		l.RecordFailure("1.2.3.4")
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("Allow() = true after 5 failures, want false")
	}
}

func TestLimiterPerIPIsolation(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	l := newLimiter(c.now)
	defer l.Stop()

	for i := 0; i < loginFailureLimit; i++ {
		l.RecordFailure("1.2.3.4")
	}
	if !l.Allow("5.6.7.8") {
		t.Fatal("failures against one IP must not rate-limit another")
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("1.2.3.4 should still be limited")
	}
}

func TestLimiterWindowSlides(t *testing.T) {
	c := &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	l := newLimiter(c.now)
	defer l.Stop()

	for i := 0; i < loginFailureLimit; i++ {
		l.RecordFailure("1.2.3.4")
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("expected limited immediately after 5 failures")
	}

	c.advance(loginFailureWindow + time.Second)
	if !l.Allow("1.2.3.4") {
		t.Fatal("expected allowed once the failure window has fully elapsed")
	}
}

func TestLimiterStopIsIdempotentAndSynchronous(t *testing.T) {
	l := NewLimiter()
	l.Stop()
	l.Stop() // must not hang or panic on a second call
}
