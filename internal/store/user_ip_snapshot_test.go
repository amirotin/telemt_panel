package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func snapshotRecord(user, ip string, at int64) UserIPRecord {
	canonical, family, _ := NormalizeUserIP(ip)
	return UserIPRecord{Username: user, IP: canonical, Family: family, First: at, Last: at, Observations: 1, Source: 1}
}

func runUserIPSnapshotConsistency(t *testing.T, st HistoryStore) {
	t.Helper()
	const now int64 = 1800000000
	records := []UserIPRecord{snapshotRecord("bob", "2001:db8::1", now-1), snapshotRecord("alice", "1.1.1.1", now-2)}
	if err := st.ApplyUserIPBatch(UserIPBatch{ID: "one", Through: now, Records: records}); err != nil {
		t.Fatal(err)
	}
	snap, err := st.ReadUserIPSnapshot(context.Background(), now-86400, now)
	if err != nil || len(snap.Records) != 2 || snap.Collection.BatchID != "one" || snap.Records[0].Username != "alice" || snap.Epoch != st.UserIPEpoch() {
		t.Fatalf("snapshot=%+v err=%v", snap, err)
	}
	snap.Records[0].Username = "changed"
	again, err := st.ReadUserIPSnapshot(context.Background(), 0, now)
	if err != nil || again.Records[0].Username != "alice" {
		t.Fatal("snapshot aliases history")
	}
	epoch := st.UserIPEpoch()
	if err := st.ApplyUserIPBatch(UserIPBatch{ID: "two", Through: now + 1}); err != nil {
		t.Fatal(err)
	}
	if st.UserIPEpoch() != epoch {
		t.Fatal("ordinary flush invalidated snapshot")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := st.ReadUserIPSnapshot(ctx, 0, now); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel=%v", err)
	}
	if _, err := st.ReadUserIPSnapshot(context.Background(), now+1, now); err == nil {
		t.Fatal("invalid time range accepted")
	}
}

func runUserIPEpochMutations(t *testing.T, st HistoryStore) {
	t.Helper()
	check := func(name string, fn func() error) {
		t.Helper()
		before := st.UserIPEpoch()
		if err := fn(); err != nil {
			t.Fatal(err)
		}
		if st.UserIPEpoch() == before {
			t.Fatalf("%s did not change epoch", name)
		}
	}
	check("reset-user", func() error { return st.ResetUserIPHistory("alice") })
	check("reset-all", func() error { return st.ResetUserIPHistory("") })
	check("purge", func() error { return st.PurgeHistory(StorageUserIPHistory) })
	policies := DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageUserIPHistory {
			policies[i].RetentionDays = 7
		}
	}
	check("retention", func() error { return st.ApplyStoragePolicies(policies) })
	before := st.UserIPEpoch()
	if err := st.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if st.UserIPEpoch() != before {
		t.Fatal("unchanged policy advanced epoch")
	}
	policies[0].RetentionDays = 0
	if err := st.ApplyStoragePolicies(policies); err == nil || st.UserIPEpoch() != before {
		t.Fatal("failed mutation advanced epoch")
	}
}

func TestUserIPSnapshotConsistency(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	runUserIPSnapshotConsistency(t, m)
}
func TestUserIPEpochMutations(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	runUserIPEpochMutations(t, m)
}

func TestUserIPSnapshotRetention(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	const now int64 = 1800000000
	m.userIPs = map[userIPKey]UserIPRecord{}
	for i, at := range []int64{now - 86401, now - 86400, now, now + 1} {
		r := snapshotRecord("alice", fmt.Sprintf("2001:db8::%x", i+1), at)
		m.userIPs[userIPKey{r.Username, r.IP}] = r
	}
	s, err := m.ReadUserIPSnapshot(context.Background(), now-30*86400, now)
	if err != nil || s.Retention != 24*time.Hour || s.Durable || len(s.Records) != 2 || !s.Collection.Gap {
		t.Fatalf("snapshot=%+v %v", s, err)
	}
}

func TestUserIPSnapshotCapsAndCancel(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	const now int64 = 1800000000
	m.userIPs = map[userIPKey]UserIPRecord{}
	for i := 0; i < UserIPMemoryLimit+1; i++ {
		r := snapshotRecord(fmt.Sprintf("user%05d", i), "1.1.1.1", now)
		m.userIPs[userIPKey{r.Username, r.IP}] = r
	}
	s, err := m.ReadUserIPSnapshot(context.Background(), 0, now)
	if err != nil || len(s.Records) != UserIPMemoryLimit || !s.Truncated || s.Records[0].Username != "user00000" || s.Records[len(s.Records)-1].Username != "user19999" {
		t.Fatalf("cap length=%d truncated=%v err=%v", len(s.Records), s.Truncated, err)
	}
}

func TestUserIPSnapshotCapKeepsFreshestRecordsWithStableTies(t *testing.T) {
	m, _ := NewMemoryHistory()
	defer m.Close()
	const now int64 = 1800000000
	m.userIPs = make(map[userIPKey]UserIPRecord)
	for i := 0; i < UserIPMemoryLimit+2; i++ {
		at := now - 1
		if i == 0 {
			at = now - 2
		} else if i == UserIPMemoryLimit+1 {
			at = now
		}
		r := snapshotRecord(fmt.Sprintf("user%05d", i), "1.1.1.1", at)
		m.userIPs[userIPKey{r.Username, r.IP}] = r
	}
	for attempt := 0; attempt < 3; attempt++ {
		snap, err := m.ReadUserIPSnapshot(context.Background(), 0, now)
		if err != nil || !snap.Truncated || len(snap.Records) != UserIPMemoryLimit {
			t.Fatalf("snapshot cap: %d truncated=%v err=%v", len(snap.Records), snap.Truncated, err)
		}
		if snap.Records[0].Username != "user00001" || snap.Records[len(snap.Records)-1].Username != "user20001" {
			t.Fatalf("selected range %s..%s omitted fresh history", snap.Records[0].Username, snap.Records[len(snap.Records)-1].Username)
		}
		for _, record := range snap.Records {
			if record.Username == "user20000" {
				t.Fatal("timestamp tie did not keep the first username/IP keys")
			}
		}
	}
}
