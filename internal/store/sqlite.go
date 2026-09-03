//go:build !lite

package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

// SQLite is the shared SQL implementation for SQLite, PostgreSQL and MySQL.
// It contains observability history only; control-plane state lives in the
// local panel-state.json store.
type SQLite struct {
	db      *sql.DB
	path    string
	driver  string
	remote  bool
	schema  int
	dialect sqlstore.Dialect

	policyMu sync.RWMutex
	policies map[StorageCategory]StoragePolicy

	maintenanceStop chan struct{}
	maintenanceDone chan struct{}
	closeOnce       sync.Once
	closeErr        error
}

const sqlOperationTimeout = 5 * time.Second

type queryRows struct {
	*sql.Rows
	cancel context.CancelFunc
}

func (rows *queryRows) Close() error {
	rows.cancel()
	return rows.Rows.Close()
}

type queryRow struct {
	row    *sql.Row
	cancel context.CancelFunc
}

func (row queryRow) Scan(dest ...any) error {
	defer row.cancel()
	return row.row.Scan(dest...)
}

// NewSQLite opens or creates a durable observability-history store at path.
func NewSQLite(path string) (*SQLite, error) {
	if path == "" {
		return nil, errors.New("sqlite store path is empty")
	}
	dir := filepath.Dir(path)
	_, statErr := os.Stat(dir)
	dirMissing := errors.Is(statErr, os.ErrNotExist)
	if statErr != nil && !dirMissing {
		return nil, fmt.Errorf("inspect sqlite store directory: %w", statErr)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create sqlite store directory: %w", err)
	}
	if dirMissing {
		if err := os.Chmod(dir, 0o700); err != nil {
			return nil, fmt.Errorf("secure sqlite store directory: %w", err)
		}
	}

	u := &url.URL{Scheme: "file", Path: path}
	query := u.Query()
	query.Set("_txlock", "immediate")
	u.RawQuery = query.Encode()
	db, err := sqlitedriver.Open(u.String())
	if err != nil {
		return nil, fmt.Errorf("open sqlite store: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	store := newSQLStore(db, sqlstore.SQLiteDialect{}, "sqlite", path, false)
	if err := store.initialize(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("secure sqlite store: %w", err)
	}
	store.startMetricMaintenance()
	return store, nil
}

func (s *SQLite) Driver() string { return s.driver }

func (s *SQLite) Info() Info {
	if s.remote {
		return Info{Driver: s.driver, Durable: true, Remote: true, Schema: s.schema, SizeHint: -1}
	}
	size := int64(0)
	for _, path := range []string{s.path, s.path + "-wal", s.path + "-shm"} {
		info, err := os.Stat(path)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return Info{Driver: s.driver, Durable: true, Schema: s.schema, SizeHint: -1}
			}
			continue
		}
		size += info.Size()
	}
	return Info{Driver: s.driver, Durable: true, Schema: s.schema, SizeHint: size}
}

func newSQLStore(db *sql.DB, dialect sqlstore.Dialect, driver, path string, remote bool) *SQLite {
	return &SQLite{
		db: db, path: path, driver: driver, remote: remote, dialect: dialect,
		policies: defaultPolicyMap(),
	}
}

func (s *SQLite) bind(query string) string { return s.dialect.Bind(query) }

func (s *SQLite) exec(query string, args ...any) (sql.Result, error) {
	ctx, cancel := s.operationContext()
	defer cancel()
	return s.db.ExecContext(ctx, s.bind(query), args...)
}

func (s *SQLite) query(query string, args ...any) (*queryRows, error) {
	ctx, cancel := s.operationContext()
	rows, err := s.db.QueryContext(ctx, s.bind(query), args...)
	if err != nil {
		cancel()
		return nil, err
	}
	return &queryRows{Rows: rows, cancel: cancel}, nil
}

func (s *SQLite) queryRow(query string, args ...any) queryRow {
	ctx, cancel := s.operationContext()
	return queryRow{row: s.db.QueryRowContext(ctx, s.bind(query), args...), cancel: cancel}
}

func (s *SQLite) operationContext() (context.Context, context.CancelFunc) {
	if s.remote {
		return context.WithTimeout(context.Background(), sqlOperationTimeout)
	}
	return context.WithCancel(context.Background())
}

func (s *SQLite) withOperationTx(fn func(*sql.Tx) error) error {
	ctx, cancel := s.operationContext()
	defer cancel()
	return sqlstore.WithTx(ctx, s.db, nil, fn)
}

func init() {
	Register("sqlite", func(options OpenOptions) (HistoryStore, error) {
		return NewSQLite(options.Path)
	})
}

