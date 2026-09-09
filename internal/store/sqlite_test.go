//go:build !lite

package store

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"
)

func newSQLite(t *testing.T) (*SQLite, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "panel.db")
	store, err := NewSQLite(path)
	if err != nil {
		t.Fatalf("NewSQLite: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store, path
}

func TestSQLiteRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	store, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 2, 12, 0, 0, 123, time.UTC)
	if err := store.RecordMetric("connections", MetricPoint{TS: now.Unix(), Value: 42}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendHistoryEvent(HistoryEvent{TS: now, Category: StorageEvents, Kind: "route.changed", Entity: "route", State: "direct", PreviousState: "me", Severity: "warning"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if info := reopened.Info(); info.Schema != 11 {
		t.Fatalf("schema version = %d, want 11", info.Schema)
	}
	if got, err := reopened.MetricRange("connections", 0); err != nil || len(got) != 1 || got[0].Value != 42 {
		t.Fatalf("MetricRange = %+v, %v", got, err)
	}
	if got, err := reopened.ListHistoryEvents(HistoryEventFilter{Category: StorageEvents}); err != nil || len(got) != 1 || got[0].Kind != "route.changed" {
		t.Fatalf("ListHistoryEvents = %+v, %v", got, err)
	}
}

func TestSQLiteMetricTiersPreserveGaugeAverageAndPeak(t *testing.T) {
	store, _ := newSQLite(t)
	now := time.Now().Truncate(time.Minute).Add(10 * time.Second).Unix()
	for _, point := range []MetricPoint{
		{TS: now, Value: 10},
		{TS: now + 5, Value: 20},
	} {
		if err := store.RecordMetric("connections", point); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	var value, max float64
	var samples int64
	if err := store.queryRow(`SELECT value, max, samples FROM metric_points WHERE name = ? AND tier = ? AND ts = ?`, "connections", "5m", metricBucket(now, 5*time.Minute)).Scan(&value, &max, &samples); err != nil {
		t.Fatal(err)
	}
	if value != 15 || max != 20 || samples != 2 {
		t.Fatalf("five-minute bucket = avg %v, max %v, samples %d; want 15, 20, 2", value, max, samples)
	}
}

func TestSQLiteMetricTiersPreserveCounterLastValue(t *testing.T) {
	store, _ := newSQLite(t)
	now := time.Now().Truncate(time.Minute).Add(10 * time.Second).Unix()
	for _, point := range []MetricPoint{
		{TS: now, Value: 100},
		{TS: now + 5, Value: 160},
	} {
		if err := store.RecordMetric("traffic", point); err != nil {
			t.Fatal(err)
		}
	}

	var value, max float64
	var samples int64
	if err := store.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	if err := store.queryRow(`SELECT value, max, samples FROM metric_points WHERE name = ? AND tier = ? AND ts = ?`, "traffic", "5m", metricBucket(now, 5*time.Minute)).Scan(&value, &max, &samples); err != nil {
		t.Fatal(err)
	}
	if value != 160 || max != 160 || samples != 2 {
		t.Fatalf("five-minute counter = last %v, max %v, samples %d; want 160, 160, 2", value, max, samples)
	}
}

func TestSQLiteMetricRangeUsesAggregateForOldData(t *testing.T) {
	store, _ := newSQLite(t)
	old := time.Now().Add(-48 * time.Hour).Truncate(15 * time.Minute).Unix()
	for _, point := range []MetricPoint{
		{TS: old + 10, Value: 10},
		{TS: old + 20, Value: 30},
	} {
		if err := store.RecordMetric("connections", point); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	points, err := store.MetricRange("connections", old)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].Tier != MetricTierFive || points[0].Value != 20 || points[0].Max != 30 || points[0].Samples != 2 {
		t.Fatalf("old range = %+v, want one 5m avg=20 max=30 samples=2", points)
	}
}

func TestSQLiteMetricRetentionPrunesInBoundedBatches(t *testing.T) {
	store, _ := newSQLite(t)
	old := time.Now().Add(-8 * 24 * time.Hour).Unix()
	for i := int64(0); i < 3; i++ {
		if _, err := store.exec(`INSERT INTO metric_points(name, category, tier, ts, value, max, samples, last_ts) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, "connections", StorageTechnical, metricTierRawSQL, old+i, 1, 1, 1, old+i); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := store.pruneMetricBatch(time.Now(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Fatalf("removed = %d, want bounded batch of 2", removed)
	}
	var remaining int
	if err := store.queryRow(`SELECT count(*) FROM metric_points WHERE name = ?`, "connections").Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatalf("remaining = %d, want 1", remaining)
	}
}

func TestSQLiteEventRetentionPrunesInBoundedBatches(t *testing.T) {
	store, _ := newSQLite(t)
	old := time.Now().Add(-31 * 24 * time.Hour)
	for i := 0; i < 3; i++ {
		if err := store.AppendHistoryEvent(HistoryEvent{TS: old.Add(time.Duration(i) * time.Second), Category: StorageEvents, Kind: "test.changed", Entity: "test", State: "new", PreviousState: "old", Severity: "info"}); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := store.pruneHistoryEventBatch(time.Now(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Fatalf("removed = %d, want bounded batch of 2", removed)
	}
	events, err := store.ListHistoryEvents(HistoryEventFilter{Category: StorageEvents})
	if err != nil || len(events) != 1 {
		t.Fatalf("events = %+v, %v; want 1", events, err)
	}
}

func TestSQLiteDisabledEventsAreNotPruned(t *testing.T) {
	store, _ := newSQLite(t)
	if err := store.AppendHistoryEvent(HistoryEvent{TS: time.Now().Add(-31 * 24 * time.Hour), Category: StorageEvents, Kind: "test.changed", Entity: "test", State: "new", PreviousState: "old", Severity: "info"}); err != nil {
		t.Fatal(err)
	}
	policies, err := store.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		if policies[i].Category == StorageEvents {
			policies[i].Enabled = false
		}
	}
	if err := store.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	removed, err := store.pruneHistoryEventBatch(time.Now(), 10)
	if err != nil || removed != 0 {
		t.Fatalf("disabled prune = %d, %v", removed, err)
	}
	events, err := store.ListHistoryEvents(HistoryEventFilter{Category: StorageEvents})
	if err != nil || len(events) != 1 {
		t.Fatalf("disabled history changed: %+v, %v", events, err)
	}
}

func TestSQLiteRejectsFutureSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	opened, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := opened.db.Exec(`PRAGMA user_version = 999`); err != nil {
		t.Fatal(err)
	}
	if err := opened.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSQLite(path); err == nil {
		t.Fatal("NewSQLite accepted a schema newer than this binary")
	}
}

func TestSQLiteCloseIsConcurrentSafe(t *testing.T) {
	store, _ := newSQLite(t)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- store.Close()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent Close: %v", err)
		}
	}
}

func TestSQLiteUserTrafficAggregateSelectsNonOverlappingTiers(t *testing.T) {
	st, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Now().UTC().Truncate(time.Minute)
	started := now.Add(-60 * 24 * time.Hour).Unix()
	raw := uint64(100)
	snapshots := []struct {
		at    time.Time
		delta uint64
	}{
		{now.Add(-32 * 24 * time.Hour), 0},
		{now.Add(-31 * 24 * time.Hour), 11},
		{now.Add(-29 * 24 * time.Hour), 22},
		{now.Add(-23 * time.Hour), 33},
		{now.Add(-time.Minute), 44},
	}
	for _, item := range snapshots {
		raw += item.delta
		if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
			ObservedAt: item.at.Unix(), SourceStartedAt: started, TelemetryEnabled: true,
			Users: []UserTrafficObservation{{Username: "alice", RawOctets: raw}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	total, points, err := st.UserTrafficAggregate(now.Add(-365*24*time.Hour).Unix(), now.Unix())
	if err != nil {
		t.Fatal(err)
	}
	if total != 110 {
		t.Fatalf("aggregate total = %d, want 110; points=%+v", total, points)
	}
}

func TestSQLiteUserTrafficSnapshotHandlesTwoThousandUsers(t *testing.T) {
	st, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Now().UTC().Truncate(time.Second)
	users := make([]UserTrafficObservation, 2000)
	for i := range users {
		users[i] = UserTrafficObservation{Username: fmt.Sprintf("user-%04d", i), RawOctets: 100}
	}
	if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
		ObservedAt: now.Add(-time.Minute).Unix(), SourceStartedAt: now.Add(-time.Hour).Unix(),
		TelemetryEnabled: true, Users: users,
	}); err != nil {
		t.Fatal(err)
	}
	var want int64
	for i := range users {
		users[i].RawOctets += uint64(100 + i)
		want += int64(100 + i)
	}
	started := time.Now()
	result, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
		ObservedAt: now.Unix(), SourceStartedAt: now.Add(-time.Hour).Unix(),
		TelemetryEnabled: true, Users: users,
	})
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("2000-user snapshot took %v", elapsed)
	}
	if result.DeltaBytes != want {
		t.Fatalf("delta = %d, want %d", result.DeltaBytes, want)
	}
	summaries, err := st.UserTrafficSummaries()
	if err != nil || len(summaries) != 2000 {
		t.Fatalf("summaries = %d, %v", len(summaries), err)
	}
}

func TestSQLiteUserTrafficFullDayLoad(t *testing.T) {
	if os.Getenv("TELEMT_PANEL_TRAFFIC_LOAD_TEST") != "1" {
		t.Skip("set TELEMT_PANEL_TRAFFIC_LOAD_TEST=1 to run the 24-hour traffic simulation")
	}
	st, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	const userCount = 2000
	const activeCount = 200
	const ticks = 24 * 60 * 2
	users := make([]UserTrafficObservation, userCount)
	for index := range users {
		users[index] = UserTrafficObservation{Username: fmt.Sprintf("user-%04d", index), RawOctets: 100}
	}
	start := time.Now().UTC().Truncate(15 * time.Minute).Add(-24 * time.Hour)
	source := start.Add(-time.Hour).Unix()
	if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
		ObservedAt: start.Unix(), SourceStartedAt: source, TelemetryEnabled: true, Users: users,
	}); err != nil {
		t.Fatal(err)
	}
	var slowest time.Duration
	for tick := 1; tick <= ticks; tick++ {
		for index := 0; index < activeCount; index++ {
			users[index].RawOctets += uint64(100 + index%17)
		}
		started := time.Now()
		if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
			ObservedAt:      start.Add(time.Duration(tick) * 30 * time.Second).Unix(),
			SourceStartedAt: source, TelemetryEnabled: true, Users: users,
		}); err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		if elapsed := time.Since(started); elapsed > slowest {
			slowest = elapsed
		}
	}
	if slowest > 2*time.Second {
		t.Fatalf("slowest collector transaction = %v", slowest)
	}
	var bucketCount int
	if err := st.db.QueryRow(`SELECT count(*) FROM user_traffic_buckets`).Scan(&bucketCount); err != nil {
		t.Fatal(err)
	}
	if bucketCount > activeCount*(97+25+2) {
		t.Fatalf("bucket rows = %d; zero intervals appear to create rows", bucketCount)
	}
	started := time.Now()
	if _, err := st.UserTrafficRanking(start.Unix(), start.Add(24*time.Hour).Unix(), false, 50, nil); err != nil {
		t.Fatal(err)
	}
	rankingElapsed := time.Since(started)
	if rankingElapsed > 2*time.Second {
		t.Fatalf("ranking query took %v", rankingElapsed)
	}
	size := st.Info().SizeHint
	if size > 128<<20 {
		t.Fatalf("database and WAL use %d bytes", size)
	}
	t.Logf("slowest collector=%v, ranking=%v, buckets=%d, db+wal=%d bytes", slowest, rankingElapsed, bucketCount, size)
}

func TestSQLiteUserTrafficRetentionPrunesEachTierIndependently(t *testing.T) {
	st, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Now().UTC().Truncate(time.Hour)
	if _, err := st.ApplyUserTrafficSnapshot(UserTrafficSnapshot{
		ObservedAt: now.Unix(), SourceStartedAt: now.Add(-time.Hour).Unix(), TelemetryEnabled: true,
		Users: []UserTrafficObservation{{Username: "alice", RawOctets: 100}},
	}); err != nil {
		t.Fatal(err)
	}
	var userID int64
	if err := st.db.QueryRow(`SELECT id FROM user_traffic_users WHERE username = 'alice'`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	rows := []struct {
		tier int
		ts   int64
	}{
		{0, now.Add(-25 * time.Hour).Unix()}, {0, now.Add(-23 * time.Hour).Unix()},
		{1, now.Add(-31 * 24 * time.Hour).Unix()}, {1, now.Add(-29 * 24 * time.Hour).Unix()},
		{2, now.Add(-366 * 24 * time.Hour).Unix()}, {2, now.Add(-364 * 24 * time.Hour).Unix()},
	}
	for _, row := range rows {
		if _, err := st.db.Exec(`INSERT INTO user_traffic_buckets(user_id, tier, ts, bytes) VALUES(?, ?, ?, 1)`, userID, row.tier, row.ts); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := st.pruneUserTrafficBatch(now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 3 {
		t.Fatalf("removed rows = %d, want 3", removed)
	}
	for tier := range 3 {
		var count int
		if err := st.db.QueryRow(`SELECT count(*) FROM user_traffic_buckets WHERE user_id = ? AND tier = ?`, userID, tier).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("tier %d rows = %d, want 1", tier, count)
		}
	}
}

func TestSQLitePoliciesControlWritesAndRetention(t *testing.T) {
	store, _ := newSQLite(t)
	policies, err := store.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		switch policies[i].Category {
		case StorageTechnical:
			policies[i].RetentionDays = 14
		case StorageTraffic:
			policies[i].Enabled = false
		}
	}
	if err := store.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if got := store.MetricRetention("connections"); got != 14*24*time.Hour {
		t.Fatalf("technical retention = %v", got)
	}
	if got := store.MetricRetention("traffic"); got != LiveMetricRetention {
		t.Fatalf("disabled traffic retention = %v", got)
	}
	if err := store.RecordMetric("traffic", MetricPoint{TS: time.Now().Unix(), Value: 10}); err != nil {
		t.Fatal(err)
	}
	if got, err := store.MetricRange("traffic", 0); err != nil || len(got) != 1 {
		t.Fatalf("live traffic unavailable: %+v, %v", got, err)
	}
	var persisted int
	if err := store.db.QueryRow("SELECT count(*) FROM metric_points WHERE name = 'traffic'").Scan(&persisted); err != nil || persisted != 0 {
		t.Fatalf("disabled disk history: count=%d, err=%v", persisted, err)
	}

	for i := range policies {
		if policies[i].Category == StorageTraffic {
			policies[i].Enabled = true
		}
	}
	if err := store.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordMetric("traffic", MetricPoint{TS: time.Now().Unix(), Value: 20}); err != nil {
		t.Fatal(err)
	}
	if got, err := store.MetricRange("traffic", 0); err != nil || len(got) != 1 || got[0].Value != 20 {
		t.Fatalf("re-enabled traffic did not persist: %+v, %v", got, err)
	}
}

func TestSQLiteReducingRetentionPrunesOnlyExpiredRows(t *testing.T) {
	store, _ := newSQLite(t)
	policies, err := store.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		if policies[i].Category == StorageTechnical {
			policies[i].RetentionDays = 30
		}
	}
	if err := store.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	old := now.Add(-10 * 24 * time.Hour).Unix()
	recent := now.Add(-12 * time.Hour).Unix()
	for _, ts := range []int64{old, recent} {
		if _, err := store.exec(`INSERT INTO metric_points(name, category, tier, ts, value, max, samples, last_ts) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, "connections", StorageTechnical, MetricTierQuarter, ts, 1, 1, 1, ts); err != nil {
			t.Fatal(err)
		}
	}

	for i := range policies {
		if policies[i].Category == StorageTechnical {
			policies[i].RetentionDays = 7
		}
	}
	if err := store.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	removed, err := store.pruneMetricBatch(now, metricPruneBatchSize)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed metric rows = %d, want 1", removed)
	}
	var timestamps []int64
	rows, err := store.query(`SELECT ts FROM metric_points WHERE name = ? AND tier = ? ORDER BY ts`, "connections", MetricTierQuarter)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var ts int64
		if err := rows.Scan(&ts); err != nil {
			t.Fatal(err)
		}
		timestamps = append(timestamps, ts)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(timestamps) != 1 || timestamps[0] != recent {
		t.Fatalf("timestamps after retention reduction = %v, want [%d]", timestamps, recent)
	}
}

func TestSQLiteAllowsDisabledTechnicalHistory(t *testing.T) {
	store, _ := newSQLite(t)
	policies, _ := store.ListStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageTechnical {
			policies[i].Enabled = false
		}
	}
	if err := store.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordMetric("connections", MetricPoint{TS: time.Now().Unix(), Value: 12}); err != nil {
		t.Fatal(err)
	}
	if err := store.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRow("SELECT count(*) FROM metric_points").Scan(&count); err != nil || count != 0 {
		t.Fatalf("disabled history persisted: %d %v", count, err)
	}
	if live, err := store.MetricRange("connections", 0); err != nil || len(live) != 1 {
		t.Fatalf("disabled history lost live graph: %v %v", live, err)
	}
}

func TestSQLitePurgeIsIndependentFromPolicy(t *testing.T) {
	store, _ := newSQLite(t)
	now := time.Now().Unix()
	if err := store.RecordMetric("connections", MetricPoint{TS: now, Value: 1}); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordMetric("traffic", MetricPoint{TS: now, Value: 2}); err != nil {
		t.Fatal(err)
	}
	if err := store.PurgeHistory(StorageTraffic); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.MetricRange("traffic", 0); len(got) != 0 {
		t.Fatalf("traffic after purge = %+v", got)
	}
	if got, _ := store.MetricRange("connections", 0); len(got) != 1 {
		t.Fatalf("technical history affected by traffic purge: %+v", got)
	}
	if store.MetricRetention("traffic") == 0 {
		t.Fatal("purge unexpectedly disabled future traffic writes")
	}
}

func TestStateFileRemainsSeparateFromSQLiteHistory(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "panel-state.json")
	state, err := NewState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	if err := state.PutSession(Session{IDHash: "local-state", Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	if err := state.SetSetting("location", "state-file"); err != nil {
		t.Fatal(err)
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}

	dbPath := filepath.Join(dir, "panel.db")
	history, err := NewSQLite(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	reopenedState, err := NewState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := NewComposite(reopenedState, history)
	if err != nil {
		t.Fatal(err)
	}
	defer combined.Close()
	if _, ok, err := combined.GetSession("local-state"); err != nil || !ok {
		t.Fatalf("state-file session missing: ok=%v err=%v", ok, err)
	}
	if got, ok, err := combined.GetSetting("location"); err != nil || !ok || got != "state-file" {
		t.Fatalf("state-file setting = %q, %v, %v", got, ok, err)
	}
	rows, err := history.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"sessions", "settings", "auth_webauthn_credentials", "storage_policies", "audit_entries"} {
		if slices.Contains(tables, forbidden) {
			t.Fatalf("control-plane table %q leaked into history database: %v", forbidden, tables)
		}
	}
}

func TestSQLiteRejectsCorruptDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	if err := os.WriteFile(path, []byte("not a sqlite database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSQLite(path); err == nil {
		t.Fatal("NewSQLite accepted a corrupt database")
	}
}

func TestSQLitePreservesExistingDirectoryPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	store, err := NewSQLite(filepath.Join(dir, "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("existing directory permissions changed to %o", got)
	}
}
