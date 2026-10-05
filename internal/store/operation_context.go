package store

import (
	"context"
	"errors"
	"sync"
	"time"
)

type historyReadMutex struct{ mu *sync.RWMutex }

func (m historyReadMutex) TryLock() bool { return m.mu.TryRLock() }
func (m historyReadMutex) Unlock()       { m.mu.RUnlock() }

func historyContextError(ctx context.Context, err error) error {
	if err != nil && ctx.Err() != nil {
		return errors.Join(err, ctx.Err())
	}
	return err
}

const historyOperationTimeout = 10 * time.Second

func historyOperationContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, historyOperationTimeout)
}

// Avoid making cancellation wait for a history lock held by a blocked writer.
// The uncontended path allocates no timer.
func lockHistoryMutex(ctx context.Context, mu interface {
	TryLock() bool
	Unlock()
}) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if mu.TryLock() {
		if err := ctx.Err(); err != nil {
			mu.Unlock()
			return err
		}
		return nil
	}
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
		if mu.TryLock() {
			if err := ctx.Err(); err != nil {
				mu.Unlock()
				return err
			}
			return nil
		}
	}
}
