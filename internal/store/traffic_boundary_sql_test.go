//go:build !lite

package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteTrafficBoundaryAudit100Bytes(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	asOf := time.Date(2026, 10, 5, 10, 30, 0, 0, time.UTC).Unix()
	from := asOf - 86400
	for _, snapshot := range []UserTrafficSnapshot{
		{ObservedAt: from, SourceStartedAt: from - 3600, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "alice", RawOctets: 0}}},
		{ObservedAt: from + 900, SourceStartedAt: from - 3600, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "alice", RawOctets: 100}}},
	} {
		if _, err := s.ApplyUserTrafficSnapshot(snapshot); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := s.BeginTrafficRead(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	r := raw.(*sqlTrafficReadSnapshot)
	r.asOf = asOf
	points, coverage, err := r.Range("alice", from, from+1800)
	if err != nil || len(points) != 1 || points[0].Bytes != 100 || coverage.BoundaryPartial {
		t.Fatalf("range=%+v coverage=%+v err=%v", points, coverage, err)
	}
	total, points, coverage, err := r.Aggregate(from, from+1800)
	if err != nil || total != 100 || len(points) != 1 || coverage.BoundaryPartial {
		t.Fatalf("aggregate=%d %+v %+v err=%v", total, points, coverage, err)
	}
	ranks, coverage, err := r.Ranking(from, from+1800, false, 10, nil)
	if err != nil || len(ranks) != 1 || ranks[0].Bytes != 100 || coverage.BoundaryPartial {
		t.Fatalf("ranking=%+v coverage=%+v err=%v", ranks, coverage, err)
	}
}

func TestSQLiteTrafficBoundaryHistoricalUpper(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := (time.Now().Unix() - 3600) / 900 * 900
	for _, snap := range []UserTrafficSnapshot{
		{ObservedAt: ts - 30, SourceStartedAt: ts - 3600, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "alice", RawOctets: 0}}},
		{ObservedAt: ts + 30, SourceStartedAt: ts - 3600, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "alice", RawOctets: 100}}},
	} {
		if _, err := s.ApplyUserTrafficSnapshot(snap); err != nil {
			t.Fatal(err)
		}
	}
	total, points, err := s.UserTrafficAggregate(ts, ts+450)
	if err != nil {
		t.Fatal(err)
	}
	if total != 0 || len(points) != 0 {
		t.Fatalf("historical partial bucket counted as exact: total=%d points=%+v", total, points)
	}
	ranks, err := s.UserTrafficRanking(ts, ts+450, false, 5, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(ranks) != 0 {
		t.Fatalf("historical partial ranking counted as exact: %+v", ranks)
	}
}
