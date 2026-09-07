//go:build !lite

package store

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

func seedExpiredMetrics(t *testing.T, s *SQLite, now time.Time, count int) {
	t.Helper()
	if err := s.withOperationTx(func(tx *sql.Tx) error {
		stmt, err := tx.Prepare(`INSERT INTO metric_points(name, category, tier, ts, value, max, samples, last_ts)
			VALUES (?, 'technical', '5m', ?, 1, 1, 1, ?)`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		ts := now.Add(-8 * 24 * time.Hour).Unix()
		for i := 0; i < count; i++ {
			if _, err := stmt.Exec(fmt.Sprintf("dc.%d.rtt", i), ts, ts); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryMaintenanceCatchesUpWithoutGrowingTransactions(t *testing.T) {
	s, _ := newSQLite(t)
	now := time.Now().Truncate(time.Hour)
	// More rows expire per five-minute interval than one old maintenance batch.
	// The first interval also includes a backlog from a stopped panel.
	for interval := 0; interval < 3; interval++ {
		rows := 400
		if interval == 0 {
			rows += 1200
		}
		seedExpiredMetrics(t, s, now, rows)
		elapsed := time.Duration(0)
		for pass := 0; ; pass++ {
			if pass > 20 {
				t.Fatal("maintenance did not drain the backlog")
			}
			delay := s.pruneHistoryPass(now.Add(elapsed))
			var remaining int
			if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&remaining); err != nil {
				t.Fatal(err)
			}
			if removed := rows - remaining; removed != min(rows, metricPruneBatchSize) {
				t.Fatalf("batch removed %d of %d rows", removed, rows)
			}
			rows = remaining
			if delay == metricMaintenanceInterval {
				if remaining != 0 || elapsed >= metricMaintenanceInterval {
					t.Fatalf("backlog=%d, simulated catch-up time=%s", remaining, elapsed)
				}
				t.Logf("interval %d: backlog drained in %d passes, scheduled pauses %s", interval, pass+1, elapsed)
				break
			}
			if delay != metricPruneCatchUpDelay {
				t.Fatalf("unexpected catch-up delay: %s", delay)
			}
			elapsed += delay
		}
		now = now.Add(metricMaintenanceInterval)
	}
}

func TestHistoryMaintenanceBacksOffOnDatabaseFailure(t *testing.T) {
	s, _ := newSQLite(t)
	now := time.Now()
	seedExpiredMetrics(t, s, now, metricPruneBatchSize+1)
	if _, err := s.db.Exec(`CREATE TRIGGER fail_history_prune BEFORE DELETE ON metric_points
		BEGIN SELECT RAISE(ABORT, 'test prune failure'); END`); err != nil {
		t.Fatal(err)
	}
	if delay := s.pruneHistoryPass(now); delay != metricMaintenanceInterval {
		t.Fatalf("failure retries too soon: %s", delay)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != metricPruneBatchSize+1 {
		t.Fatalf("failed delete lost rows: %d, %v", count, err)
	}
	if _, err := s.db.Exec("DROP TRIGGER fail_history_prune"); err != nil {
		t.Fatal(err)
	}
	if delay := s.pruneHistoryPass(now); delay != metricPruneCatchUpDelay {
		t.Fatalf("recovered database did not resume catch-up: %s", delay)
	}
}

func TestMetricRetentionPolicyBoundaries(t *testing.T) {
	for _, days := range []int{7, 30, 90} {
		t.Run(fmt.Sprint(days), func(t *testing.T) {
			s, _ := newSQLite(t)
			policies := DefaultStoragePolicies()
			for i := range policies {
				if policies[i].Category == StorageTechnical {
					policies[i].RetentionDays = days
				}
			}
			if err := s.ApplyStoragePolicies(policies); err != nil {
				t.Fatal(err)
			}
			now := time.Now().Truncate(time.Hour)
			for _, tier := range []MetricTier{MetricTierFive, MetricTierHour} {
				age := days
				if tier == MetricTierFive {
					age = min(days, 7)
				}
				cutoff := now.Add(-time.Duration(age) * 24 * time.Hour).Unix()
				for _, ts := range []int64{cutoff - 1, cutoff, cutoff + 1} {
					if _, err := s.db.Exec(`INSERT INTO metric_points(name, category, tier, ts, value, max, samples, last_ts)
						VALUES ('connections', 'technical', ?, ?, 1, 1, 1, ?)`, tier, ts, ts); err != nil {
						t.Fatal(err)
					}
				}
			}
			removed, err := s.pruneMetricBatch(now, metricPruneBatchSize)
			if err != nil || removed != 2 {
				t.Fatalf("boundary pruning: removed=%d err=%v", removed, err)
			}
			var count int
			if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 4 {
				t.Fatalf("in-retention rows lost: %d, %v", count, err)
			}
		})
	}
}

func TestMetricRetentionDisableAndShorten(t *testing.T) {
	s, _ := newSQLite(t)
	now := time.Now().Truncate(time.Hour)
	policies := DefaultStoragePolicies()
	setPolicy := func(enabled bool, days int) {
		t.Helper()
		for i := range policies {
			if policies[i].Category == StorageTechnical {
				policies[i].Enabled = enabled
				policies[i].RetentionDays = days
			}
		}
		if err := s.ApplyStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
	}
	setPolicy(true, 90)
	for _, age := range []int{10, 45} {
		ts := now.Add(-time.Duration(age) * 24 * time.Hour).Unix()
		if _, err := s.db.Exec(`INSERT INTO metric_points(name, category, tier, ts, value, max, samples, last_ts)
			VALUES ('connections', 'technical', '1h', ?, 1, 1, 1, ?)`, ts, ts); err != nil {
			t.Fatal(err)
		}
	}
	assertPruned := func(want int) {
		t.Helper()
		if removed, err := s.pruneMetricBatch(now, metricPruneBatchSize); err != nil || removed != want {
			t.Fatalf("removed=%d want=%d err=%v", removed, want, err)
		}
	}
	assertPruned(0)
	setPolicy(false, 30)
	// Disabling does not purge the archive. Fine-tier expiry is independent.
	assertPruned(0)
	if err := s.RecordMetric("connections", MetricPoint{TS: now.Unix(), Value: 42}); err != nil {
		t.Fatal(err)
	}
	if err := s.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	live, err := s.MetricRange("connections", now.Add(-time.Minute).Unix())
	if err != nil || len(live) != 1 || live[0].Value != 42 {
		t.Fatalf("disabled history lost live data: %+v, %v", live, err)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 2 {
		t.Fatalf("disabled history wrote to disk: %d, %v", count, err)
	}
	setPolicy(true, 30)
	assertPruned(1)
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 1 {
		t.Fatalf("shorter retention lost current archive: %d, %v", count, err)
	}
	setPolicy(true, 90)
	assertPruned(0)
	if err := s.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 1 {
		t.Fatalf("longer retention recreated history: %d, %v", count, err)
	}
}

func TestHistoryMaintenanceCatchesUpEventsIndependently(t *testing.T) {
	s, _ := newSQLite(t)
	now := time.Now()
	if err := s.withOperationTx(func(tx *sql.Tx) error {
		for i := 0; i <= metricPruneBatchSize; i++ {
			if _, err := tx.Exec(`INSERT INTO history_events(ts_ns, category, kind, entity, state, previous_state, severity, attributes_json)
				VALUES (?, 'events', 'route.changed', 'route', 'direct', 'me', 'info', '{}')`, now.Add(-31*24*time.Hour).UnixNano()); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if delay := s.pruneHistoryPass(now); delay != metricPruneCatchUpDelay {
		t.Fatalf("events did not request catch-up: %s", delay)
	}
	if delay := s.pruneHistoryPass(now); delay != metricMaintenanceInterval {
		t.Fatalf("empty queue did not return to normal interval: %s", delay)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM history_events").Scan(&count); err != nil || count != 0 {
		t.Fatalf("event backlog remains: %d, %v", count, err)
	}
}
