package hub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestUsersComparisonPreservesAdjacentUint64Values(t *testing.T) {
	first := json.RawMessage(`{"users":[{"username":"comparison-user","total_octets":9007199254740992}]}`)
	second := json.RawMessage(`{"users":[{"username":"comparison-user","total_octets":9007199254740993}]}`)
	events := make(chan Event, 3)
	h := &Hub{
		cfg: Config{}.withDefaults(),
		now: time.Now,
		subscribers: map[uint64]*subscriber{
			1: {ch: events, topics: map[string]struct{}{"users": {}}},
		},
	}
	state := &topicState{name: "users"}

	h.recordFetchSuccess(state, first)
	h.recordFetchSuccess(state, second)
	h.recordFetchSuccess(state, second)

	if got := len(events); got != 2 {
		t.Fatalf("published events = %d, want 2 for adjacent uint64 values followed by an identical snapshot", got)
	}
	if got := (<-events).Data; !bytes.Equal(got, first) {
		t.Fatalf("first event data = %s, want %s", got, first)
	}
	if got := (<-events).Data; !bytes.Equal(got, second) {
		t.Fatalf("second event data = %s, want %s", got, second)
	}
}

func BenchmarkUsersComparison(b *testing.B) {
	for _, users := range []int{20, 2000} {
		payload := benchmarkUsersPayload(b, users)
		incoming := append(json.RawMessage(nil), payload...)
		b.Run(fmt.Sprintf("users_%d/diff_key_equal", users), func(b *testing.B) {
			previous := diffKey("users", payload)
			b.ReportAllocs()
			b.ResetTimer()
			b.ReportMetric(float64(len(payload)), "payload_B")
			for range b.N {
				if key := diffKey("users", incoming); !bytes.Equal(previous, key) {
					b.Fatal("unchanged users payload produced a different comparison key")
				}
			}
		})
		b.Run(fmt.Sprintf("users_%d/record_fetch_success_unchanged", users), func(b *testing.B) {
			h := &Hub{cfg: Config{}.withDefaults(), now: time.Now}
			state := &topicState{name: "users"}
			h.recordFetchSuccess(state, payload)
			b.ReportAllocs()
			b.ResetTimer()
			b.ReportMetric(float64(len(payload)), "payload_B")
			for range b.N {
				h.recordFetchSuccess(state, incoming)
			}
		})
	}
}

func benchmarkUsersPayload(b *testing.B, count int) json.RawMessage {
	b.Helper()
	users := make([]userSnapshotItem, count)
	for i := range users {
		users[i] = userSnapshotItem{UserInfo: telemt.UserInfo{
			Username:           fmt.Sprintf("comparison-user-%04d", i),
			Enabled:            true,
			InRuntime:          true,
			CurrentConnections: uint64(i%8 + 1),
			ActiveUniqueIPs:    2,
			ActiveIPList: []string{
				fmt.Sprintf("192.0.%d.%d", i/256, i%256),
				fmt.Sprintf("2001:db8::%x", i+1),
			},
			RecentUniqueIPs: 2,
			RecentIPList: []string{
				fmt.Sprintf("198.51.%d.%d", i/256, i%256),
				fmt.Sprintf("2001:db8:1::%x", i+1),
			},
			TotalOctets: uint64(9_007_199_254_740_992 + i),
			Links: telemt.UserLinks{
				Classic: []string{"tg://proxy?server=198.51.100.10&port=443&secret=benchmark-secret"},
			},
		}}
	}
	payload, err := json.Marshal(usersSnapshot{Users: users, QuotaSupported: true})
	if err != nil {
		b.Fatalf("marshal users benchmark payload: %v", err)
	}
	return payload
}
