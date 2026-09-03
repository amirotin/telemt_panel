//go:build !lite

package store

import (
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
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
	if info := reopened.Info(); info.Schema != 8 {
		t.Fatalf("schema version = %d, want 8", info.Schema)
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

	var value, max float64
	var samples int64
	if err := store.queryRow(`SELECT value, max, samples FROM metric_points WHERE name = ? AND tier = ? AND ts = ?`, "connections", "1m", metricBucket(now, time.Minute)).Scan(&value, &max, &samples); err != nil {
		t.Fatal(err)
	}
	if value != 15 || max != 20 || samples != 2 {
		t.Fatalf("minute bucket = avg %v, max %v, samples %d; want 15, 20, 2", value, max, samples)
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
	if err := store.queryRow(`SELECT value, max, samples FROM metric_points WHERE name = ? AND tier = ? AND ts = ?`, "traffic", "1m", metricBucket(now, time.Minute)).Scan(&value, &max, &samples); err != nil {
		t.Fatal(err)
	}
	if value != 160 || max != 160 || samples != 2 {
		t.Fatalf("minute counter = last %v, max %v, samples %d; want 160, 160, 2", value, max, samples)
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

	points, err := store.MetricRange("connections", old)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].Tier != MetricTierQuarter || points[0].Value != 20 || points[0].Max != 30 || points[0].Samples != 2 {
		t.Fatalf("old range = %+v, want one 15m avg=20 max=30 samples=2", points)
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

func TestSQLiteMigratesVersionTwoMetricHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	store, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	point := MetricPoint{TS: time.Now().Add(-time.Hour).Unix(), Value: 42}
	if err := store.RecordMetric("connections", point); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := sqlitedriver.Open("file:" + path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`DROP INDEX metric_points_category_tier_ts`,
		`CREATE TABLE metric_points_v2 (name TEXT NOT NULL, category TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY(name, ts)) WITHOUT ROWID, STRICT`,
		`INSERT INTO metric_points_v2(name, category, ts, value) SELECT name, category, ts, value FROM metric_points WHERE tier = 'raw'`,
		`DROP TABLE metric_points`,
		`DROP TABLE history_events`,
		`ALTER TABLE metric_points_v2 RENAME TO metric_points`,
		`PRAGMA user_version = 2`,
	} {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			t.Fatalf("prepare v2 database (%s): %v", statement, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	if got := migrated.Info().Schema; got != 8 {
		t.Fatalf("schema = %d, want 8", got)
	}
	points, err := migrated.MetricRange("connections", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0] != point {
		t.Fatalf("migrated points = %+v, want %+v", points, point)
	}
}

func TestSQLiteMigrationEightDropsDevelopmentStateTables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	store, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RecordMetric("connections", MetricPoint{TS: time.Now().Unix(), Value: 42}); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{
		"sessions", "audit_entries", "update_journal", "subpage_nonces",
		"settings", "storage_policies", "auth_totp", "auth_recovery_codes",
		"auth_webauthn_user", "auth_webauthn_credentials", "auth_webauthn_challenges",
	} {
		if _, err := store.db.Exec(`CREATE TABLE ` + table + ` (id INTEGER)`); err != nil {
			t.Fatalf("create development table %s: %v", table, err)
		}
	}
	if _, err := store.db.Exec(`PRAGMA user_version = 7`); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	if got := migrated.Info().Schema; got != 8 {
		t.Fatalf("schema = %d, want 8", got)
	}
	var stateTables int
	if err := migrated.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN (` +
		`'sessions','audit_entries','update_journal','subpage_nonces','settings','storage_policies',` +
		`'auth_totp','auth_recovery_codes','auth_webauthn_user','auth_webauthn_credentials','auth_webauthn_challenges')`).Scan(&stateTables); err != nil {
		t.Fatal(err)
	}
	if stateTables != 0 {
		t.Fatalf("schema migration retained %d control-plane tables", stateTables)
	}
	if points, err := migrated.MetricRange("connections", 0); err != nil || len(points) != 1 {
		t.Fatalf("history was not preserved: %+v, %v", points, err)
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
	if got := store.MetricRetention("traffic"); got != 0 {
		t.Fatalf("disabled traffic retention = %v", got)
	}
	if err := store.RecordMetric("traffic", MetricPoint{TS: time.Now().Unix(), Value: 10}); err != nil {
		t.Fatal(err)
	}
	if got, err := store.MetricRange("traffic", 0); err != nil || len(got) != 0 {
		t.Fatalf("disabled traffic persisted: %+v, %v", got, err)
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

func TestSQLiteRejectsDisabledTechnicalHistory(t *testing.T) {
	store, _ := newSQLite(t)
	policies, _ := store.ListStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageTechnical {
			policies[i].Enabled = false
		}
	}
	if err := store.ApplyStoragePolicies(policies); err == nil {
		t.Fatal("ReplaceStoragePolicies accepted disabled technical history")
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
	for _, forbidden := range []string{"sessions", "settings", "auth_totp", "auth_webauthn_credentials", "storage_policies", "audit_entries"} {
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
