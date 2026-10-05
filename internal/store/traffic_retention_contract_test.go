package store

import (
	"fmt"
	"testing"
	"time"
)

func runTrafficDeletedRetention(t *testing.T, st HistoryStore) {
	t.Helper()
	policies := DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageUserTraffic {
			policies[i].RetentionDays = 1
		}
	}
	if err := st.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	old := now - 2*86400
	users := make([]UserTrafficObservation, 0, 1001)
	for i := 0; i < 1000; i++ {
		users = append(users, UserTrafficObservation{Username: fmt.Sprintf("expired-%04d", i), RawOctets: 100})
	}
	users = append(users, UserTrafficObservation{Username: "active", RawOctets: 100})
	apply := func(at int64, observations []UserTrafficObservation) {
		t.Helper()
		if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{ObservedAt: at, SourceStartedAt: old - 100, TelemetryEnabled: true, Users: observations}); err != nil {
			t.Fatal(err)
		}
	}
	apply(old, users)
	apply(old+1, []UserTrafficObservation{{Username: "active", RawOctets: 110}})
	apply(now, []UserTrafficObservation{{Username: "active", RawOctets: 120}})
	summaries, err := st.UserTrafficSummaries()
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 || summaries["active"].ObservedTotalBytes != 20 {
		t.Fatalf("expired deleted churn retained: count=%d active=%+v", len(summaries), summaries["active"])
	}
	// A name whose entire old history was cleaned must establish a baseline.
	apply(now+1, []UserTrafficObservation{{Username: "active", RawOctets: 120}, {Username: "expired-0000", RawOctets: 1000000}})
	summaries, err = st.UserTrafficSummaries()
	if err != nil {
		t.Fatal(err)
	}
	if got := summaries["expired-0000"]; got.ObservedTotalBytes != 0 || got.ObservedSinceEpochSecs != now+1 || got.DeletedEpochSecs != 0 {
		t.Fatalf("reappearing name reused expired baseline: %+v", got)
	}
	apply(now+2, []UserTrafficObservation{{Username: "active", RawOctets: 120}, {Username: "expired-0000", RawOctets: 1000100}})
	summaries, _ = st.UserTrafficSummaries()
	if summaries["expired-0000"].ObservedTotalBytes != 100 {
		t.Fatalf("new baseline delta=%+v", summaries["expired-0000"])
	}
}

func TestMemoryTrafficDeletedRetentionChurnAndReappear(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	runTrafficDeletedRetention(t, m)
}

func TestMemoryTrafficRetentionPreservesActiveAndRetainedDeleted(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	for name, deleted := range map[string]int64{"active": 0, "boundary": now - 86400, "retained": now - 1, "expired": now - 86401, "bucket": now - 86401} {
		m.userTraffic[name] = memoryUserTraffic{summary: UserTrafficSummary{Username: name, DeletedEpochSecs: deleted, ObservedTotalBytes: 123, ObservedSinceEpochSecs: now - 100000}}
	}
	m.userTrafficBuckets[memoryUserTrafficBucketKey{"bucket", now / 900 * 900}] = 10
	m.pruneUserTrafficBucketsLocked(now)
	if len(m.userTraffic) != 4 {
		t.Fatalf("retained summary count=%d want 4", len(m.userTraffic))
	}
	for _, name := range []string{"active", "boundary", "retained", "bucket"} {
		if m.userTraffic[name].summary.ObservedTotalBytes != 123 {
			t.Errorf("summary changed: %s %+v", name, m.userTraffic[name])
		}
	}
	if err := m.PurgeHistory(StorageUserTraffic); err != nil {
		t.Fatal(err)
	}
	if _, found := m.userTraffic["bucket"]; found {
		t.Fatal("purge kept expired no-buckets summary")
	}
}

func TestTrafficDeletedRetentionEligibility(t *testing.T) {
	now := int64(100000)
	for _, tc := range []struct {
		deleted   int64
		buckets   bool
		retention time.Duration
		want      bool
	}{
		{0, false, 24 * time.Hour, false}, {now - 86400, false, 24 * time.Hour, false},
		{now - 86401, false, 24 * time.Hour, true}, {now - 86401, true, 24 * time.Hour, false},
		{now - 86401, false, 365 * 24 * time.Hour, false}, {now - 1, false, -time.Second, false},
	} {
		if got := expiredTrafficSummary(UserTrafficSummary{DeletedEpochSecs: tc.deleted}, tc.buckets, now, tc.retention); got != tc.want {
			t.Errorf("eligibility %+v = %t", tc, got)
		}
	}
}

