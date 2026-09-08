package hub

import (
	"encoding/json"
	"fmt"
	"runtime"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestFreshCachedUsersGaugeReadsAllocateZero(t *testing.T) {
	h, _ := cachedUsersGaugeFixture(t, 20)

	allocs := testing.AllocsPerRun(100, func() {
		gauges, ok := h.cachedUsersLiveGauges()
		if !ok {
			t.Fatal("fresh users cache is unavailable")
		}
		if gauges.connections != 190 || gauges.activeUsers != 19 {
			t.Fatalf("cached gauges = %d/%d, want 190/19", gauges.connections, gauges.activeUsers)
		}
		runtime.KeepAlive(gauges)
	})
	if allocs != 0 {
		t.Fatalf("fresh cached gauge read allocations = %v, want 0", allocs)
	}
}

func TestUsersLiveTotalsUseLiteralConnections(t *testing.T) {
	gauges := usersLiveTotals([]userSnapshotItem{
		{UserInfo: telemt.UserInfo{CurrentConnections: 7}},
		{UserInfo: telemt.UserInfo{CurrentConnections: 0}},
		{UserInfo: telemt.UserInfo{CurrentConnections: 4}},
	})
	if gauges.connections != 11 || gauges.activeUsers != 2 {
		t.Fatalf("users gauges = %+v, want 11 connections and 2 active users", gauges)
	}

	empty := usersLiveTotals(nil)
	if empty.connections != 0 || empty.activeUsers != 0 {
		t.Fatalf("empty users gauges = %+v, want valid zero totals", empty)
	}
}

func TestCachedUsersLiveGaugesTrackObservationFreshness(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	h := New(Config{UsersInterval: 10 * time.Second}, nil, nil)
	t.Cleanup(h.Close)
	h.now = func() time.Time { return now }
	users := h.topics["users"]

	assertUnavailable := func(stage string) {
		t.Helper()
		if gauges, ok := h.cachedUsersLiveGauges(); ok {
			t.Fatalf("%s gauges = %+v, want unavailable", stage, gauges)
		}
	}
	assertGauges := func(stage string, want usersLiveGauges) {
		t.Helper()
		if gauges, ok := h.cachedUsersLiveGauges(); !ok || gauges != want {
			t.Fatalf("%s gauges = (%+v, %v), want (%+v, true)", stage, gauges, ok, want)
		}
	}

	assertUnavailable("before observation")
	empty := usersLiveGauges{}
	h.recordFetchSuccess(users, json.RawMessage(`{"users":[]}`), &empty)
	assertGauges("empty successful observation", empty)

	want := usersLiveGauges{connections: 11, activeUsers: 2}
	payload := json.RawMessage(`{"users":[{"current_connections":7},{"current_connections":0},{"current_connections":4}]}`)
	h.recordFetchSuccess(users, payload, &want)
	assertGauges("fresh observation", want)

	h.recordFetchError(users, fmt.Errorf("users unavailable"))
	assertUnavailable("after error")
	h.recordFetchSuccess(users, payload, &want)
	assertGauges("recovered unchanged observation", want)

	now = now.Add(21 * time.Second)
	assertUnavailable("expired observation")
	h.recordFetchSuccess(users, payload, &want)
	assertGauges("unchanged observation refreshed", want)
}

func BenchmarkCachedUsersGaugeFallback(b *testing.B) {
	for _, count := range []int{20, 2000} {
		b.Run(fmt.Sprintf("users_%d", count), func(b *testing.B) {
			h, payloadBytes := cachedUsersGaugeFixture(b, count)
			b.ReportAllocs()
			b.ReportMetric(float64(payloadBytes), "payload_B")
			b.ResetTimer()
			for range b.N {
				gauges, ok := h.cachedUsersLiveGauges()
				if !ok {
					b.Fatal("fresh users cache is unavailable")
				}
				runtime.KeepAlive(gauges)
			}
		})
	}
}

func cachedUsersGaugeFixture(tb testing.TB, count int) (*Hub, int) {
	tb.Helper()
	items := make([]userSnapshotItem, count)
	for i := range items {
		items[i].UserInfo = telemt.UserInfo{
			Username:           fmt.Sprintf("user-%d", i),
			CurrentConnections: uint64(i % 20),
		}
	}
	payload, err := json.Marshal(usersSnapshot{Users: items})
	if err != nil {
		tb.Fatalf("marshal users gauge fixture: %v", err)
	}
	now := time.Unix(1_800_000_000, 0)
	h := New(Config{UsersInterval: 10 * time.Second}, nil, nil)
	tb.Cleanup(h.Close)
	h.now = func() time.Time { return now }
	users := h.topics["users"]
	users.hasData = true
	users.lastData = payload
	users.lastObservedAt = now
	users.usersGauges = usersLiveTotals(items)
	users.usersGaugesOK = true
	return h, len(payload)
}
