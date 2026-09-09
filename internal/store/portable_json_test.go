//go:build !lite

package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

func TestPortableJSONSQLMatchesMaterializedMixedRoundTrip(t *testing.T) {
	combined, _, _ := newMixedPortableComposite(t)
	want, err := combined.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	assertMixedPortableCoverage(t, want)
	var raw bytes.Buffer
	if err := combined.ExportJSON(&raw); err != nil {
		t.Fatalf("ExportJSON: %v", err)
	}
	if !bytes.HasSuffix(raw.Bytes(), []byte("\n")) {
		t.Fatal("streaming export lacks trailing newline")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw.Bytes()))
	decoder.DisallowUnknownFields()
	var got PortableData
	if err := decoder.Decode(&got); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		t.Fatalf("trailing JSON decode = %v, want EOF", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("streaming export differs from materialized export\n got: %#v\nwant: %#v", got, want)
	}

	destinationState, _ := NewState("")
	destinationHistory, _ := newSQLite(t)
	destination, err := NewComposite(destinationState, destinationHistory)
	if err != nil {
		t.Fatal(err)
	}
	if err := destination.ImportData(got); err != nil {
		t.Fatalf("ImportData(streaming export): %v", err)
	}
	roundTrip, err := destination.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roundTrip, want) {
		t.Fatalf("streaming round trip differs\n got: %#v\nwant: %#v", roundTrip, want)
	}
}

