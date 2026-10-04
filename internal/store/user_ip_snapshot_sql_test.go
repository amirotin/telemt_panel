//go:build !lite

package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ncruces/go-sqlite3"
	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

func TestUserIPSnapshotConsistencySQLite(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runUserIPSnapshotConsistency(t, s)
}
func TestUserIPEpochMutationsSQLite(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runUserIPEpochMutations(t, s)
}
func TestUserIPSnapshotRetentionSQLite(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	const now int64 = 1800000000
	p := DefaultStoragePolicies()
	for i := range p {
		if p[i].Category == StorageUserIPHistory {
			p[i].RetentionDays = 7
		}
	}
	if err := s.ApplyStoragePolicies(p); err != nil {
		t.Fatal(err)
	}
	for _, r := range []UserIPRecord{snapshotRecord("old", "1.1.1.1", now-7*86400-1), snapshotRecord("boundary", "1.1.1.1", now-7*86400), snapshotRecord("future", "1.1.1.1", now+1)} {
		if _, err := s.db.Exec("INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES(?,?,?,?,?,?,?,?)", r.Username, r.IP, r.Family, r.First, r.Last, r.Observations, r.LastActive, r.Source); err != nil {
			t.Fatal(err)
		}
	}
	snap, err := s.ReadUserIPSnapshot(context.Background(), now-30*86400, now)
	if err != nil || snap.Retention != 7*24*time.Hour || !snap.Durable || len(snap.Records) != 1 || snap.Records[0].Username != "boundary" || !snap.Collection.Gap {
		t.Fatalf("snapshot=%+v %v", snap, err)
	}
}

type snapshotSQLObserver struct {
	enabled         atomic.Bool
	rows            atomic.Int64
	writeCommitted  atomic.Bool
	writeBeforeNext atomic.Bool
	firstRow        func()
	lastRow         func()
	writeStarted    func()
	mu              sync.Mutex
	pages           []int
	queries         []snapshotSQLQuery
}

type snapshotSQLQuery struct {
	sql         string
	args        []any
	rows, steps int
}

type snapshotSQLConnector struct {
	driver.Connector
	observer *snapshotSQLObserver
}

func (c snapshotSQLConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &snapshotSQLConn{Conn: conn, observer: c.observer}, nil
}

type snapshotSQLConn struct {
	driver.Conn
	observer *snapshotSQLObserver
	readRows int
}

func (c *snapshotSQLConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	tx, err := c.Conn.(driver.ConnBeginTx).BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	if !opts.ReadOnly && c.observer.enabled.Load() && c.observer.writeStarted != nil {
		c.observer.writeStarted()
	}
	if opts.ReadOnly {
		c.readRows = 0
	}
	return snapshotSQLTx{Tx: tx, conn: c, observer: c.observer, readOnly: opts.ReadOnly}, nil
}

func (c *snapshotSQLConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	stmt, err := c.Conn.(driver.ConnPrepareContext).PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return snapshotSQLStmt{Stmt: stmt, conn: c, observer: c.observer, query: query}, nil
}

func (c *snapshotSQLConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	result, err := c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
	if err == nil && c.observer.enabled.Load() && strings.HasPrefix(query, "INSERT INTO history_events") {
		c.observer.writeCommitted.Store(true)
	}
	return result, err
}

type snapshotSQLTx struct {
	driver.Tx
	conn     *snapshotSQLConn
	observer *snapshotSQLObserver
	readOnly bool
}

func (tx snapshotSQLTx) Commit() error {
	err := tx.Tx.Commit()
	if err == nil && tx.readOnly && tx.observer.enabled.Load() {
		tx.observer.mu.Lock()
		tx.observer.pages = append(tx.observer.pages, tx.conn.readRows)
		tx.observer.mu.Unlock()
	}
	if err == nil && !tx.readOnly && tx.observer.enabled.Load() {
		tx.observer.writeCommitted.Store(true)
	}
	return err
}

type snapshotSQLStmt struct {
	driver.Stmt
	conn     *snapshotSQLConn
	observer *snapshotSQLObserver
	query    string
}

