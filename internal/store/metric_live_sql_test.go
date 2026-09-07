//go:build !lite

package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteLiveMetricsDoNotDependOnDiskPolicy(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	policies := DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageTraffic {
			policies[i].Enabled = false
		}
	}
	if err := s.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	for _, p := range []MetricPoint{{TS: now, Value: 20}, {TS: now - 5, Value: 10}} {
		if err := s.RecordMetric("traffic", p); err != nil {
			t.Fatal(err)
		}
	}
	points, err := s.MetricRange("traffic", now-10)
	if err != nil || len(points) != 2 || points[0].Value != 10 || points[1].Value != 20 {
		t.Fatalf("live points = %+v, err=%v", points, err)
	}
	if got := s.MetricRetention("traffic"); got != 2*time.Hour {
		t.Fatalf("retention = %s, want 2h live window", got)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points WHERE name = 'traffic'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("disabled disk writes: count=%d, err=%v", count, err)
	}
	if err := s.PurgeHistory(StorageTraffic); err != nil {
		t.Fatal(err)
	}
	points, err = s.MetricRange("traffic", now-10)
	if err != nil || len(points) != 0 {
		t.Fatalf("purged live points = %+v, err=%v", points, err)
	}
}

func TestSQLiteLiveMetricsRemainReadableWhenDatabaseClosed(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.db.Close(); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if err := s.RecordMetric("connections", MetricPoint{TS: now, Value: 12}); err != nil {
		t.Fatal(err)
	}
	if err := s.flushMetrics(); err == nil {
		t.Fatal("expected persistence error")
	}
	points, err := s.MetricRange("connections", now-60)
	if err != nil || len(points) != 1 || points[0].Value != 12 {
		t.Fatalf("live data lost with unavailable disk: %+v, %v", points, err)
	}
}
