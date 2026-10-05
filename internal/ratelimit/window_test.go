package ratelimit

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWindowRateLimitConcurrentReservations(t *testing.T) {
	w := New(5, time.Minute, time.Now)
	t.Cleanup(w.Close)
	start, release := make(chan struct{}), make(chan struct{})
	var ready, admitted sync.WaitGroup
	ready.Add(20)
	admitted.Add(20)
	var checks atomic.Int32
	var workers sync.WaitGroup
	workers.Add(20)
	for range 20 {
		go func() {
			defer workers.Done()
			ready.Done()
			<-start
			finish, ok := w.TryReserve("ip")
			if ok {
				checks.Add(1)
			}
			admitted.Done()
			<-release
			if ok {
				finish(true)
				finish(false)
			}
		}()
	}
	ready.Wait()
	close(start)
	admitted.Wait()
	if checks.Load() != 5 || w.Available("ip") || !w.Available("other") {
		t.Errorf("admitted checks = %d, available = %v", checks.Load(), w.Available("ip"))
	}
	close(release)
	workers.Wait()
	if w.Available("ip") {
		t.Fatal("double finish released recorded failures")
	}
}

func TestWindowRateLimitFinishExpiryAndCleanup(t *testing.T) {
	now := time.Unix(1000, 0)
	w := New(1, time.Minute, func() time.Time { return now })
	t.Cleanup(w.Close)
	finish, ok := w.TryReserve("ip")
	if !ok {
		t.Fatal("first reservation denied")
	}
	now = now.Add(2 * time.Minute)
	w.mu.Lock()
	w.pruneLocked("ip")
	w.mu.Unlock()
	if w.Available("ip") {
		t.Fatal("inflight reservation expired before credential check finished")
	}
	finish(false)
	finish(true)
	if !w.Available("ip") {
		t.Fatal("successful check consumed a failure")
	}
	finish, _ = w.TryReserve("ip")
	finish(true)
	now = now.Add(time.Minute)
	if !w.Available("ip") {
		t.Fatal("failure did not expire at window boundary")
	}
	if !w.AllowAndCount("ip") || w.AllowAndCount("ip") {
		t.Fatal("request counting is not atomic")
	}
	w.Close()
	w.Close()
	if w.Available("other") {
		t.Fatal("closed window admits requests")
	}
}