func (s snapshotSQLStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	result, err := s.Stmt.(driver.StmtExecContext).ExecContext(ctx, args)
	if err == nil && s.observer.enabled.Load() && strings.HasPrefix(s.query, "INSERT INTO history_events") {
		s.observer.writeCommitted.Store(true)
	}
	return result, err
}

func (s snapshotSQLStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	rows, err := s.Stmt.(driver.StmtQueryContext).QueryContext(ctx, args)
	if err == nil && s.observer.enabled.Load() && strings.HasPrefix(s.query, "SELECT username,ip,") && strings.Contains(s.query, "FROM user_ip_history WHERE") {
		values := make([]any, len(args))
		for i, arg := range args {
			values[i] = arg.Value
		}
		rows = &snapshotSQLRows{Rows: rows, conn: s.conn, observer: s.observer, stmt: s.Stmt, query: snapshotSQLQuery{sql: s.query, args: values}}
	}
	return rows, err
}

type snapshotSQLRows struct {
	driver.Rows
	conn     *snapshotSQLConn
	stmt     driver.Stmt
	query    snapshotSQLQuery
	observer *snapshotSQLObserver
	rows     int
	once     sync.Once
}

func (rows *snapshotSQLRows) Next(values []driver.Value) error {
	err := rows.Rows.Next(values)
	if err != nil {
		return err
	}
	rows.rows++
	rows.conn.readRows++
	switch rows.observer.rows.Add(1) {
	case 1:
		if rows.observer.firstRow != nil {
			rows.observer.firstRow()
		}
	case 5001:
		rows.observer.writeBeforeNext.Store(rows.observer.writeCommitted.Load())
	case 12000:
		if rows.observer.lastRow != nil {
			rows.observer.lastRow()
		}
	}
	return nil
}

func (rows *snapshotSQLRows) Close() error {
	rows.once.Do(func() {
		rows.query.rows = rows.rows
		rows.query.steps = rows.stmt.(interface {
			Status(sqlite3.StmtStatus, bool) int
		}).Status(sqlite3.STMTSTATUS_VM_STEP, false)
		rows.observer.mu.Lock()
		defer rows.observer.mu.Unlock()
		rows.observer.queries = append(rows.observer.queries, rows.query)
	})
	return rows.Rows.Close()
}

func newObservedSnapshotSQLite(t *testing.T) (*SQLite, *snapshotSQLObserver) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "snapshot.db")
	connector, err := (&sqlitedriver.SQLite{}).OpenConnector("file:" + path + "?_txlock=immediate")
	if err != nil {
		t.Fatal(err)
	}
	observer := &snapshotSQLObserver{}
	db := sql.OpenDB(snapshotSQLConnector{Connector: connector, observer: observer})
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := newSQLStore(db, path)
	if err := s.initialize(); err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, observer
}

func seedSnapshotSQLite(t *testing.T, s *SQLite, records []UserIPRecord, now int64) {
	t.Helper()
	// Cap fixtures exceed a normal batch and have their own bounded setup budget.
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, "INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES(?,?,?,?,?,?,?,?)")
	if err != nil {
		t.Fatal(err)
	}
	defer stmt.Close()
	for i, r := range records {
		if _, err := stmt.ExecContext(ctx, r.Username, r.IP, r.Family, r.First, r.Last, r.Observations, r.LastActive, r.Source); err != nil {
			t.Fatalf("seed row %d/%d: error=%v context=%v", i+1, len(records), err, ctx.Err())
		}
	}
	if err := writeUserIPCollection(tx, UserIPCollection{BatchID: "fixture", Since: now - 3, Through: now}); err != nil {
		t.Fatalf("seed collection: error=%v context=%v", err, ctx.Err())
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit fixture: error=%v context=%v", err, ctx.Err())
	}
}

func snapshotSQLiteRecords(count int, now int64) []UserIPRecord {
	records := make([]UserIPRecord, count)
	for i := range records {
		records[i] = snapshotRecord(fmt.Sprintf("user%05d", i/4), fmt.Sprintf("2001:db8::%x", i%4+1), now-int64(i%3))
	}
	return records
}

func snapshotIsPartial(snapshot UserIPReadSnapshot) bool {
	return snapshot.Partial
}

