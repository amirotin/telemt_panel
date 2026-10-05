package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMemoryUserIPHistoryCancelsWhileLocked(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := m.UserIPHistoryContext(ctx, UserIPQuery{Username: "alice", Now: time.Now().Unix(), Limit: 50})
		done <- err
	}()
	cancel()
	select {
	case err := <-done:
		m.mu.Unlock()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation = %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		m.mu.Unlock()
		<-done
		t.Fatal("IP history cancellation waited for the memory store lock")
	}
}