func runTrafficRetentionPolicyAndReappear(t *testing.T, st HistoryStore) {
	t.Helper()
	now := time.Now().Unix()
	old := now - 2*86400
	apply := func(at int64, users []UserTrafficObservation) {
		t.Helper()
		if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{ObservedAt: at, SourceStartedAt: old - 100, TelemetryEnabled: true, Users: users}); err != nil {
			t.Fatal(err)
		}
	}
	apply(old, []UserTrafficObservation{{Username: "expired", RawOctets: 100}, {Username: "active", RawOctets: 100}})
	apply(old+1, []UserTrafficObservation{{Username: "active", RawOctets: 100}})
	policies := DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageUserTraffic {
			policies[i].RetentionDays = 1
		}
	}
	if err := st.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	summaries, err := st.UserTrafficSummaries()
	if err != nil || len(summaries) != 1 {
		t.Fatalf("policy no-buckets cleanup=%+v %v", summaries, err)
	}
	apply(now-1000, []UserTrafficObservation{{Username: "active", RawOctets: 200}, {Username: "retained", RawOctets: 100}})
	apply(now-900, []UserTrafficObservation{{Username: "active", RawOctets: 200}, {Username: "retained", RawOctets: 200}})
	apply(now-800, []UserTrafficObservation{{Username: "active", RawOctets: 200}})
	if err := st.PurgeHistory(StorageUserTraffic); err != nil {
		t.Fatal(err)
	}
	summaries, err = st.UserTrafficSummaries()
	if err != nil || summaries["retained"].ObservedTotalBytes != 100 {
		t.Fatalf("purge removed retained summary=%+v %v", summaries, err)
	}
	apply(now, []UserTrafficObservation{{Username: "active", RawOctets: 200}, {Username: "retained", RawOctets: 250}})
	summaries, err = st.UserTrafficSummaries()
	if err != nil || summaries["retained"].ObservedTotalBytes != 150 || summaries["retained"].DeletedEpochSecs != 0 || summaries["active"].ObservedTotalBytes != 100 {
		t.Fatalf("retained reappearance=%+v %v", summaries, err)
	}
}

func TestMemoryTrafficRetentionPolicyAndReappear(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	runTrafficRetentionPolicyAndReappear(t, m)
}

func runTrafficDirectReappearanceAfterExpiry(t *testing.T, st HistoryStore) {
	t.Helper()
	policies := DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageUserTraffic {
			policies[i].RetentionDays = 1
		}
	}
	if err := st.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	first := time.Now().Unix()
	returned := first + 2*86400
	for _, snapshot := range []UserTrafficSnapshot{
		{ObservedAt: first, Users: []UserTrafficObservation{{Username: "returned", RawOctets: 100}, {Username: "active", RawOctets: 100}}},
		{ObservedAt: first + 1, Users: []UserTrafficObservation{{Username: "returned", RawOctets: 200}, {Username: "active", RawOctets: 110}}},
		{ObservedAt: first + 2, Users: []UserTrafficObservation{{Username: "active", RawOctets: 110}}},
		{ObservedAt: returned, Users: []UserTrafficObservation{{Username: "returned", RawOctets: 400}, {Username: "active", RawOctets: 120}}},
	} {
		snapshot.SourceStartedAt = first - 100
		snapshot.TelemetryEnabled = true
		if _, err := st.ApplyUserTrafficSnapshot(snapshot); err != nil {
			t.Fatal(err)
		}
	}
	summaries, err := st.UserTrafficSummaries()
	if err != nil {
		t.Fatal(err)
	}
	if got := summaries["returned"]; got.ObservedTotalBytes != 0 || got.ObservedSinceEpochSecs != returned || got.DeletedEpochSecs != 0 {
		t.Fatalf("direct reappearance reused expired baseline: %+v", got)
	}
	if got := summaries["active"].ObservedTotalBytes; got != 20 {
		t.Fatalf("active lifetime total = %d, want 20", got)
	}
}

func TestMemoryTrafficDirectReappearanceAfterExpiry(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	runTrafficDirectReappearanceAfterExpiry(t, m)
}
