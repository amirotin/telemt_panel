package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestReplayByteBudgetEvictsOldestAcrossTopics(t *testing.T) {
	h := New(Config{ReplayRingSize: 8, ReplayMaxBytes: 7}, nil, nil)
	t.Cleanup(h.Close)

	h.recordFetchSuccess(h.topics["users"], json.RawMessage(`"old"`))
	h.recordFetchError(h.topics["stats"], errors.New("unavailable"))
	h.recordFetchSuccess(h.topics["update"], json.RawMessage(`"newer"`))

	if events, ok := h.ReplaySince(0, []string{"users", "stats", "update"}); ok || events != nil {
		t.Fatalf("ReplaySince(0) = (%+v, %v), want (nil, false) after byte eviction", events, ok)
	}

	events, ok := h.ReplaySince(1, []string{"users", "stats", "update"})
	if !ok {
		t.Fatal("ReplaySince(1): want ok=true at the last-evicted boundary")
	}
	if len(events) != 2 {
		t.Fatalf("ReplaySince(1) events = %+v, want the two retained events", events)
	}
	if events[0].Seq != 2 || events[0].Topic != "stats" || events[0].Err != sourceErrorCode || events[0].Data != nil {
		t.Fatalf("first retained event = %+v, want zero-data stats source_error at seq 2", events[0])
	}
	if events[1].Seq != 3 || events[1].Topic != "update" || !bytes.Equal(events[1].Data, []byte(`"newer"`)) {
		t.Fatalf("second retained event = %+v, want update seq 3 with the newest payload", events[1])
	}

	h.mu.Lock()
	gotBytes, gotCount := h.ringBytes, len(h.ring)
	h.mu.Unlock()
	if gotBytes != 7 || gotCount != 2 {
		t.Fatalf("retained ring = %d bytes in %d events, want 7 bytes in 2 events", gotBytes, gotCount)
	}
}

func TestReplayRetainsPayloadsAtExactByteBudget(t *testing.T) {
	h := New(Config{ReplayRingSize: 8, ReplayMaxBytes: 6}, nil, nil)
	t.Cleanup(h.Close)

	h.recordFetchSuccess(h.topics["users"], json.RawMessage(`"a"`))
	h.recordFetchSuccess(h.topics["stats"], json.RawMessage(`"b"`))

	events, ok := h.ReplaySince(0, []string{"users", "stats"})
	if !ok || len(events) != 2 {
		t.Fatalf("ReplaySince(0) = (%+v, %v), want both events at the exact byte budget", events, ok)
	}
}

func TestReplayCountLimitStillEvictsWithGenerousByteBudget(t *testing.T) {
	h := New(Config{ReplayRingSize: 2, ReplayMaxBytes: 100}, nil, nil)
	t.Cleanup(h.Close)

	h.recordFetchSuccess(h.topics["users"], json.RawMessage(`"a"`))
	h.recordFetchSuccess(h.topics["stats"], json.RawMessage(`"b"`))
	h.recordFetchSuccess(h.topics["update"], json.RawMessage(`"c"`))

	if events, ok := h.ReplaySince(0, []string{"users", "stats", "update"}); ok || events != nil {
		t.Fatalf("ReplaySince(0) = (%+v, %v), want (nil, false) after count eviction", events, ok)
	}
	events, ok := h.ReplaySince(1, []string{"users", "stats", "update"})
	if !ok || len(events) != 2 || events[0].Seq != 2 || events[1].Seq != 3 {
		t.Fatalf("ReplaySince(1) = (%+v, %v), want retained seqs 2 and 3", events, ok)
	}
}

func TestOversizedEventBroadcastsAndRequiresReplayResync(t *testing.T) {
	h := New(Config{ReplayRingSize: 8, ReplayMaxBytes: 4}, nil, nil)
	t.Cleanup(h.Close)

	ch, snapshots, cancel, err := h.Subscribe([]string{"update"})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer cancel()
	if len(snapshots) != 0 {
		t.Fatalf("initial snapshots = %+v, want none", snapshots)
	}

	oversized := json.RawMessage(`{"too":"large"}`)
	h.PublishUpdate(oversized)
	first := recvEvent(t, ch, time.Second)
	if first.Seq != 1 || !bytes.Equal(first.Data, oversized) {
		t.Fatalf("broadcast event = %+v, want oversized payload at seq 1", first)
	}

	snapshot, err := h.Snapshot(context.Background(), []string{"update"})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if !bytes.Equal(snapshot["update"], oversized) {
		t.Fatalf("update snapshot = %s, want oversized payload %s", snapshot["update"], oversized)
	}

	h.mu.Lock()
	gotBytes, gotCount := h.ringBytes, len(h.ring)
	h.mu.Unlock()
	if gotBytes != 0 || gotCount != 0 {
		t.Fatalf("retained ring = %d bytes in %d events, want empty after oversized event", gotBytes, gotCount)
	}
	if events, ok := h.ReplaySince(0, []string{"update"}); ok || events != nil {
		t.Fatalf("ReplaySince(0) = (%+v, %v), want (nil, false) after oversized eviction", events, ok)
	}
	if events, ok := h.ReplaySince(first.Seq, []string{"update"}); !ok || len(events) != 0 {
		t.Fatalf("ReplaySince(%d) = (%+v, %v), want empty successful continuation", first.Seq, events, ok)
	}

	small := json.RawMessage(`1`)
	h.PublishUpdate(small)
	second := recvEvent(t, ch, time.Second)
	if events, ok := h.ReplaySince(0, []string{"update"}); ok || events != nil {
		t.Fatalf("ReplaySince(0) after continuation = (%+v, %v), want (nil, false)", events, ok)
	}
	events, ok := h.ReplaySince(first.Seq, []string{"update"})
	if !ok || len(events) != 1 || events[0].Seq != second.Seq || !bytes.Equal(events[0].Data, small) {
		t.Fatalf("ReplaySince(%d) = (%+v, %v), want the subsequent small event", first.Seq, events, ok)
	}
	if events, ok := h.ReplaySince(second.Seq+100, []string{"update"}); ok || events != nil {
		t.Fatalf("future ReplaySince = (%+v, %v), want (nil, false)", events, ok)
	}
}

func TestReplayEvictionClearsDiscardedBackingSlot(t *testing.T) {
	h := New(Config{ReplayRingSize: 8, ReplayMaxBytes: 4}, nil, nil)
	t.Cleanup(h.Close)

	h.mu.Lock()
	h.ring = make([]Event, 0, 2)
	h.mu.Unlock()

	h.PublishUpdate(json.RawMessage(`"aa"`))
	h.mu.Lock()
	backing := h.ring[:cap(h.ring)]
	h.mu.Unlock()

	h.PublishUpdate(json.RawMessage(`"bb"`))

	discarded := backing[0]
	if discarded.Seq != 0 || discarded.Topic != "" || discarded.Data != nil || discarded.TS != 0 || discarded.Err != "" {
		t.Fatalf("discarded backing slot = %+v, want zero Event so payload references can be collected", discarded)
	}
}
