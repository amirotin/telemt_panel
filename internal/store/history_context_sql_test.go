//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteHistoryCallerCancellationWithBusyWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	s, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	other, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	tx, err := other.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = s.ApplyUserTrafficSnapshotContext(ctx, UserTrafficSnapshot{ObservedAt: 100, SourceStartedAt: 1, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "alice", RawOctets: 100}}})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("busy caller elapsed=%s err=%v", time.Since(start), err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	summaries, err := s.UserTrafficSummaries()
	if err != nil || len(summaries) != 0 {
		t.Fatalf("failed write advanced baseline=%+v %v", summaries, err)
	}
	if _, err := s.ApplyUserTrafficSnapshotContext(context.Background(), UserTrafficSnapshot{ObservedAt: 100, SourceStartedAt: 1, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "alice", RawOctets: 100}}}); err != nil {
		t.Fatalf("connection not released: %v", err)
	}
}

func TestSQLiteHistoryBusyTimeoutClassification(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	s, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	other, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	tx, err := other.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// Shorten only this test's busy wait to exercise SQLite's own timeout
	// separately from the caller deadline without a five-second test delay.
	if _, err := s.db.Exec("PRAGMA busy_timeout=20"); err != nil {
		t.Fatal(err)
	}
	err = s.AppendHistoryEventContext(context.Background(), HistoryEvent{Kind: "blocked"})
	if !errors.Is(err, ErrHistoryTimeout) {
		t.Fatalf("native busy timeout lost classification: %v", err)
	}
	tx.Rollback()
}

func TestSQLiteHistoryReadCancelsDuringLiveLock(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.liveMu.Lock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = s.MetricRangeContext(ctx, "connections", 0)
	s.liveMu.Unlock()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("live lock blocked cancellation=%v", err)
	}
}

