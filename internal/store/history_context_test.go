package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTrafficReadOperationDeadline(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := m.BeginTrafficRead(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	r := raw.(*memoryTrafficReadSnapshot)
	deadline, ok := r.ctx.Deadline()
	if !ok || time.Until(deadline) > 10*time.Second {
		t.Fatal("traffic read lacks bounded operation deadline")
	}
}

func TestMemoryHistoryReadCallerCancellationDuringLock(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		r, err := m.BeginTrafficRead(ctx)
		if r != nil {
			r.Close()
		}
		done <- err
	}()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		m.mu.Unlock()
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel error=%v", err)
		}
	case <-time.After(100 * time.Millisecond):
		m.mu.Unlock()
		<-done
		t.Fatal("canceled Memory read stayed blocked on mutex")
	}
}

func TestHistoryOperationPreservesCallerDeadline(t *testing.T) {
	parent, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ctx, done := historyOperationContext(parent)
	defer done()
	first, _ := parent.Deadline()
	second, _ := ctx.Deadline()
	if !first.Equal(second) {
		t.Fatalf("shorter deadline changed: parent=%s history=%s", first, second)
	}
	cancel()
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatal("caller cancellation was lost")
	}
}

func TestMemoryHistoryContextRejectsCancelledMutations(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := m.RecordMetricsContext(ctx, []NamedMetricPoint{{Name: "connections", Point: MetricPoint{TS: 1, Value: 1}}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("record=%v", err)
	}
	if err := m.AppendHistoryEventContext(ctx, HistoryEvent{Kind: "safe"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("event=%v", err)
	}
	if _, err := m.ApplyUserTrafficSnapshotContext(ctx, UserTrafficSnapshot{ObservedAt: 100, SourceStartedAt: 1, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "alice", RawOctets: 100}}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("traffic=%v", err)
	}
	if len(m.metrics) != 0 || len(m.events) != 0 || len(m.userTraffic) != 0 {
		t.Fatal("canceled mutation changed history")
	}
}
