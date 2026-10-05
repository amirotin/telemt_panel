//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
	"github.com/ncruces/go-sqlite3"
	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

func journalTransitionFixture(t *testing.T) (*SQLite, *sql.DB, <-chan struct{}, chan struct{}) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "panel.db")
	uri := "file:" + path + "?_txlock=immediate&_pragma=busy_timeout(5000)"
	holder, err := sqlitedriver.Open(uri)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = holder.Close() })
	if _, err := sqlstore.Migrate(context.Background(), holder); err != nil {
		t.Fatal(err)
	}
	var mode string
	if err := holder.QueryRow("PRAGMA journal_mode=DELETE").Scan(&mode); err != nil || mode != "delete" {
		t.Fatalf("DELETE mode=%s err=%v", mode, err)
	}
	walAttempted := make(chan struct{})
	readerReady := make(chan struct{})
	var once sync.Once
	db, err := sqlitedriver.Open(uri, func(conn *sqlite3.Conn) error {
		return conn.SetAuthorizer(func(action sqlite3.AuthorizerActionCode, name, value, _, _ string) sqlite3.AuthorizerReturnCode {
			if action == sqlite3.AUTH_PRAGMA && name == "journal_mode" && strings.EqualFold(value, "wal") {
				once.Do(func() {
					close(walAttempted)
					<-readerReady
				})
			}
			return sqlite3.AUTH_OK
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return newSQLStore(db, path), holder, walAttempted, readerReady
}

func TestSQLiteInitializationWaitsForJournalReader(t *testing.T) {
	s, holder, attempted, readerReady := journalTransitionFixture(t)
	done := make(chan error, 1)
	go func() { done <- s.initialize() }()
	select {
	case <-attempted:
	case <-time.After(time.Second):
		close(readerReady)
		<-done
		t.Fatal("initializer did not reach journal_mode WAL")
	}
	reader, err := holder.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		close(readerReady)
		<-done
		t.Fatal(err)
	}
	defer reader.Rollback()
	var count int
	if err := reader.QueryRow("SELECT count(*) FROM user_traffic_users").Scan(&count); err != nil {
		reader.Rollback()
		close(readerReady)
		<-done
		t.Fatal(err)
	}
	close(readerReady)
	select {
	case err := <-done:
		reader.Rollback()
		t.Fatalf("initializer rejected temporary journal reader: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := reader.Rollback(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("initializer did not finish after journal reader released")
	}
	for pragma, want := range map[string]string{"journal_mode": "wal", "synchronous": "2", "foreign_keys": "1", "quick_check": "ok"} {
		var got string
		if err := s.db.QueryRow("PRAGMA " + pragma).Scan(&got); err != nil || got != want {
			t.Fatalf("%s=%s err=%v, want %s", pragma, got, err, want)
		}
	}
}

func TestSQLiteInitializationJournalWaitHonorsDeadline(t *testing.T) {
	s, holder, attempted, readerReady := journalTransitionFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- s.initializeContext(ctx) }()
	select {
	case <-attempted:
	case <-time.After(time.Second):
		close(readerReady)
		<-done
		t.Fatal("initializer did not reach WAL before deadline")
	}
	reader, err := holder.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		close(readerReady)
		<-done
		t.Fatal(err)
	}
	defer reader.Rollback()
	var count int
	if err := reader.QueryRow("SELECT count(*) FROM user_traffic_users").Scan(&count); err != nil {
		reader.Rollback()
		close(readerReady)
		<-done
		t.Fatal(err)
	}
	close(readerReady)
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
			t.Fatalf("initializer deadline elapsed=%s err=%v", time.Since(start), err)
		}
	case <-time.After(time.Second):
		reader.Rollback()
		<-done
		t.Fatal("initializer ignored shorter caller deadline")
	}
	if err := reader.Rollback(); err != nil {
		t.Fatal(err)
	}
	probeCtx, probeCancel := context.WithTimeout(context.Background(), time.Second)
	defer probeCancel()
	probe, err := s.db.Conn(probeCtx)
	if err != nil {
		t.Fatalf("initializer cancellation leaked sole connection: %v", err)
	}
	probe.Close()
	if err := s.initialize(); err != nil {
		t.Fatalf("initializer could not recover after canceled WAL wait: %v", err)
	}
}

func TestSQLiteWALRetriesOnlyContention(t *testing.T) {
	for _, code := range []sqlite3.ErrorCode{sqlite3.BUSY, sqlite3.LOCKED, sqlite3.INTERRUPT, sqlite3.CORRUPT, sqlite3.AUTH} {
		t.Run(code.Error(), func(t *testing.T) {
			attempts := 0
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := retrySQLiteWAL(ctx, func(context.Context) error {
				attempts++
				if attempts == 1 {
					return code
				}
				return nil
			})
			if code == sqlite3.BUSY || code == sqlite3.LOCKED {
				if err != nil || attempts != 2 {
					t.Fatalf("retryable %v attempts=%d err=%v", code, attempts, err)
				}
			} else if !errors.Is(err, code) || attempts != 1 {
				t.Fatalf("non-contention %v replayed: attempts=%d err=%v", code, attempts, err)
			}
		})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := retrySQLiteWAL(ctx, func(context.Context) error { return sqlite3.BUSY }); !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("contention retries unbounded elapsed=%s err=%v", time.Since(start), err)
	}
}
