//go:build !lite

package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestPortableSQLImportRollsBackCompletely(t *testing.T) {
	st, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Unix(1_800_000_000, 0).UTC()
	data := PortableData{
		FormatVersion: portableFormatVersion,
		Metrics: map[string][]MetricPoint{
			"connections": {
				{TS: now.Unix(), Value: 1},
				{TS: now.Unix(), Value: 2},
			},
		},
	}
	if err := st.ImportData(data); err == nil {
		t.Fatal("ImportData accepted duplicate metric keys")
	}

	data.Metrics["connections"] = data.Metrics["connections"][:1]
	if err := st.ImportData(data); err != nil {
		t.Fatalf("valid import after rollback: %v", err)
	}
	if points, err := st.MetricRange("connections", 0); err != nil || len(points) != 1 || points[0].Value != 1 {
		t.Fatalf("metrics after import = %+v, %v", points, err)
	}
}

func TestPortableSQLRoundTripsUserTraffic(t *testing.T) {
	source, err := NewSQLite(filepath.Join(t.TempDir(), "source.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	now := time.Now().UTC().Truncate(time.Second)
	for _, snapshot := range []UserTrafficSnapshot{
		{ObservedAt: now.Add(-time.Minute).Unix(), SourceStartedAt: now.Add(-time.Hour).Unix(), TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: "alice", RawOctets: 100}}},
		{ObservedAt: now.Unix(), SourceStartedAt: now.Add(-time.Hour).Unix(), TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: "alice", RawOctets: 350}}},
	} {
		if _, err := source.ApplyUserTrafficSnapshot(snapshot); err != nil {
			t.Fatal(err)
		}
	}
	data, err := source.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	if data.FormatVersion != portableFormatVersion || len(data.UserTraffic) != 1 || len(data.UserTrafficBuckets) != 3 || data.UserTrafficCollector == nil {
		t.Fatalf("exported traffic = %+v / %+v / %+v", data.UserTraffic, data.UserTrafficBuckets, data.UserTrafficCollector)
	}

	destination, err := NewSQLite(filepath.Join(t.TempDir(), "destination.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	if err := destination.ImportData(data); err != nil {
		t.Fatal(err)
	}
	summaries, err := destination.UserTrafficSummaries()
	if err != nil || summaries["alice"].ObservedTotalBytes != 250 {
		t.Fatalf("imported summaries = %+v, %v", summaries, err)
	}
	points, err := destination.UserTrafficRange("alice", now.Add(-24*time.Hour).Unix())
	if err != nil || len(points) != 1 || points[0].Bytes != 250 {
		t.Fatalf("imported points = %+v, %v", points, err)
	}
}
