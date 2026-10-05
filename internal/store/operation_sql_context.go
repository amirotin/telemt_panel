//go:build !lite

package store

import (
	"context"
	"errors"
	"sync"
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
