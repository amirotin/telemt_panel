package store

import (
	"container/heap"
	"context"
	"errors"
	"sort"
	"time"
)

func lockSnapshot(ctx context.Context, try func() bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if try() {
		return nil
	}
	delay := time.Millisecond
	timer := time.NewTimer(delay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if try() {
				return nil
			}
			delay = min(delay*2, 50*time.Millisecond)
			timer.Reset(delay)
		}
	}
}

// UserIPReadSnapshot owns a bounded copy of records and their collection metadata.
type UserIPReadSnapshot struct {
	Records            []UserIPRecord
	Collection         UserIPCollection
	Retention          time.Duration
	Durable, Truncated bool
	// Partial reports ordinary history writes overlapping a paged read.
	Partial bool
	Epoch   uint64
}

func validateSnapshotRange(from, now int64) error {
	if from < 0 || now <= 0 || from > now {
		return errors.New("invalid IP snapshot range")
	}
	return nil
}

func recordBefore(a, b UserIPRecord) bool {
	if a.Username != b.Username {
		return a.Username < b.Username
	}
	return a.IP < b.IP
}

type userIPMaxHeap []UserIPRecord

func (h userIPMaxHeap) Len() int           { return len(h) }
func (h userIPMaxHeap) Less(i, j int) bool { return recordNewer(h[j], h[i]) }
func (h userIPMaxHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *userIPMaxHeap) Push(x any)        { *h = append(*h, x.(UserIPRecord)) }
func (h *userIPMaxHeap) Pop() any          { old := *h; x := old[len(old)-1]; *h = old[:len(old)-1]; return x }

func recordNewer(a, b UserIPRecord) bool {
	if a.Last != b.Last {
		return a.Last > b.Last
	}
	return recordBefore(a, b)
}

// ReadUserIPSnapshot copies history under one lock without calling enrichment.
func (m *Memory) ReadUserIPSnapshot(ctx context.Context, from, now int64) (UserIPReadSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return UserIPReadSnapshot{}, err
	}
	if err := validateSnapshotRange(from, now); err != nil {
		return UserIPReadSnapshot{}, err
	}
	if err := lockSnapshot(ctx, m.mu.TryLock); err != nil {
		return UserIPReadSnapshot{}, err
	}
	defer m.mu.Unlock()
	out := UserIPReadSnapshot{Collection: m.userIPCollection, Retention: m.UserIPRetention(), Epoch: m.userIPEpoch.Load()}
	from = max(from, now-int64(out.Retention/time.Second))
	records := make(userIPMaxHeap, 0, min(len(m.userIPs), UserIPMemoryLimit+1))
	for _, r := range m.userIPs {
		if err := ctx.Err(); err != nil {
			return UserIPReadSnapshot{}, err
		}
		if r.Last > now {
			out.Collection.Gap = true
			continue
		}
		if r.Last < from {
			continue
		}
		if len(records) < UserIPMemoryLimit+1 {
			heap.Push(&records, r)
		} else if recordNewer(r, records[0]) {
			records[0] = r
			heap.Fix(&records, 0)
		}
	}
	out.Truncated = len(records) > UserIPMemoryLimit
	if out.Truncated {
		heap.Pop(&records)
	}
	sort.Slice(records, func(i, j int) bool { return recordBefore(records[i], records[j]) })
	out.Records = []UserIPRecord(records)
	return out, ctx.Err()
}

// UserIPEpoch identifies successful mutations that revoke retained projections.
func (m *Memory) UserIPEpoch() uint64 { return m.userIPEpoch.Load() }

// ReadUserIPSnapshot delegates to the active history backend.
func (s *Composite) ReadUserIPSnapshot(ctx context.Context, from, now int64) (UserIPReadSnapshot, error) {
	return s.history.ReadUserIPSnapshot(ctx, from, now)
}

// UserIPEpoch delegates the history mutation barrier.
func (s *Composite) UserIPEpoch() uint64 { return s.history.UserIPEpoch() }