func TestSQLiteHistoryTimeoutRollsBackAndReleasesConnection(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	err = s.withOperationTxContext(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO history_events(ts_ns,category,kind,entity,state,previous_state,severity,attributes_json) VALUES(1,'events','safe','','','','','null')`); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout result=%v", err)
	}
	events, err := s.ListHistoryEventsContext(context.Background(), HistoryEventFilter{})
	if err != nil || len(events) != 0 {
		t.Fatalf("timed out transaction survived=%+v %v", events, err)
	}
	if err := s.AppendHistoryEventContext(context.Background(), HistoryEvent{Kind: "after"}); err != nil {
		t.Fatal(err)
	}
}

func TestSQLiteHistoryReadTimeoutDoesNotReturnLivePartialSuccess(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.RecordMetric("connections", MetricPoint{TS: time.Now().Unix(), Value: 3}); err != nil {
		t.Fatal(err)
	}
	conn, err := s.db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	points, err := s.MetricRangeContext(ctx, "connections", 0)
	if !errors.Is(err, context.DeadlineExceeded) || points != nil {
		t.Fatalf("timed out read pretended complete=%+v err=%v", points, err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	read, err := s.BeginTrafficRead(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	deadline, ok := read.(*sqlTrafficReadSnapshot).ctx.Deadline()
	if !ok || time.Until(deadline) > 10*time.Second {
		t.Fatal("SQL traffic read not bounded")
	}
	read.Close()
}

func TestSQLiteHistoryCloseUsesFreshFlushScope(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	s, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	ts := time.Now().Unix()
	if err := s.RecordMetricsContext(ctx, []NamedMetricPoint{{Name: "connections", Point: MetricPoint{TS: ts, Value: 3}}}); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	points, err := s.MetricRangeContext(context.Background(), "connections", ts-3600)
	if err != nil || len(points) != 1 || points[0].Value != 3 {
		t.Fatalf("close lost pending metrics=%+v %v", points, err)
	}
}

func TestCompositeStateAvailableWhenHistoryContextFails(t *testing.T) {
	state, err := NewState("")
	if err != nil {
		t.Fatal(err)
	}
	history, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer history.Close()
	s, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PutSession(Session{IDHash: "safe", Created: time.Now(), LastSeen: time.Now(), AuthMethod: "password"}); err != nil {
		t.Fatal(err)
	}
	conn, err := history.db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := s.ListHistoryEventsContext(ctx, HistoryEventFilter{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("history failure=%v", err)
	}
	if session, ok, err := s.GetSession("safe"); err != nil || !ok || session.AuthMethod != "password" {
		t.Fatalf("history failure affected state: %+v %t %v", session, ok, err)
	}
	conn.Close()
}

func TestSQLiteHistoryConnectionPolicyAfterCancellation(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM user_traffic_users").Scan(&n); err != nil {
		t.Fatal(err)
	}
	cancel()
	deadline := time.Now().Add(time.Second)
	for s.db.Stats().InUse != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	_ = tx.Rollback()
	for _, tc := range []struct {
		pragma string
		want   int64
	}{
		{"busy_timeout", 5000}, {"synchronous", 2}, {"foreign_keys", 1}, {"cache_size", -20480}, {"journal_size_limit", 16777216},
	} {
		var got int64
		if err := s.db.QueryRow("PRAGMA " + tc.pragma).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != tc.want {
			t.Errorf("replaced connection %s=%d want %d", tc.pragma, got, tc.want)
		}
	}
	for _, snap := range []UserTrafficSnapshot{
		{ObservedAt: 100, SourceStartedAt: 1, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "cascade", RawOctets: 0}}},
		{ObservedAt: 101, SourceStartedAt: 1, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "cascade", RawOctets: 100}}},
	} {
		if _, err := s.ApplyUserTrafficSnapshot(snap); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.DeleteUserHistory("cascade"); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT count(*) FROM user_traffic_buckets").Scan(&n); err != nil || n != 0 {
		t.Errorf("cascade buckets=%d err=%v", n, err)
	}
}

func TestSQLiteHistoryReservedPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "space ? # Кириллица.db")
	s, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AppendHistoryEvent(HistoryEvent{TS: time.Now(), Kind: "safe"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	events, err := s.ListHistoryEvents(HistoryEventFilter{})
	if err != nil || len(events) != 1 {
		t.Fatalf("reserved path events=%+v err=%v", events, err)
	}
}

func TestSQLiteTrafficSnapshotCollectorAndSummariesStayConsistent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	s, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	peer, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	now := time.Now().Unix()
	baseline := UserTrafficSnapshot{ObservedAt: now - 60, SourceStartedAt: now - 1000, TelemetryEnabled: true, Users: []UserTrafficObservation{{Username: "alice", RawOctets: 100}}}
	if _, err := s.ApplyUserTrafficSnapshotContext(context.Background(), baseline); err != nil {
		t.Fatal(err)
	}
	read, err := s.BeginTrafficRead(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	advanced := baseline
	advanced.ObservedAt = now - 30
	advanced.Users = []UserTrafficObservation{{Username: "alice", RawOctets: 200}}
	if _, err := peer.ApplyUserTrafficSnapshotContext(context.Background(), advanced); err != nil {
		t.Fatal(err)
	}
	collector, err := read.CollectorState()
	if err != nil || collector.LastSuccessTS != baseline.ObservedAt {
		t.Fatalf("collector changed=%+v %v", collector, err)
	}
	summaries, err := read.Summaries()
	if err != nil || summaries["alice"].ObservedTotalBytes != 0 {
		t.Fatalf("summary crossed snapshot=%+v %v", summaries, err)
	}
	summaries["alice"] = UserTrafficSummary{ObservedTotalBytes: 999}
	again, err := read.Summaries()
	if err != nil || again["alice"].ObservedTotalBytes != 0 {
		t.Fatalf("caller mutated immutable summary cache=%+v %v", again, err)
	}
	total, _, _, err := read.Aggregate((now-900)/900*900, read.AsOf())
	if err != nil || total != 0 {
		t.Fatalf("buckets crossed snapshot=%d %v", total, err)
	}
	if err := read.Close(); err != nil {
		t.Fatal(err)
	}
	current, err := s.UserTrafficSummaries()
	if err != nil || current["alice"].ObservedTotalBytes != 100 {
		t.Fatalf("new snapshot did not see commit=%+v %v", current, err)
	}
}