func TestPortableJSONWriterFailuresReleaseSQLiteTransaction(t *testing.T) {
	combined, _, history := newMixedPortableComposite(t)
	extendPortableHistoryForWriterFailure(t, history)
	var complete bytes.Buffer
	if err := combined.ExportJSON(&complete); err != nil {
		t.Fatal(err)
	}
	metricsAt := bytes.Index(complete.Bytes(), []byte(`"metrics":`))
	eventsAt := bytes.Index(complete.Bytes(), []byte(`"events":`))
	if metricsAt < 0 || eventsAt-metricsAt <= portableJSONBufferSize || complete.Len()-eventsAt <= portableJSONBufferSize {
		t.Fatalf("fixture does not span writer buffer boundaries: bytes=%d metrics=%d events=%d", complete.Len(), metricsAt, eventsAt)
	}
	for _, limit := range []int{0, metricsAt + portableJSONBufferSize + 17, eventsAt + portableJSONBufferSize + 17, complete.Len() - 1} {
		writer := &limitedErrorWriter{remaining: limit}
		if err := combined.ExportJSON(writer); err == nil {
			t.Fatalf("ExportJSON with writer limit %d succeeded", limit)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		var one int
		err := history.db.QueryRowContext(ctx, "SELECT 1").Scan(&one)
		cancel()
		if err != nil || one != 1 {
			t.Fatalf("database unavailable after writer limit %d: one=%d err=%v", limit, one, err)
		}
	}
}

func TestPortableJSONRejectsMalformedSQLiteRows(t *testing.T) {
	tests := []struct {
		name string
		seed func(*testing.T, *SQLite)
	}{
		{"metric metadata", func(t *testing.T, s *SQLite) {
			_, err := s.db.Exec(`INSERT INTO metric_points(name,category,tier,ts,value,max,samples,last_ts,min_value,first_ts,first_value,observed_seconds,gaps)
				VALUES ('connections','technical','5m',100,10,5,1,100,10,100,10,0,0)`)
			if err != nil {
				t.Fatal(err)
			}
		}},
		{"orphan traffic bucket", func(t *testing.T, s *SQLite) {
			if _, err := s.db.Exec("PRAGMA foreign_keys=OFF"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.db.Exec("INSERT INTO user_traffic_buckets(user_id,tier,ts,bytes) VALUES(999,0,100,1)"); err != nil {
				t.Fatal(err)
			}
		}},
		{"IP collection bounds", func(t *testing.T, s *SQLite) {
			now := time.Now().Unix()
			if _, err := s.db.Exec("INSERT INTO user_ip_history_collection(singleton,batch_id,since_ts,through_ts,limited,gap) VALUES(1,'batch',?, ?,0,0)", now-100, now); err != nil {
				t.Fatal(err)
			}
			if _, err := s.db.Exec("INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES('alice','192.0.2.1',4,?,?,?,?,1)", now-200, now-10, 1, now-10); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _ := newSQLite(t)
			tt.seed(t, s)
			if err := s.ExportJSON(io.Discard); err == nil {
				t.Fatal("ExportJSON accepted malformed persisted history")
			}
		})
	}
}

func TestPortableJSONUsesOneSQLiteSnapshot(t *testing.T) {
	state, _ := NewState("")
	history, path := newSQLite(t)
	data := PortableData{FormatVersion: portableFormatVersion, Metrics: map[string][]MetricPoint{"connections": make([]MetricPoint, 1200)}, Events: []HistoryEvent{{TS: time.Unix(100, 0).UTC(), Category: StorageEvents, Kind: "old"}}}
	for i := range data.Metrics["connections"] {
		data.Metrics["connections"][i] = MetricPoint{TS: int64(i + 1), Value: float64(i)}
	}
	if err := history.ImportData(data); err != nil {
		t.Fatal(err)
	}
	combined, _ := NewComposite(state, history)
	paused := make(chan struct{})
	resume := make(chan struct{})
	writer := &pauseFirstWrite{paused: paused, resume: resume}
	errCh := make(chan error, 1)
	go func() { errCh <- combined.ExportJSON(writer) }()
	defer func() {
		select {
		case <-resume:
		default:
			close(resume)
		}
	}()
	select {
	case <-paused:
	case <-time.After(3 * time.Second):
		t.Fatal("export did not reach paused SQLite metric stream")
	}

	u := &url.URL{Scheme: "file", Path: path}
	other, err := sqlitedriver.Open(u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := other.Exec("PRAGMA foreign_keys=ON"); err != nil {
		t.Fatal(err)
	}
	tx, err := other.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO history_events(ts_ns,category,kind,entity,state,previous_state,severity,attributes_json)
		VALUES(200000000000,'events','new','','','','','{}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO user_traffic_users(username,total_bytes,since_ts,updated_ts,month_key,month_bytes,continuity)
		VALUES('new-user',1,1,1,197001,1,'normal')`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	close(resume)
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("paused export did not release its transaction")
	}
	var snapshot PortableData
	if err := json.Unmarshal(writer.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Events) != 1 || snapshot.Events[0].Kind != "old" || len(snapshot.UserTraffic) != 0 {
		t.Fatalf("export mixed SQLite snapshots: events=%+v traffic=%+v", snapshot.Events, snapshot.UserTraffic)
	}
	var later bytes.Buffer
	if err := combined.ExportJSON(&later); err != nil {
		t.Fatal(err)
	}
	var next PortableData
	if err := json.Unmarshal(later.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if len(next.Events) != 2 || len(next.UserTraffic) != 1 {
		t.Fatalf("later export missed committed rows: events=%d traffic=%d", len(next.Events), len(next.UserTraffic))
	}
}

func TestCompositeImportEmptinessProbeDoesNotDecodeHistory(t *testing.T) {
	state, _ := NewState("")
	history, _ := newSQLite(t)
	if _, err := history.db.Exec(`INSERT INTO history_events(ts_ns,category,kind,entity,state,previous_state,severity,attributes_json)
		VALUES(1,'events','broken','','','','','{')`); err != nil {
		t.Fatal(err)
	}
	combined, _ := NewComposite(state, history)
	err := combined.ImportData(PortableData{FormatVersion: portableFormatVersion})
	if !errors.Is(err, ErrStoreNotEmpty) {
		t.Fatalf("ImportData error = %v, want ErrStoreNotEmpty", err)
	}
}

func TestCompositeImportEmptinessProbeFlushesPendingMetrics(t *testing.T) {
	state, _ := NewState("")
	history, _ := newSQLite(t)
	if err := history.RecordMetric("connections", MetricPoint{TS: time.Now().Unix(), Value: 1}); err != nil {
		t.Fatal(err)
	}
	combined, _ := NewComposite(state, history)
	err := combined.ImportData(PortableData{FormatVersion: portableFormatVersion})
	if !errors.Is(err, ErrStoreNotEmpty) {
		t.Fatalf("ImportData error = %v, want ErrStoreNotEmpty", err)
	}
}

func TestCompositeImportEmptinessProbeChecksEverySQLiteTable(t *testing.T) {
	tests := []struct {
		name string
		seed func(*testing.T, *SQLite)
	}{
		{"metric_points", func(t *testing.T, s *SQLite) {
			execPortableSeed(t, s, "INSERT INTO metric_points(name,category,tier,ts,value,max,samples,last_ts) VALUES('connections','technical','raw',1,1,1,1,1)")
		}},
		{"user_ip_history", func(t *testing.T, s *SQLite) {
			execPortableSeed(t, s, "INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES('alice','192.0.2.1',4,1,1,1,1,1)")
		}},
		{"user_ip_history_collection", func(t *testing.T, s *SQLite) {
			execPortableSeed(t, s, "INSERT INTO user_ip_history_collection(singleton,batch_id,since_ts,through_ts,limited,gap) VALUES(1,'batch',1,1,0,0)")
		}},
		{"history_events", func(t *testing.T, s *SQLite) {
			execPortableSeed(t, s, "INSERT INTO history_events(ts_ns,category,kind,entity,state,previous_state,severity,attributes_json) VALUES(1,'events','kind','','','','','{}')")
		}},
		{"user_traffic_users", func(t *testing.T, s *SQLite) {
			execPortableSeed(t, s, "INSERT INTO user_traffic_users(username,total_bytes,since_ts,updated_ts,month_key,month_bytes,continuity) VALUES('alice',1,1,1,197001,1,'normal')")
		}},
		{"user_traffic_buckets", func(t *testing.T, s *SQLite) {
			execPortableSeed(t, s, "PRAGMA foreign_keys=OFF")
			execPortableSeed(t, s, "INSERT INTO user_traffic_buckets(user_id,tier,ts,bytes) VALUES(999,0,1,1)")
		}},
		{"user_traffic_collector", func(t *testing.T, s *SQLite) {
			execPortableSeed(t, s, "INSERT INTO user_traffic_collector(singleton,last_success_ts,source_started_at,source_state,continuity) VALUES(1,1,1,'collecting','normal')")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			state, _ := NewState("")
			history, _ := newSQLite(t)
			tt.seed(t, history)
			combined, _ := NewComposite(state, history)
			err := combined.ImportData(PortableData{FormatVersion: portableFormatVersion})
			if !errors.Is(err, ErrStoreNotEmpty) {
				t.Fatalf("ImportData error = %v, want ErrStoreNotEmpty", err)
			}
		})
	}
}

func TestCompositeImportAllowsDefaultPoliciesOnlyState(t *testing.T) {
	state, _ := NewState("")
	history, _ := newSQLite(t)
	combined, _ := NewComposite(state, history)
	if err := combined.ImportData(PortableData{FormatVersion: portableFormatVersion, Settings: map[string]string{"restored": "yes"}}); err != nil {
		t.Fatalf("ImportData rejected default-policies-only state: %v", err)
	}
}

func TestCompositeSQLiteRollsBackEveryHistoryFamilyWhenStateImportFails(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "panel-state.json")
	state, err := NewState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	history, _ := newSQLite(t)
	combined, _ := NewComposite(state, history)
	now := time.Now().UTC().Truncate(time.Second)
	data := PortableData{
		FormatVersion:        portableFormatVersion,
		Settings:             map[string]string{"theme": "dark"},
		Metrics:              map[string][]MetricPoint{"connections": {{TS: now.Unix(), Value: 1}}},
		Events:               []HistoryEvent{{TS: now, Category: StorageEvents, Kind: "event"}},
		UserTraffic:          []PortableUserTrafficUser{{Summary: UserTrafficSummary{Username: "alice", ObservedTotalBytes: 1, ObservedSinceEpochSecs: 1, LastActivityEpochSecs: 1, MonthKey: 197001, CurrentMonthBytes: 1, Continuity: UserTrafficNormal}}},
		UserTrafficBuckets:   []PortableUserTrafficBucket{{Username: "alice", Tier: MetricTierQuarter, TS: 1, Bytes: 1}},
		UserTrafficCollector: &UserTrafficCollectorState{LastSuccessTS: 1, SourceStartedAt: 1, SourceState: UserTrafficCollecting, Continuity: UserTrafficNormal},
		UserIPs:              []UserIPRecord{{Username: "alice", IP: "192.0.2.1", Family: 4, First: now.Unix() - 10, Last: now.Unix(), Observations: 1, LastActive: now.Unix(), Source: 1}},
		UserIPCollection:     &UserIPCollection{BatchID: "batch", Since: now.Unix() - 10, Through: now.Unix()},
	}
	if err := combined.ImportData(data); err == nil {
		t.Fatal("ImportData hid state persistence failure")
	}
	empty, err := history.portableHistoryEmpty()
	if err != nil || !empty {
		t.Fatalf("SQLite history survived compensated state failure: empty=%v err=%v", empty, err)
	}
}

func execPortableSeed(t *testing.T, s *SQLite, query string) {
	t.Helper()
	if _, err := s.db.Exec(query); err != nil {
		t.Fatal(err)
	}
}

func newMixedPortableComposite(t *testing.T) (*Composite, *Memory, *SQLite) {
	t.Helper()
	state, err := NewState("")
	if err != nil {
		t.Fatal(err)
	}
	populatePortableStore(t, state)
	history, _ := newSQLite(t)
	now := time.Now().UTC().Truncate(time.Second)
	minimum, delta := 10.0, 20.0
	raw, source := int64(900), now.Add(-time.Hour).Unix()
	historyData := PortableData{
		FormatVersion: portableFormatVersion,
		Metrics: map[string][]MetricPoint{
			"connections": {
				{TS: now.Unix(), Value: 7},
				{Tier: MetricTierMinute, TS: now.Add(-30 * time.Minute).Unix(), Value: 20, Max: 30, Samples: 2, Min: &minimum, FirstTS: now.Add(-30*time.Minute).Unix() + 5, LastTS: now.Add(-30*time.Minute).Unix() + 10, FirstValue: 10, ObservedSeconds: 5},
				{Tier: MetricTierFive, TS: now.Add(-time.Hour).Unix(), Value: 20, Max: 30, Samples: 2, Min: &minimum, FirstTS: now.Add(-time.Hour).Unix() + 5, LastTS: now.Add(-time.Hour).Unix() + 10, FirstValue: 10, ObservedSeconds: 5},
				{Tier: MetricTierHour, TS: now.Add(-2 * time.Hour).Unix(), Value: 8, Max: 9, Samples: 2, LastTS: now.Add(-2 * time.Hour).Unix()},
			},
			"traffic": {{Tier: MetricTierQuarter, TS: now.Add(-3 * time.Hour).Unix(), Value: 30, Max: 30, Samples: 2, Min: &minimum, FirstTS: now.Add(-3*time.Hour).Unix() + 2, LastTS: now.Add(-3*time.Hour).Unix() + 4, FirstValue: 10, Delta: &delta, ObservedSeconds: 2}},
		},
		Events: []HistoryEvent{{TS: now, Category: StorageEvents, Kind: "route.changed", Attributes: map[string]string{"route": "me"}}},
		UserTraffic: []PortableUserTrafficUser{
			{Summary: UserTrafficSummary{Username: "alice", ObservedTotalBytes: 1000, ObservedSinceEpochSecs: source, LastActivityEpochSecs: now.Unix(), MonthKey: 202609, CurrentMonthBytes: 500, Continuity: UserTrafficPartial}, LastRawOctets: &raw, LastSourceStartedAt: &source},
			{Summary: UserTrafficSummary{Username: "deleted", ObservedTotalBytes: 20, ObservedSinceEpochSecs: source, LastActivityEpochSecs: now.Add(-time.Hour).Unix(), MonthKey: 202609, DeletedEpochSecs: now.Add(-time.Minute).Unix(), Continuity: UserTrafficNormal}},
		},
		UserTrafficBuckets:   []PortableUserTrafficBucket{{Username: "alice", Tier: MetricTierQuarter, TS: now.Add(-time.Hour).Unix(), Bytes: 1}, {Username: "alice", Tier: MetricTierHour, TS: now.Add(-2 * time.Hour).Unix(), Bytes: 2}, {Username: "alice", Tier: MetricTierDay, TS: now.Add(-24 * time.Hour).Unix(), Bytes: 3}},
		UserTrafficCollector: &UserTrafficCollectorState{LastSuccessTS: now.Unix(), SourceStartedAt: source, SourceState: UserTrafficCollecting, Continuity: UserTrafficPartial},
		UserIPs: []UserIPRecord{
			{Username: "alice", IP: "192.0.2.1", Family: 4, First: now.Add(-time.Hour).Unix(), Last: now.Unix(), Observations: 2, LastActive: now.Unix(), Source: 1},
			{Username: "expired", IP: "2001:db8::1", Family: 6, First: now.Add(-40 * 24 * time.Hour).Unix(), Last: now.Add(-31 * 24 * time.Hour).Unix(), Observations: 1, Source: 2},
		},
		UserIPCollection: &UserIPCollection{BatchID: "mixed", Since: now.Add(-40 * 24 * time.Hour).Unix(), Through: now.Unix(), Limited: true, Gap: true},
	}
	if err := history.ImportData(historyData); err != nil {
		t.Fatal(err)
	}
	if _, err := history.db.Exec(`INSERT INTO history_events(ts_ns,category,kind,entity,state,previous_state,severity,attributes_json)
		VALUES(?, '', 'legacy.empty.category', '', '', '', '', '{}')`, now.Add(time.Second).UnixNano()); err != nil {
		t.Fatal(err)
	}
	combined, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	return combined, state, history
}

func assertMixedPortableCoverage(t *testing.T, data PortableData) {
	t.Helper()
	minute := false
	for _, point := range data.Metrics["connections"] {
		minute = minute || point.Tier == MetricTierMinute
	}
	if !minute {
		t.Fatal("mixed fixture lacks minute metric")
	}
	if len(data.UserTraffic) != 2 || data.UserTraffic[1].Summary.Username != "deleted" || data.UserTraffic[1].LastRawOctets != nil || data.UserTraffic[1].Summary.DeletedEpochSecs == 0 {
		t.Fatalf("mixed fixture lacks null-baseline tombstone: %+v", data.UserTraffic)
	}
	if len(data.UserIPs) != 1 || data.UserIPs[0].Username != "alice" {
		t.Fatalf("IP cutoff did not retain only current record: %+v", data.UserIPs)
	}
	if len(data.Events) != 2 || data.Events[1].Category != StorageEvents {
		t.Fatalf("empty event category was not normalized: %+v", data.Events)
	}
}

func extendPortableHistoryForWriterFailure(t *testing.T, history *SQLite) {
	t.Helper()
	tx, err := history.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	metric, err := tx.Prepare(`INSERT INTO metric_points(name,category,tier,ts,value,max,samples,last_ts)
		VALUES('writer.failure','technical','raw',?,?,?,1,?)`)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().Unix() + 100
	for i := 0; i < 2500; i++ {
		ts := base + int64(i)
		if _, err := metric.Exec(ts, i%100, i%100, ts); err != nil {
			t.Fatal(err)
		}
	}
	if err := metric.Close(); err != nil {
		t.Fatal(err)
	}
	event, err := tx.Prepare(`INSERT INTO history_events(ts_ns,category,kind,entity,state,previous_state,severity,attributes_json)
		VALUES(?,'events','writer.failure','','','','','{"detail":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}')`)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 800; i++ {
		if _, err := event.Exec(int64(i + 1)); err != nil {
			t.Fatal(err)
		}
	}
	if err := event.Close(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

type limitedErrorWriter struct {
	remaining int
}

func (w *limitedErrorWriter) Write(p []byte) (int, error) {
	if w.remaining <= 0 {
		return 0, errors.New("injected writer failure")
	}
	if len(p) > w.remaining {
		n := w.remaining
		w.remaining = 0
		return n, errors.New("injected writer failure")
	}
	w.remaining -= len(p)
	return len(p), nil
}

type pauseFirstWrite struct {
	bytes.Buffer
	paused chan struct{}
	resume chan struct{}
	did    bool
}

func (w *pauseFirstWrite) Write(p []byte) (int, error) {
	if !w.did {
		w.did = true
		close(w.paused)
		<-w.resume
	}
	return w.Buffer.Write(p)
}