func TestUserIPSnapshotSQLiteReads12000RowsInShortTransactions(t *testing.T) {
	s, observer := newObservedSnapshotSQLite(t)
	const now int64 = 1800000000
	want := snapshotSQLiteRecords(12000, now)
	seedSnapshotSQLite(t, s, want, now)
	sort.Slice(want, func(i, j int) bool { return recordBefore(want[i], want[j]) })
	observer.enabled.Store(true)
	snapshot, err := s.ReadUserIPSnapshot(context.Background(), 0, now)
	if err != nil || !reflect.DeepEqual(snapshot.Records, want) || snapshot.Collection.BatchID != "fixture" || snapshotIsPartial(snapshot) {
		t.Fatalf("snapshot records=%d partial=%v collection=%+v err=%v", len(snapshot.Records), snapshotIsPartial(snapshot), snapshot.Collection, err)
	}
	if !reflect.DeepEqual(observer.pages, []int{5000, 5000, 2000}) {
		t.Fatalf("read transaction row counts=%v, want [5000 5000 2000]", observer.pages)
	}
	if s.db.Stats().MaxOpenConnections != 1 {
		t.Fatal("snapshot increased the SQLite connection pool")
	}
}

func TestUserIPSnapshotSQLiteAllowsWritesBetweenChunks(t *testing.T) {
	for _, write := range []string{"event", "batch", "prune"} {
		t.Run(write, func(t *testing.T) {
			mutation := write != "event"
			s, observer := newObservedSnapshotSQLite(t)
			const now int64 = 1800000000
			records := snapshotSQLiteRecords(12000, now)
			if write == "prune" {
				records = append(records, snapshotRecord("expired", "1.1.1.1", now-int64(s.UserIPRetention()/time.Second)-1))
			}
			seedSnapshotSQLite(t, s, records, now)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			first, proceed := make(chan struct{}), make(chan struct{})
			observer.firstRow = func() {
				close(first)
				select {
				case <-proceed:
				case <-ctx.Done():
				}
			}
			observer.enabled.Store(true)
			type result struct {
				snapshot UserIPReadSnapshot
				err      error
			}
			done := make(chan result, 1)
			go func() { snapshot, err := s.ReadUserIPSnapshot(ctx, 0, now); done <- result{snapshot, err} }()
			select {
			case <-first:
			case <-ctx.Done():
				t.Fatal("snapshot did not start")
			}
			waitCount := s.db.Stats().WaitCount
			written := make(chan error, 1)
			go func() {
				switch write {
				case "batch":
					written <- s.ApplyUserIPBatch(UserIPBatch{ID: "interleaved", Through: now + 1})
				case "prune":
					written <- s.PruneUserIPHistory(now)
				default:
					written <- s.AppendHistoryEvent(HistoryEvent{TS: time.Unix(now, 0), Kind: "test.concurrent-write"})
				}
			}()
			ticker := time.NewTicker(time.Millisecond)
			for s.db.Stats().WaitCount == waitCount && ctx.Err() == nil {
				select {
				case <-ticker.C:
				case <-ctx.Done():
				}
			}
			ticker.Stop()
			close(proceed)
			got := <-done
			if err := <-written; err != nil {
				t.Fatal(err)
			}
			if got.err != nil {
				t.Fatal(got.err)
			}
			if !observer.writeBeforeNext.Load() {
				t.Fatal("competing write could not commit before the second 5000-row page")
			}
			if snapshotIsPartial(got.snapshot) != mutation {
				t.Fatalf("partial=%v for IP mutation=%v", snapshotIsPartial(got.snapshot), mutation)
			}
			if got.snapshot.Collection.Gap || got.snapshot.Collection.BatchID != "fixture" {
				t.Fatalf("first-page metadata was replaced or marked as a collector gap: %+v", got.snapshot.Collection)
			}
		})
	}
}

