//go:build !lite

package store

import (
	"math"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestMetricFlushExportPreservesUnflushedAggregateMetadata(t *testing.T) {
	s, _ := newSQLite(t)
	if err := s.RecordMetrics([]NamedMetricPoint{{Name: "traffic", Point: MetricPoint{TS: 300, Value: 10}}, {Name: "traffic", Point: MetricPoint{TS: 305, Value: 30}}}); err != nil {
		t.Fatal(err)
	}
	data, err := s.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Metrics["traffic"]) != 2 || data.Metrics["traffic"][0].Min == nil || data.Metrics["traffic"][0].Delta == nil {
		t.Fatalf("export omitted pending samples or metadata: %+v", data.Metrics)
	}
	destination, _ := newSQLite(t)
	if err := destination.ImportData(data); err != nil {
		t.Fatal(err)
	}
	copy, err := destination.ExportData()
	if err != nil || !reflect.DeepEqual(copy.Metrics, data.Metrics) {
		t.Fatalf("metric export round trip changed history: %+v -> %+v, %v", data.Metrics, copy.Metrics, err)
	}
}

func TestMetricFlushDoesNotWriteEveryPoll(t *testing.T) {
	s, _ := newSQLite(t)
	ts := time.Now().Truncate(5 * time.Minute).Unix()
	for i, value := range []float64{100, 0, 50, 100} {
		if err := s.RecordMetric("dc.2.coverage_pct", MetricPoint{TS: ts + int64(i*5), Value: value}); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 0 {
		t.Fatalf("poll wrote to disk: count=%d, err=%v", count, err)
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	for _, tier := range []MetricTier{MetricTierFive, MetricTierHour} {
		var value, minimum, maximum float64
		var samples int
		if err := s.db.QueryRow("SELECT value, min_value, max, samples FROM metric_points WHERE tier = ?", tier).Scan(&value, &minimum, &maximum, &samples); err != nil {
			t.Fatal(err)
		}
		if math.Abs(value-62.5) > 1e-9 || minimum != 0 || maximum != 100 || samples != 4 {
			t.Fatalf("%s aggregate = %v/%v/%v samples=%d", tier, value, minimum, maximum, samples)
		}
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 2 {
		t.Fatalf("flush created extra tiers: count=%d, err=%v", count, err)
	}
}

func TestMetricFlushHourWriteBudget(t *testing.T) {
	s, _ := newSQLite(t)
	var before, after int64
	if err := s.db.QueryRow("SELECT total_changes()").Scan(&before); err != nil {
		t.Fatal(err)
	}
	// One series, an hour at ten-second polling and aligned flushes.
	for i := 0; i < 360; i++ {
		if err := s.RecordMetric("connections", MetricPoint{TS: int64(i * 10), Value: float64(i % 20)}); err != nil {
			t.Fatal(err)
		}
		if (i+1)%30 == 0 {
			if err := s.flushMetrics(); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := s.db.QueryRow("SELECT total_changes()").Scan(&after); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if after-before != 24 || rows != 13 {
		t.Fatalf("unexpected disk writes for 360 polls: writes=%d rows=%d", after-before, rows)
	}
}

func TestMetricFlushDoesNotReplayImportedHour(t *testing.T) {
	s, _ := newSQLite(t)
	if _, err := s.db.Exec(`INSERT INTO metric_points(name,category,tier,ts,value,max,samples,last_ts)
		VALUES ('connections','technical','1h',0,10,15,2,305)`); err != nil {
		t.Fatal(err)
	}
	for _, point := range []MetricPoint{{TS: 305, Value: 15}, {TS: 310, Value: 20}} {
		if err := s.RecordMetric("connections", point); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	var samples int
	var minimum *float64
	if err := s.db.QueryRow("SELECT samples,min_value FROM metric_points WHERE tier='1h'").Scan(&samples, &minimum); err != nil {
		t.Fatal(err)
	}
	if samples != 3 || minimum != nil {
		t.Fatalf("legacy hour replayed or unknown minimum fabricated: samples=%d min=%v", samples, minimum)
	}
}

func TestMetricFlushResumesPartialBucketWithoutDoubleCounting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	s, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Now().Truncate(5 * time.Minute).Unix()
	for _, p := range []MetricPoint{{TS: ts, Value: 10}, {TS: ts + 5, Value: 20}} {
		if err := s.RecordMetric("attempts", p); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, p := range []MetricPoint{{TS: ts + 5, Value: 20}, {TS: ts + 10, Value: 30}} {
		if err := s.RecordMetric("attempts", p); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	for _, tier := range []MetricTier{MetricTierFive, MetricTierHour} {
		var samples, observed int64
		var value, delta float64
		if err := s.db.QueryRow("SELECT value, samples, delta, observed_seconds FROM metric_points WHERE tier = ?", tier).Scan(&value, &samples, &delta, &observed); err != nil {
			t.Fatal(err)
		}
		if value != 30 || samples != 3 || delta != 20 || observed != 10 {
			t.Fatalf("%s resumed aggregate: value=%v, samples=%d, delta=%v, observed=%d", tier, value, samples, delta, observed)
		}
	}
}

func TestMetricFlushRollbackRetainsPendingSamples(t *testing.T) {
	s, _ := newSQLite(t)
	if _, err := s.db.Exec("CREATE TRIGGER fail_metric_flush BEFORE INSERT ON metric_points WHEN NEW.name = 'refusals' BEGIN SELECT RAISE(ABORT, 'test failure'); END"); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordMetrics([]NamedMetricPoint{{Name: "connections", Point: MetricPoint{TS: 300, Value: 1}}, {Name: "refusals", Point: MetricPoint{TS: 300, Value: 2}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.flushMetrics(); err == nil {
		t.Fatal("flush unexpectedly succeeded")
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial transaction survived: %d, %v", count, err)
	}
	if _, err := s.db.Exec("DROP TRIGGER fail_metric_flush"); err != nil {
		t.Fatal(err)
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points WHERE samples = 1").Scan(&count); err != nil || count != 4 {
		t.Fatalf("retry lost or duplicated samples: %d, %v", count, err)
	}
}

func TestMetricFlushPurgeDoesNotResurrectPendingSamples(t *testing.T) {
	s, _ := newSQLite(t)
	if err := s.RecordMetric("traffic", MetricPoint{TS: 300, Value: 100}); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeHistory(StorageTraffic); err != nil {
		t.Fatal(err)
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 0 {
		t.Fatalf("purged metrics resurrected: %d, %v", count, err)
	}
}

func TestMetricFlushRetainsHourlyArchiveAfterFineExpiry(t *testing.T) {
	s, _ := newSQLite(t)
	policies := DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageTechnical {
			policies[i].RetentionDays = 30
		}
	}
	if err := s.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	old := now.Add(-8 * 24 * time.Hour).Truncate(time.Hour).Unix()
	if err := s.RecordMetric("connections", MetricPoint{TS: old, Value: 20}); err != nil {
		t.Fatal(err)
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pruneMetricBatch(now, 250); err != nil {
		t.Fatal(err)
	}
	var fine, hours int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points WHERE tier = '5m'").Scan(&fine); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points WHERE tier = '1h'").Scan(&hours); err != nil {
		t.Fatal(err)
	}
	if fine != 0 || hours != 1 {
		t.Fatalf("fine expiry lost archive or retained fine detail: fine=%d, hours=%d", fine, hours)
	}
}

func TestMetricFlushLeavesStateIndicatorsInRAM(t *testing.T) {
	s, _ := newSQLite(t)
	names := []string{"telemt.available", "telemt.unavailable", "mode.route", "dc.coverage_pct", "upstream.healthy_total", "upstream.0.healthy", "upstream.0.unhealthy"}
	for _, name := range names {
		if err := s.RecordMetric(name, MetricPoint{TS: 300, Value: 1}); err != nil {
			t.Fatal(err)
		}
		live, err := s.MetricRange(name, 0)
		if err != nil || len(live) != 1 {
			t.Fatalf("live %s = %+v, %v", name, live, err)
		}
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 0 {
		t.Fatalf("state indicators were persisted instead of using transition events: %d, %v", count, err)
	}
}
