//go:build !lite

package store

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

var frozenSQLiteSchema11 = map[string]string{
	"index:history_events_category_ts":        "CREATE INDEX history_events_category_ts ON history_events(category, ts_ns DESC, seq DESC)",
	"index:history_events_kind_ts":            "CREATE INDEX history_events_kind_ts ON history_events(kind, ts_ns DESC, seq DESC)",
	"index:metric_points_category_tier_ts":    "CREATE INDEX metric_points_category_tier_ts ON metric_points(category, tier, ts)",
	"index:user_ip_history_last":              "CREATE INDEX user_ip_history_last ON user_ip_history(last_ts, username, ip)",
	"index:user_ip_history_user_last":         "CREATE INDEX user_ip_history_user_last ON user_ip_history(username, last_ts DESC, ip)",
	"index:user_traffic_buckets_tier_ts_user": "CREATE INDEX user_traffic_buckets_tier_ts_user ON user_traffic_buckets(tier, ts, user_id)",
	"table:history_events":                    "CREATE TABLE history_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts_ns INTEGER NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, entity TEXT NOT NULL, state TEXT NOT NULL, previous_state TEXT NOT NULL, severity TEXT NOT NULL, attributes_json TEXT NOT NULL) STRICT",
	"table:metric_points":                     "CREATE TABLE metric_points (name TEXT NOT NULL, category TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('raw', '1m', '5m', '15m', '1h')), ts INTEGER NOT NULL, value REAL NOT NULL, max REAL NOT NULL, samples INTEGER NOT NULL CHECK(samples > 0), last_ts INTEGER NOT NULL, min_value REAL, first_ts INTEGER NOT NULL DEFAULT 0, first_value REAL NOT NULL DEFAULT 0, delta REAL, observed_seconds INTEGER NOT NULL DEFAULT 0 CHECK(observed_seconds >= 0), gaps INTEGER NOT NULL DEFAULT 0 CHECK(gaps >= 0), PRIMARY KEY(name, tier, ts)) WITHOUT ROWID, STRICT",
	"table:user_ip_history":                   "CREATE TABLE user_ip_history (username TEXT NOT NULL, ip TEXT NOT NULL, family INTEGER NOT NULL CHECK(family IN (4,6)), first_ts INTEGER NOT NULL CHECK(first_ts > 0), last_ts INTEGER NOT NULL CHECK(last_ts >= first_ts), observations INTEGER NOT NULL CHECK(observations > 0), last_active_ts INTEGER NOT NULL DEFAULT 0, source INTEGER NOT NULL CHECK(source BETWEEN 1 AND 3), PRIMARY KEY(username, ip)) WITHOUT ROWID, STRICT",
	"table:user_ip_history_collection":        "CREATE TABLE user_ip_history_collection (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), batch_id TEXT NOT NULL, since_ts INTEGER NOT NULL, through_ts INTEGER NOT NULL, limited INTEGER NOT NULL CHECK(limited IN (0,1)), gap INTEGER NOT NULL CHECK(gap IN (0,1))) STRICT",
	"table:user_traffic_buckets":              "CREATE TABLE user_traffic_buckets (user_id INTEGER NOT NULL REFERENCES user_traffic_users(id) ON DELETE CASCADE, tier INTEGER NOT NULL CHECK(tier IN (0, 1, 2)), ts INTEGER NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0), PRIMARY KEY(user_id, tier, ts)) WITHOUT ROWID, STRICT",
	"table:user_traffic_collector":            "CREATE TABLE user_traffic_collector (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), last_success_ts INTEGER NOT NULL, source_started_at INTEGER NOT NULL, source_state TEXT NOT NULL CHECK(source_state IN ('collecting', 'paused', 'unavailable')), continuity TEXT NOT NULL CHECK(continuity IN ('normal', 'partial'))) STRICT",
	"table:user_traffic_users":                "CREATE TABLE user_traffic_users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0), since_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL, month_key INTEGER NOT NULL, month_bytes INTEGER NOT NULL CHECK(month_bytes >= 0), last_raw_octets INTEGER CHECK(last_raw_octets >= 0), last_source_started_at INTEGER, deleted_ts INTEGER, continuity TEXT NOT NULL CHECK(continuity IN ('normal', 'partial'))) STRICT",
}

func TestSQLiteFreshBaselineMatchesFrozenSchema11(t *testing.T) {
	store, _ := newSQLite(t)
	if got := sqliteLogicalSchema(t, store); !reflect.DeepEqual(got, frozenSQLiteSchema11) {
		t.Fatalf("fresh logical schema differs from frozen schema 11\n got: %#v\nwant: %#v", got, frozenSQLiteSchema11)
	}
}