func TestUserIPSnapshotSQLiteMarksInProgressHistoryWritePartial(t *testing.T) {
	s, observer := newObservedSnapshotSQLite(t)
	const now int64 = 1800000000
	seedSnapshotSQLite(t, s, snapshotSQLiteRecords(12000, now), now)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	last, proceed, releaseWrite := make(chan struct{}), make(chan struct{}), make(chan struct{})
	observer.lastRow = func() {
		close(last)
		select {
		case <-proceed:
		case <-ctx.Done():
		}
	}
	observer.writeStarted = func() {
		select {
		case <-releaseWrite:
		case <-ctx.Done():
		}
	}
	observer.enabled.Store(true)
	type result struct {
		snapshot UserIPReadSnapshot
		err      error
	}
	done := make(chan result, 1)
	go func() { snapshot, err := s.ReadUserIPSnapshot(ctx, 0, now); done <- result{snapshot, err} }()
	select {
	case <-last:
	case <-ctx.Done():
		t.Fatal("snapshot did not reach its final page")
	}
	waitCount := s.db.Stats().WaitCount
	written := make(chan error, 1)
	go func() { written <- s.ApplyUserIPBatch(UserIPBatch{ID: "pending", Through: now + 1}) }()
	ticker := time.NewTicker(time.Millisecond)
	for s.db.Stats().WaitCount == waitCount && ctx.Err() == nil {
		select {
		case <-ticker.C:
		case <-ctx.Done():
		}
	}
	ticker.Stop()
	close(proceed)
	got := <-done
	committed := observer.writeCommitted.Load()
	close(releaseWrite)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if got.err != nil || !got.snapshot.Partial || committed || got.snapshot.Collection.Gap {
		t.Fatalf("pending write: partial=%v committed=%v gap=%v err=%v", got.snapshot.Partial, committed, got.snapshot.Collection.Gap, got.err)
	}
}

