package subpage

import (
	"testing"
	"time"
)

func TestRateLimiterAllowsUpToLimit(t *testing.T) {
	now := time.Now()
	l := newRateLimiter(func() time.Time { return now })
	t.Cleanup(l.Stop)

	for i := 0; i < requestLimit; i++ {
		if !l.Allow("1.2.3.4") {
			t.Fatalf("request %d unexpectedly denied", i)
		}
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("request over the limit was allowed")
	}
}

func TestRateLimiterIsPerIP(t *testing.T) {
	now := time.Now()
	l := newRateLimiter(func() time.Time { return now })
	t.Cleanup(l.Stop)

	for i := 0; i < requestLimit; i++ {
		l.Allow("1.2.3.4")
	}
	if !l.Allow("5.6.7.8") {
		t.Fatal("a different IP was denied due to another IP's usage")
	}
}

func TestRateLimiterWindowSlides(t *testing.T) {
	now := time.Now()
	l := newRateLimiter(func() time.Time { return now })
	t.Cleanup(l.Stop)

	for i := 0; i < requestLimit; i++ {
		l.Allow("1.2.3.4")
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("expected the limit to be hit")
	}

	now = now.Add(requestWindow + time.Second)
	if !l.Allow("1.2.3.4") {
		t.Fatal("expected a fresh window to allow the request")
	}
}
