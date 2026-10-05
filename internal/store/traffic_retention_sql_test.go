//go:build !lite

package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteTrafficDeletedRetentionChurnAndReappear(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runTrafficDeletedRetention(t, s)
}

func TestSQLiteTrafficDeletedRetentionNoBucketsCleanup(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now()
	if _, err := s.exec(`INSERT INTO user_traffic_users(username,total_bytes,since_ts,updated_ts,month_key,month_bytes,deleted_ts,continuity) VALUES('expired',0,1,0,0,0,?,'normal')`, now.Add(-366*24*time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	removed, err := s.pruneUserTrafficBatch(now, 250)
	if err != nil || removed != 0 {
		t.Fatalf("no bucket pruning=%d %v", removed, err)
	}
	summaries, err := s.UserTrafficSummaries()
	if err != nil || len(summaries) != 0 {
		t.Fatalf("no-buckets summaries=%+v err=%v", summaries, err)
	}
}

func TestSQLiteTrafficRetentionPolicyAndReappear(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runTrafficRetentionPolicyAndReappear(t, s)
}

func TestSQLiteTrafficDirectReappearanceAfterExpiry(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runTrafficDirectReappearanceAfterExpiry(t, s)
}

func TestTrafficRetentionDifferentProfileWindows(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().Unix()
	old := now - 2*86400
	for _, st := range []HistoryStore{m, s} {
		for _, snapshot := range []UserTrafficSnapshot{
			{ObservedAt: old, SourceStartedAt: old - 100, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "deleted", RawOctets: 0}, {Username: "active", RawOctets: 0}}},
			{ObservedAt: old + 1, SourceStartedAt: old - 100, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "active", RawOctets: 0}}},
			{ObservedAt: now, SourceStartedAt: old - 100, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "active", RawOctets: 0}}},
		} {
			if _, err := st.ApplyUserTrafficSnapshot(snapshot); err != nil {
				t.Fatal(err)
			}
		}
	}
	mem, _ := m.UserTrafficSummaries()
	disk, _ := s.UserTrafficSummaries()
	if len(mem) != 1 || len(disk) != 2 {
		t.Fatalf("profile retention collapsed: memory=%d disk=%d", len(mem), len(disk))
	}
}