func TestSQLiteVersion11PreservesSchemaAndEveryHistoryTable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	store, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO metric_points(name,category,tier,ts,value,max,samples,last_ts,min_value,first_ts,first_value,delta,observed_seconds,gaps) VALUES('connections','technical','5m',1900000000,7.5,9,3,1900000010,NULL,1899999990,6,NULL,20,2)`,
		`INSERT INTO history_events(seq,ts_ns,category,kind,entity,state,previous_state,severity,attributes_json) VALUES(41,1900000000000000000,'events','route.changed','route','direct','me','warning','{"reason":"test"}')`,
		`INSERT INTO user_traffic_users(id,username,total_bytes,since_ts,updated_ts,month_key,month_bytes,last_raw_octets,last_source_started_at,deleted_ts,continuity) VALUES(7,'alice',1000,1899999000,1900000000,203003,250,NULL,NULL,NULL,'partial')`,
		`INSERT INTO user_traffic_buckets(user_id,tier,ts,bytes) VALUES(7,2,1899936000,250)`,
		`INSERT INTO user_traffic_collector(singleton,last_success_ts,source_started_at,source_state,continuity) VALUES(1,1900000000,1899990000,'collecting','partial')`,
		`INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES('alice','2001:db8::1',6,1899999000,1900000000,4,1899999999,2)`,
		`INSERT INTO user_ip_history_collection(singleton,batch_id,since_ts,through_ts,limited,gap) VALUES(1,'batch-11',1899999000,1900000000,1,1)`,
	} {
		if _, err := store.db.Exec(statement); err != nil {
			store.Close()
			t.Fatalf("seed schema 11 (%s): %v", statement, err)
		}
	}
	wantSchema := sqliteLogicalSchema(t, store)
	wantRows := sqliteHistoryRows(t, store.db)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if got := reopened.Info().Schema; got != 11 {
		t.Fatalf("schema version = %d, want 11", got)
	}
	if got := sqliteLogicalSchema(t, reopened); !reflect.DeepEqual(got, wantSchema) {
		t.Fatalf("schema 11 was rewritten\n got: %#v\nwant: %#v", got, wantSchema)
	}
	if got := sqliteHistoryRows(t, reopened.db); !reflect.DeepEqual(got, wantRows) {
		t.Fatalf("schema 11 rows changed\n got: %#v\nwant: %#v", got, wantRows)
	}
}

func TestSQLiteRejectsEveryDevelopmentSchemaWithoutMutation(t *testing.T) {
	for version := 1; version <= 10; version++ {
		t.Run(fmt.Sprintf("version_%d", version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "panel.db")
			createSQLiteFixture(t, path, version, `CREATE TABLE legacy_marker(value TEXT)`, `INSERT INTO legacy_marker VALUES('keep')`)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			opened, openErr := Open(OpenOptions{Driver: "sqlite", Path: path})
			if opened != nil {
				opened.Close()
			}
			assertUnsupportedSQLiteSchema(t, openErr, version)
			assertFileUnchanged(t, path, before)
		})
	}
}

func TestSQLiteRejectsVersionZeroWithUserSchemaObjectsWithoutMutation(t *testing.T) {
	tests := []struct {
		name       string
		statements []string
	}{
		{name: "literal sqlite prefix lookalike table", statements: []string{`CREATE TABLE sqliteXcustom(value TEXT)`, `INSERT INTO sqliteXcustom VALUES('keep')`}},
		{name: "view", statements: []string{`CREATE VIEW custom_view AS SELECT 1 AS value`}},
		{name: "trigger", statements: []string{`CREATE TABLE trigger_owner(value INTEGER)`, `CREATE TRIGGER custom_trigger AFTER INSERT ON trigger_owner BEGIN UPDATE trigger_owner SET value = new.value; END`}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "panel.db")
			createSQLiteFixture(t, path, 0, test.statements...)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			opened, openErr := Open(OpenOptions{Driver: "sqlite", Path: path})
			if opened != nil {
				opened.Close()
			}
			assertUnsupportedSQLiteSchema(t, openErr, 0)
			assertFileUnchanged(t, path, before)
		})
	}
}

func TestSQLiteRejectsFutureSchemaWithoutMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	createSQLiteFixture(t, path, 12, `CREATE TABLE future_marker(value TEXT)`, `INSERT INTO future_marker VALUES('keep')`)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	opened, openErr := Open(OpenOptions{Driver: "sqlite", Path: path})
	if opened != nil {
		opened.Close()
	}
	assertUnsupportedSQLiteSchema(t, openErr, 12)
	assertFileUnchanged(t, path, before)
}

func TestSQLiteRejectsNegativeSchemaWithoutMutation(t *testing.T) {
	for _, test := range []struct {
		name       string
		statements []string
	}{
		{name: "empty"},
		{name: "populated", statements: []string{`CREATE TABLE negative_marker(value TEXT)`, `INSERT INTO negative_marker VALUES('keep')`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "panel.db")
			createSQLiteFixture(t, path, -1, test.statements...)
			beforeState := inspectRawSQLiteState(t, path)
			beforeBytes, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}

			opened, openErr := Open(OpenOptions{Driver: "sqlite", Path: path})
			if opened != nil {
				opened.Close()
			}
			assertUnsupportedSQLiteSchema(t, openErr, -1)
			assertFileUnchanged(t, path, beforeBytes)
			if afterState := inspectRawSQLiteState(t, path); !reflect.DeepEqual(afterState, beforeState) {
				t.Fatalf("negative schema changed\n got: %+v\nwant: %+v", afterState, beforeState)
			}
			for _, suffix := range []string{"-journal", "-wal", "-shm"} {
				if _, err := os.Lstat(path + suffix); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("negative schema left sidecar %s: %v", suffix, err)
				}
			}
		})
	}
}

func TestOpenClassifiesCorruptSQLiteAsRuntimeFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	if err := os.WriteFile(path, []byte("not a sqlite database"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Open(OpenOptions{Driver: "sqlite", Path: path})
	if err == nil || !IsRuntimeOpenError(err) {
		t.Fatalf("corrupt SQLite classification = %T %v, want runtime open error", err, err)
	}
	var unsupported interface{ UnsupportedSchemaVersions() (int, int) }
	if errors.As(err, &unsupported) {
		t.Fatalf("corrupt SQLite classified as unsupported schema: %T", err)
	}
}

func TestSQLiteConcurrentFreshInitialization(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			store, err := NewSQLite(path)
			if err == nil {
				err = store.Close()
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("parallel NewSQLite: %v", err)
		}
	}
	store, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if got := sqliteLogicalSchema(t, store); !reflect.DeepEqual(got, frozenSQLiteSchema11) {
		t.Fatalf("parallel initialization schema = %#v", got)
	}
}

func sqliteLogicalSchema(t *testing.T, store *SQLite) map[string]string {
	t.Helper()
	rows, err := store.db.Query(`SELECT type, name, sql FROM sqlite_schema
		WHERE sql IS NOT NULL AND substr(name, 1, 7) != 'sqlite_' ORDER BY type, name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var kind, name, ddl string
		if err := rows.Scan(&kind, &name, &ddl); err != nil {
			t.Fatal(err)
		}
		result[kind+":"+name] = canonicalSQLiteDDL(ddl)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func canonicalSQLiteDDL(ddl string) string {
	ddl = strings.Join(strings.Fields(strings.ReplaceAll(ddl, `"`, "")), " ")
	ddl = strings.ReplaceAll(ddl, "( ", "(")
	return strings.ReplaceAll(ddl, " )", ")")
}

