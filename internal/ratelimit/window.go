// Package ratelimit provides atomic sliding-window admission policies.
package ratelimit

import (
	"sync"
	"time"
)

type entry struct {
	counts   []time.Time
	inflight int
}

// Window counts recent failures or requests together with active reservations.
type Window struct {
	mu        sync.Mutex
	entries   map[string]*entry
	limit     int
	window    time.Duration
	now       func() time.Time
	closed    bool
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

// New starts a window with an owned cleanup loop. Close releases the loop.
func New(limit int, window time.Duration, now func() time.Time) *Window {
	if limit <= 0 || window <= 0 {
		panic("ratelimit: invalid window")
	}
	if now == nil {
		now = time.Now
	}
	w := &Window{entries: make(map[string]*entry), limit: limit, window: window, now: now, stop: make(chan struct{}), done: make(chan struct{})}
	go w.cleanup()
	return w
}

func (w *Window) pruneLocked(key string) *entry {
	e := w.entries[key]
	if e == nil {
		return nil
	}
	cutoff := w.now().Add(-w.window)
	kept := e.counts[:0]
	for _, stamp := range e.counts {
		if stamp.After(cutoff) {
			kept = append(kept, stamp)
		}
	}
	e.counts = kept
	if len(kept) == 0 && e.inflight == 0 {
		delete(w.entries, key)
		return nil
	}
	return e
}

func (w *Window) availableLocked(key string) bool {
	e := w.pruneLocked(key)
	return !w.closed && (e == nil || len(e.counts)+e.inflight < w.limit)
}

func (w *Window) entryLocked(key string) *entry {
	e := w.entries[key]
	if e == nil {
		e = &entry{}
		w.entries[key] = e
	}
	return e
}

// Available checks capacity without consuming a slot.
func (w *Window) Available(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.availableLocked(key)
}

// TryReserve admits a check atomically. Finish must run only after the actual
// check ends, even if its caller has been cancelled. It is safe to call twice.
func (w *Window) TryReserve(key string) (finish func(bool), ok bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.availableLocked(key) {
		return nil, false
	}
	e := w.entryLocked(key)
	e.inflight++
	var once sync.Once
	return func(failed bool) {
		once.Do(func() {
			w.mu.Lock()
			defer w.mu.Unlock()
			e.inflight--
			if failed {
				e.counts = append(e.counts, w.now())
			}
			w.pruneLocked(key)
		})
	}, true
}

// AllowAndCount atomically admits and records every request.
func (w *Window) AllowAndCount(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.availableLocked(key) {
		return false
	}
	e := w.entryLocked(key)
	e.counts = append(e.counts, w.now())
	return true
}

func (w *Window) cleanup() {
	defer close(w.done)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-ticker.C:
			w.mu.Lock()
			for key := range w.entries {
				w.pruneLocked(key)
			}
			w.mu.Unlock()
		}
	}
}

// Close stops admission and synchronously releases the cleanup loop.
func (w *Window) Close() {
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closed = true
		w.mu.Unlock()
		close(w.stop)
	})
	<-w.done
}
