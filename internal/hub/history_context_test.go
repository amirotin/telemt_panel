package hub

import (
	"context"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

type lifecycleHistoryStore struct {
	store.HistoryStore
	contexts []context.Context
}

func (s *lifecycleHistoryStore) RecordMetricsContext(ctx context.Context, points []store.NamedMetricPoint) error {
	s.contexts = append(s.contexts, ctx)
	return s.HistoryStore.RecordMetricsContext(ctx, points)
}
func (s *lifecycleHistoryStore) AppendHistoryEventContext(ctx context.Context, event store.HistoryEvent) error {
	s.contexts = append(s.contexts, ctx)
	return s.HistoryStore.AppendHistoryEventContext(ctx, event)
}
func (s *lifecycleHistoryStore) ApplyUserIPBatchContext(ctx context.Context, batch store.UserIPBatch) error {
	s.contexts = append(s.contexts, ctx)
	return s.HistoryStore.ApplyUserIPBatchContext(ctx, batch)
}

func TestHistoryCollectorUsesLifecycleAndFreshFinalFlushContexts(t *testing.T) {
	m, err := store.NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	st := &lifecycleHistoryStore{HistoryStore: m}
	h := New(Config{}, nil, st)
	h.recordStatsHistory(statsSnapshot{})
	h.appendHistoryTransition(store.HistoryEvent{Kind: "safe"})
	if len(st.contexts) != 2 || st.contexts[0] != h.ctx || st.contexts[1] != h.ctx {
		t.Fatalf("collector contexts=%+v", st.contexts)
	}
	h.cancel()
	before, _ := m.ListHistoryEvents(store.HistoryEventFilter{})
	if h.appendHistoryTransition(store.HistoryEvent{Kind: "after-cancel"}) {
		t.Fatal("canceled lifecycle accepted an event")
	}
	after, _ := m.ListHistoryEvents(store.HistoryEventFilter{})
	if len(after) != len(before) {
		t.Fatal("shutdown advanced event history")
	}
	now := time.Now().Unix()
	h.ips.through = now
	h.ips.pending = map[observedIPKey]store.UserIPRecord{{"alice", "1.1.1.1"}: {Username: "alice", IP: "1.1.1.1", Family: 4, First: now, Last: now, Observations: 1, Source: 1}}
	h.flushUserIPs()
	flush := st.contexts[len(st.contexts)-1]
	if flush.Err() != context.Canceled {
		t.Fatal("final flush scope was not released")
	}
	collection, err := m.UserIPCollectionState()
	if err != nil || collection.Through != now {
		t.Fatalf("final flush used canceled lifecycle: %+v %v", collection, err)
	}
	h.Close()
}