func TestUserIPSnapshotSQLiteHoldsEpochBarrierAcrossPages(t *testing.T) {
	s, observer := newObservedSnapshotSQLite(t)
	const now int64 = 1800000000
	seedSnapshotSQLite(t, s, snapshotSQLiteRecords(12000, now), now)
	epoch := s.UserIPEpoch()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, proceed := make(chan struct{}), make(chan struct{})
	observer.firstRow = func() {
		close(first)
		select {
		case <-proceed:
		case <-ctx.Done():
		}
	}
	observer.enabled.Store(true)
	type result struct {
		snapshot UserIPReadSnapshot
		err      error
	}
	done := make(chan result, 1)
	go func() { snapshot, err := s.ReadUserIPSnapshot(ctx, 0, now); done <- result{snapshot, err} }()
	select {
	case <-first:
	case <-ctx.Done():
		t.Fatal("snapshot did not start")
	}
	reset := make(chan error, 1)
	go func() { reset <- s.ResetUserIPHistory("") }()
	select {
	case err := <-reset:
		close(proceed)
		t.Fatalf("reset escaped the active snapshot barrier: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(proceed)
	got := <-done
	if err := <-reset; err != nil {
		t.Fatal(err)
	}
	if got.err != nil || len(got.snapshot.Records) != 12000 || got.snapshot.Epoch != epoch || got.snapshot.Partial {
		t.Fatalf("reset split paged history: rows=%d epoch=%d partial=%v err=%v", len(got.snapshot.Records), got.snapshot.Epoch, got.snapshot.Partial, got.err)
	}
	if s.UserIPEpoch() == epoch {
		t.Fatal("reset did not advance the epoch after the snapshot completed")
	}
}

func TestUserIPSnapshotSQLiteCapKeepsNewestAndStableTies(t *testing.T) {
	s, _ := newObservedSnapshotSQLite(t)
	const now int64 = 1800000000
	records := make([]UserIPRecord, UserIPSQLiteLimit+2)
	for i := range records {
		at := now - 1
		if i == 0 {
			at = now - 2
		} else if i == UserIPSQLiteLimit+1 {
			at = now
		}
		records[i] = snapshotRecord(fmt.Sprintf("user%06d", i), "1.1.1.1", at)
	}
	seedSnapshotSQLite(t, s, records, now)
	snapshot, err := s.ReadUserIPSnapshot(context.Background(), 0, now)
	if err != nil || !snapshot.Truncated || len(snapshot.Records) != UserIPSQLiteLimit {
		t.Fatalf("records=%d truncated=%v err=%v", len(snapshot.Records), snapshot.Truncated, err)
	}
	if snapshot.Records[0].Username != "user000001" || snapshot.Records[len(snapshot.Records)-1].Username != "user100001" {
		t.Fatalf("selected %s..%s omitted latest records", snapshot.Records[0].Username, snapshot.Records[len(snapshot.Records)-1].Username)
	}
	for _, record := range snapshot.Records {
		if record.Username == "user100000" {
			t.Fatal("timestamp tie did not keep the first username/IP keys")
		}
	}
}

func TestUserIPSnapshotSQLiteCancelsReadAndReleasesEpochBarrier(t *testing.T) {
	s, observer := newObservedSnapshotSQLite(t)
	const now int64 = 1800000000
	seedSnapshotSQLite(t, s, snapshotSQLiteRecords(12000, now), now)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observer.firstRow = cancel
	observer.enabled.Store(true)
	if _, err := s.ReadUserIPSnapshot(ctx, 0, now); !errors.Is(err, context.Canceled) {
		t.Fatalf("snapshot cancellation=%v", err)
	}
	before := s.UserIPEpoch()
	if err := s.ResetUserIPHistory(""); err != nil || s.UserIPEpoch() == before {
		t.Fatalf("cancelled read retained epoch barrier: epoch=%d err=%v", s.UserIPEpoch(), err)
	}
}

func TestUserIPSnapshotSQLiteIndexAvoidsTimestampTieSort(t *testing.T) {
	s, _ := newObservedSnapshotSQLite(t)
	for _, test := range []struct {
		name  string
		where string
		args  []any
	}{
		{"first page", "last_ts>=? AND last_ts<=?", []any{1, 1800000000, 5000}},
		{"timestamp tail", "last_ts=? AND (username,ip)>(?,?)", []any{1799999999, "user", "1.1.1.1", 5000}},
		{"older timestamps", "last_ts>=? AND last_ts<?", []any{1, 1799999999, 5000}},
	} {
		t.Run(test.name, func(t *testing.T) {
			rows, err := s.db.Query("EXPLAIN QUERY PLAN SELECT username,ip,family,first_ts,last_ts,observations,last_active_ts,source FROM user_ip_history WHERE "+test.where+" ORDER BY last_ts DESC,username ASC,ip ASC LIMIT ?", test.args...)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			for rows.Next() {
				var id, parent, unused int
				var detail string
				if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
					t.Fatal(err)
				}
				t.Log(detail)
				if strings.Contains(detail, "TEMP B-TREE") {
					t.Errorf("5000-row page still sorts a timestamp group: %s", detail)
				}
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestUserIPSnapshotSQLiteTimestampTiesSeekPastReadKeys(t *testing.T) {
	s, observer := newObservedSnapshotSQLite(t)
	const now int64 = 1800000000
	records := make([]UserIPRecord, 20000)
	for i := range records {
		records[i] = snapshotRecord(fmt.Sprintf("user%05d", i), "1.1.1.1", now)
	}
	seedSnapshotSQLite(t, s, records, now)
	observer.enabled.Store(true)
	snapshot, err := s.ReadUserIPSnapshot(t.Context(), 0, now)
	if err != nil || !reflect.DeepEqual(snapshot.Records, records) {
		t.Fatalf("timestamp tie snapshot: rows=%d err=%v", len(snapshot.Records), err)
	}
	for i, query := range observer.queries {
		t.Logf("query %d: rows=%d SQLite VM steps=%d", i+1, query.rows, query.steps)
		// A page may scan its returned records, but must seek past previous keys.
		if query.steps > query.rows*40+2000 {
			t.Errorf("query %d revisited prior timestamp keys: rows=%d VM steps=%d", i+1, query.rows, query.steps)
		}
	}
	seek := false
	for _, query := range observer.queries {
		rows, err := s.db.QueryContext(t.Context(), "EXPLAIN QUERY PLAN "+query.sql, query.args...)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			t.Log(detail)
			seek = seek || strings.Contains(detail, "(username,ip)>")
			if strings.Contains(detail, "TEMP B-TREE") {
				t.Error("snapshot query sorts timestamp ties")
			}
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			t.Fatal(err)
		}
	}
	if !seek {
		t.Error("timestamp continuation query does not seek the composite username/IP key")
	}
}
