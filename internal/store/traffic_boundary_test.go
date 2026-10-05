package store

import (
	"testing"
	"time"
)

func TestMemoryTrafficBoundaryHistoricalUpper(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	ts := (now - 3600) / 900 * 900
	m.userTrafficBuckets[memoryUserTrafficBucketKey{username: "alice", ts: ts}] = 100
	m.userTraffic["alice"] = memoryUserTraffic{summary: UserTrafficSummary{Username: "alice"}}
	total, points, err := m.UserTrafficAggregate(ts, ts+450)
	if err != nil {
		t.Fatal(err)
	}
	if total != 0 || len(points) != 0 {
		t.Fatalf("historical partial bucket counted as exact: total=%d points=%+v", total, points)
	}
	ranks, err := m.UserTrafficRanking(ts, ts+450, false, 5, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(ranks) != 0 {
		t.Fatalf("historical partial ranking counted as exact: %+v", ranks)
	}
}