func (s *SQLite) initialize() error {
	for _, statement := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
		"PRAGMA cache_size=-20480",
		"PRAGMA journal_size_limit=16777216",
	} {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("configure sqlite store (%s): %w", statement, err)
		}
	}
	if err := s.initializeSQL(context.Background()); err != nil {
		return err
	}
	var integrity string
	if err := s.db.QueryRow("PRAGMA quick_check").Scan(&integrity); err != nil {
		return fmt.Errorf("check sqlite store integrity: %w", err)
	}
	if integrity != "ok" {
		return fmt.Errorf("sqlite store integrity check failed: %s", integrity)
	}
	return nil
}

func (s *SQLite) initializeSQL(ctx context.Context) error {
	version, err := sqlstore.Migrate(ctx, s.db, s.dialect)
	if err != nil {
		return fmt.Errorf("migrate %s store: %w", s.driver, err)
	}
	s.schema = version
	return nil
}

func (s *SQLite) MetricRetention(name string) time.Duration {
	policy := s.policy(metricCategory(name))
	if !policy.Enabled {
		return 0
	}
	return retentionDuration(policy)
}

// ListStoragePolicies returns the active in-memory history policy copy.
func (s *SQLite) ListStoragePolicies() ([]StoragePolicy, error) {
	s.policyMu.RLock()
	defer s.policyMu.RUnlock()
	return policiesFromMap(s.policies), nil
}

// ApplyStoragePolicies configures history writes and retention. The
// authoritative policy set is persisted by the separate state store.
func (s *SQLite) ApplyStoragePolicies(policies []StoragePolicy) error {
	if err := ValidateStoragePolicies(policies); err != nil {
		return err
	}
	s.policyMu.Lock()
	s.policies = policyMap(policies)
	s.policyMu.Unlock()
	return nil
}

func (s *SQLite) PurgeHistory(category StorageCategory) error {
	if _, ok := defaultPolicyMap()[category]; !ok {
		return fmt.Errorf("unknown storage category %q", category)
	}
	if category == StorageAudit {
		return nil
	}
	return s.withOperationTx(func(tx *sql.Tx) error {
		if category == StorageEvents {
			if _, err := tx.Exec(`DELETE FROM history_events`); err != nil {
				return fmt.Errorf("purge event history: %w", err)
			}
		}
		if _, err := tx.Exec(s.bind(`DELETE FROM metric_points WHERE category = ?`), category); err != nil {
			return fmt.Errorf("purge metric history: %w", err)
		}
		return nil
	})
}

func (s *SQLite) StorageStats() (StorageStats, error) {
	counts := make(map[StorageCategory]int64, len(storageCategoryOrder))
	rows, err := s.query(`SELECT category, count(*) FROM metric_points GROUP BY category`)
	if err != nil {
		return StorageStats{}, fmt.Errorf("count metric history: %w", err)
	}
	for rows.Next() {
		var category StorageCategory
		var count int64
		if err := rows.Scan(&category, &count); err != nil {
			_ = rows.Close()
			return StorageStats{}, fmt.Errorf("scan metric history count: %w", err)
		}
		counts[category] += count
	}
	if err := rows.Close(); err != nil {
		return StorageStats{}, fmt.Errorf("close metric history count: %w", err)
	}
	var eventCount int64
	if err := s.queryRow(`SELECT count(*) FROM history_events`).Scan(&eventCount); err != nil {
		return StorageStats{}, fmt.Errorf("count event history: %w", err)
	}
	counts[StorageEvents] = eventCount
	databaseBytes := int64(0)
	if !s.remote {
		for _, path := range []string{s.path, s.path + "-wal", s.path + "-shm"} {
			info, err := os.Stat(path)
			if err == nil {
				databaseBytes += info.Size()
			} else if !errors.Is(err, os.ErrNotExist) {
				return StorageStats{}, fmt.Errorf("stat sqlite store: %w", err)
			}
		}
	}
	categories := make([]StorageCategoryStats, 0, len(storageCategoryOrder))
	for _, category := range storageCategoryOrder {
		categories = append(categories, StorageCategoryStats{Category: category, Records: counts[category]})
	}
	return StorageStats{Driver: s.driver, Durable: true, DatabaseBytes: databaseBytes, Categories: categories}, nil
}

func (s *SQLite) policy(category StorageCategory) StoragePolicy {
	s.policyMu.RLock()
	defer s.policyMu.RUnlock()
	return s.policies[category]
}

func (s *SQLite) Close() error {
	s.closeOnce.Do(func() { s.closeErr = s.closeStore() })
	return s.closeErr
}

func (s *SQLite) closeStore() error {
	var errs []string
	if s.maintenanceStop != nil {
		close(s.maintenanceStop)
		<-s.maintenanceDone
		s.maintenanceStop = nil
		s.maintenanceDone = nil
	}
	if !s.remote {
		if _, err := s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if err := s.db.Close(); err != nil {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func wrapSQLError(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", operation, err)
}

var _ HistoryStore = (*SQLite)(nil)
