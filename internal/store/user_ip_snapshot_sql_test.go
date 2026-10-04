//go:build !lite

package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestUserIPSnapshotConsistencySQLite(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runUserIPSnapshotConsistency(t, s)
}
func TestUserIPEpochMutationsSQLite(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runUserIPEpochMutations(t, s)
}
func TestUserIPSnapshotRetentionSQLite(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	const now int64 = 1800000000
	p := DefaultStoragePolicies()
	for i := range p {
		if p[i].Category == StorageUserIPHistory {
			p[i].RetentionDays = 7
		}
	}
	if err := s.ApplyStoragePolicies(p); err != nil {
		t.Fatal(err)
	}
	for _, r := range []UserIPRecord{snapshotRecord("old", "1.1.1.1", now-7*86400-1), snapshotRecord("boundary", "1.1.1.1", now-7*86400), snapshotRecord("future", "1.1.1.1", now+1)} {
		if _, err := s.db.Exec("INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES(?,?,?,?,?,?,?,?)", r.Username, r.IP, r.Family, r.First, r.Last, r.Observations, r.LastActive, r.Source); err != nil {
			t.Fatal(err)
		}
	}
	snap, err := s.ReadUserIPSnapshot(context.Background(), now-30*86400, now)
	if err != nil || snap.Retention != 7*24*time.Hour || !snap.Durable || len(snap.Records) != 1 || snap.Records[0].Username != "boundary" || !snap.Collection.Gap {
		t.Fatalf("snapshot=%+v %v", snap, err)
	}
}