func sqliteHistoryRows(t *testing.T, db *sql.DB) map[string][][]string {
	t.Helper()
	tables := []string{
		"metric_points", "history_events", "user_traffic_users", "user_traffic_buckets",
		"user_traffic_collector", "user_ip_history", "user_ip_history_collection", "sqlite_sequence",
	}
	result := make(map[string][][]string, len(tables))
	for _, table := range tables {
		rows, err := db.Query(`SELECT * FROM ` + table)
		if err != nil {
			t.Fatalf("read %s: %v", table, err)
		}
		columns, err := rows.Columns()
		if err != nil {
			rows.Close()
			t.Fatal(err)
		}
		for rows.Next() {
			values := make([]any, len(columns))
			destinations := make([]any, len(columns))
			for i := range values {
				destinations[i] = &values[i]
			}
			if err := rows.Scan(destinations...); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			encoded := make([]string, len(values))
			for i, value := range values {
				encoded[i] = fmt.Sprintf("%T:%v", value, value)
			}
			result[table] = append(result[table], encoded)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return result
}

func createSQLiteFixture(t *testing.T, path string, version int, statements ...string) {
	t.Helper()
	db, err := sqlitedriver.Open("file:" + path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			t.Fatalf("prepare SQLite fixture (%s): %v", statement, err)
		}
	}
	if _, err := db.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, version)); err != nil {
		db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
}

type rawSQLiteState struct {
	Version int
	Journal string
	Schema  map[string]string
}

func inspectRawSQLiteState(t *testing.T, path string) rawSQLiteState {
	t.Helper()
	db, err := sqlitedriver.Open("file:" + path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	state := rawSQLiteState{Schema: make(map[string]string)}
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&state.Version); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&state.Journal); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query(`SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind, name, ddl string
		if err := rows.Scan(&kind, &name, &ddl); err != nil {
			t.Fatal(err)
		}
		state.Schema[kind+":"+name] = canonicalSQLiteDDL(ddl)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return state
}

func assertUnsupportedSQLiteSchema(t *testing.T, err error, current int) {
	t.Helper()
	if err == nil {
		t.Fatalf("schema %d was accepted", current)
	}
	if IsRuntimeOpenError(err) {
		t.Fatalf("schema %d was masked as runtime open error: %T %v", current, err, err)
	}
	var unsupported interface{ UnsupportedSchemaVersions() (int, int) }
	if !errors.As(err, &unsupported) {
		t.Fatalf("schema %d error type = %T, want unsupported schema classification", current, err)
	}
	gotCurrent, supported := unsupported.UnsupportedSchemaVersions()
	if gotCurrent != current || supported != 11 {
		t.Fatalf("unsupported schema versions = (%d, %d), want (%d, 11)", gotCurrent, supported, current)
	}
}

func assertFileUnchanged(t *testing.T, path string, before []byte) {
	t.Helper()
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(after, before) {
		t.Fatal("unsupported SQLite schema was modified")
	}
}
