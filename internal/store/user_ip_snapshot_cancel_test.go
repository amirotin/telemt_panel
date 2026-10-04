package store

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type checkedContext struct {
	context.Context
	once    sync.Once
	checked chan struct{}
}

func (c *checkedContext) Err() error {
	err := c.Context.Err()
	c.once.Do(func() { close(c.checked) })
	return err
}

func TestUserIPSnapshotCancelWhileWaiting(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	m.mu.Lock()
	locked := true
	defer func() {
		if locked {
			m.mu.Unlock()
		}
	}()
	raw, cancel := context.WithCancel(context.Background())
	ctx := &checkedContext{Context: raw, checked: make(chan struct{})}
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := m.ReadUserIPSnapshot(ctx, 0, 1800000000); done <- err }()
	<-ctx.checked
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel=%v", err)
		}
	case <-time.After(150 * time.Millisecond):
		m.mu.Unlock()
		locked = false
		<-done
		t.Fatal("snapshot read ignored cancellation while waiting for the store lock")
	}
}
