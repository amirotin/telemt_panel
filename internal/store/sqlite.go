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
	"sync/atomic"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
	"github.com/ncruces/go-sqlite3"
	sqlitedriver "github.com/ncruces/go-sqlite3/driver"
)

func historySQLContextError(ctx context.Context, err error) error {
	if errors.Is(err, sqlite3.BUSY) || errors.Is(err, sqlite3.LOCKED) {
		err = errors.Join(err, ErrHistoryTimeout)
	}
	return historyContextError(ctx, err)
}

// SQLite contains observability history only; control-plane state lives in the
// local panel-state.json store.
type SQLite struct {
	readOnly bool
	db       *sql.DB
	path     string
	schema   int

	policyMu       sync.RWMutex
	policies       map[StorageCategory]StoragePolicy
	userIPMu       sync.RWMutex
	userIPEpoch    atomic.Uint64
	userIPRevision atomic.Uint64
	userIPWriters  atomic.Int64

	liveMu         sync.RWMutex
	liveMetrics    map[string][]MetricPoint
	pendingMetrics map[string][]MetricPoint
	metricsClosed  bool

	maintenanceStop chan struct{}
	maintenanceDone chan struct{}
	closeOnce       sync.Once
	closeErr        error
}

type queryRows struct {
	*sql.Rows
	ctx    context.Context
	cancel context.CancelFunc
}

func (rows *queryRows) Err() error { return historySQLContextError(rows.ctx, rows.Rows.Err()) }

func (rows *queryRows) Close() error {
	defer rows.cancel()
	return rows.Rows.Close()
}

type queryRow struct {
	row    *sql.Row
	ctx    context.Context
	cancel context.CancelFunc
}

func (row queryRow) Scan(dest ...any) error {
	defer row.cancel()
	return historySQLContextError(row.ctx, row.row.Scan(dest...))
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
	for _, pragma := range []string{"busy_timeout(5000)", "synchronous(FULL)", "foreign_keys(ON)", "cache_size(-20480)", "journal_size_limit(16777216)"} {
		query.Add("_pragma", pragma)
	}
	u.RawQuery = query.Encode()
	db, err := sqlitedriver.Open(u.String())
	if err != nil {
		return nil, fmt.Errorf("open sqlite store: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	store := newSQLStore(db, path)
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

func (s *SQLite) Driver() string { return "sqlite" }

func (s *SQLite) Info() Info {
	size := int64(0)
	for _, path := range []string{s.path, s.path + "-wal", s.path + "-shm"} {
		info, err := os.Stat(path)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return Info{Driver: "sqlite", Durable: true, Schema: s.schema, SizeHint: -1}
			}
			continue
		}
		size += info.Size()
	}
	return Info{Driver: "sqlite", Durable: true, Schema: s.schema, SizeHint: size}
}

func newSQLStore(db *sql.DB, path string) *SQLite {
	return &SQLite{
		db: db, path: path,
		policies: defaultPolicyMap(),
	}
}

func (s *SQLite) exec(query string, args ...any) (sql.Result, error) {
	return s.execContext(context.Background(), query, args...)
}

func (s *SQLite) execContext(parent context.Context, query string, args ...any) (sql.Result, error) {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	result, err := s.db.ExecContext(ctx, query, args...)
	return result, historySQLContextError(ctx, err)
}

func (s *SQLite) query(query string, args ...any) (*queryRows, error) {
	return s.queryContext(context.Background(), query, args...)
}

func (s *SQLite) queryContext(parent context.Context, query string, args ...any) (*queryRows, error) {
	ctx, cancel := historyOperationContext(parent)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		err = historySQLContextError(ctx, err)
		cancel()
		return nil, err
	}
	return &queryRows{Rows: rows, ctx: ctx, cancel: cancel}, nil
}

func (s *SQLite) queryRow(query string, args ...any) queryRow {
	return s.queryRowContext(context.Background(), query, args...)
}

func (s *SQLite) queryRowContext(parent context.Context, query string, args ...any) queryRow {
	ctx, cancel := historyOperationContext(parent)
	return queryRow{row: s.db.QueryRowContext(ctx, query, args...), ctx: ctx, cancel: cancel}
}

func (s *SQLite) withOperationTx(fn func(*sql.Tx) error) error {
	return s.withOperationTxContext(context.Background(), fn)
}

func (s *SQLite) withOperationTxContext(parent context.Context, fn func(*sql.Tx) error) error {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	return historySQLContextError(ctx, sqlstore.WithTx(ctx, s.db, nil, fn))
}

func (s *SQLite) initialize() error {
	if _, err := s.db.Exec("PRAGMA busy_timeout=5000"); err != nil {
		return fmt.Errorf("configure sqlite store (PRAGMA busy_timeout=5000): %w", err)
	}
	if err := s.initializeSQL(context.Background()); err != nil {
		return err
	}
	for _, statement := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA cache_size=-20480",
		"PRAGMA journal_size_limit=16777216",
	} {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("configure sqlite store (%s): %w", statement, err)
		}
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
	version, err := sqlstore.Migrate(ctx, s.db)
	if err != nil {
		return fmt.Errorf("migrate sqlite store: %w", err)
	}
	s.schema = version
	return nil
}

func (s *SQLite) MetricRetention(name string) time.Duration {
	policy := s.policy(metricCategory(name))
	if !persistentMetricHistory(name) || !policy.Enabled {
		return metricRawRetention
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
	return s.ApplyStoragePoliciesContext(context.Background(), policies)
}

func (s *SQLite) ApplyStoragePoliciesContext(parent context.Context, policies []StoragePolicy) error {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	if err := ValidateStoragePolicies(policies); err != nil {
		return err
	}
	if err := lockHistoryMutex(ctx, &s.liveMu); err != nil {
		return err
	}
	defer s.liveMu.Unlock()
	if err := lockHistoryMutex(ctx, &s.userIPMu); err != nil {
		return err
	}
	defer s.userIPMu.Unlock()
	s.policyMu.Lock()
	next := policyMap(policies)
	if s.policies[StorageUserIPHistory] != next[StorageUserIPHistory] {
		s.userIPEpoch.Add(1)
	}
	s.policies = next
	s.policyMu.Unlock()
	for name := range s.pendingMetrics {
		if !s.policy(metricCategory(name)).Enabled {
			delete(s.pendingMetrics, name)
		}
	}
	return s.withOperationTxContext(ctx, func(tx *sql.Tx) error {
		return pruneTrafficSummariesTx(ctx, tx, time.Now().Unix(), retentionDuration(next[StorageUserTraffic]))
	})
}

func (s *SQLite) PurgeHistory(category StorageCategory) error {
	return s.PurgeHistoryContext(context.Background(), category)
}

func (s *SQLite) PurgeHistoryContext(parent context.Context, category StorageCategory) error {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	if category == StorageUserIPHistory {
		return s.ResetUserIPHistoryContext(ctx, "")
	}
	if _, ok := defaultPolicyMap()[category]; !ok {
		return fmt.Errorf("unknown storage category %q", category)
	}
	if category == StorageAudit {
		return nil
	}
	if err := lockHistoryMutex(ctx, &s.liveMu); err != nil {
		return err
	}
	defer s.liveMu.Unlock()
	err := s.withOperationTxContext(ctx, func(tx *sql.Tx) error {
		if category == StorageEvents {
			if _, err := tx.ExecContext(ctx, `DELETE FROM history_events`); err != nil {
				return fmt.Errorf("purge event history: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM metric_points WHERE category = ?`, category); err != nil {
			return fmt.Errorf("purge metric history: %w", err)
		}
		if category == StorageUserTraffic {
			if _, err := tx.ExecContext(ctx, `DELETE FROM user_traffic_buckets`); err != nil {
				return fmt.Errorf("purge user traffic buckets: %w", err)
			}
			return pruneTrafficSummariesTx(ctx, tx, time.Now().Unix(), retentionDuration(s.policy(StorageUserTraffic)))
		}
		return nil
	})
	if err == nil {
		for name := range s.liveMetrics {
			if metricCategory(name) == category {
				delete(s.liveMetrics, name)
				delete(s.pendingMetrics, name)
			}
		}
	}
	return err
}

func (s *SQLite) StorageStats() (StorageStats, error) {
	return s.StorageStatsContext(context.Background())
}

func (s *SQLite) StorageStatsContext(parent context.Context) (StorageStats, error) {
	ctx, cancel := historyOperationContext(parent)
	defer cancel()
	counts := make(map[StorageCategory]int64, len(storageCategoryOrder))
	rows, err := s.queryContext(ctx, `SELECT category, count(*) FROM metric_points GROUP BY category`)
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
	if err := s.queryRowContext(ctx, `SELECT count(*) FROM history_events`).Scan(&eventCount); err != nil {
		return StorageStats{}, fmt.Errorf("count event history: %w", err)
	}
	counts[StorageEvents] = eventCount
	var ipCount int64
	if err := s.queryRowContext(ctx, "SELECT count(*) FROM user_ip_history WHERE last_ts>=?", time.Now().Unix()-int64(s.UserIPRetention()/time.Second)).Scan(&ipCount); err != nil {
		return StorageStats{}, err
	}
	counts[StorageUserIPHistory] = ipCount
	var userTrafficCount int64
	if err := s.queryRowContext(ctx, `SELECT count(*) FROM user_traffic_buckets`).Scan(&userTrafficCount); err != nil {
		return StorageStats{}, fmt.Errorf("count user traffic history: %w", err)
	}
	counts[StorageUserTraffic] += userTrafficCount
	var userTrafficUsers int64
	if err := s.queryRowContext(ctx, `SELECT count(*) FROM user_traffic_users`).Scan(&userTrafficUsers); err != nil {
		return StorageStats{}, fmt.Errorf("count user traffic users: %w", err)
	}
	collector, err := s.UserTrafficCollectorState()
	if err != nil {
		return StorageStats{}, err
	}
	databaseBytes := int64(0)
	for _, path := range []string{s.path, s.path + "-wal", s.path + "-shm"} {
		info, err := os.Stat(path)
		if err == nil {
			databaseBytes += info.Size()
		} else if !errors.Is(err, os.ErrNotExist) {
			return StorageStats{}, fmt.Errorf("stat sqlite store: %w", err)
		}
	}
	categories := make([]StorageCategoryStats, 0, len(storageCategoryOrder))
	for _, category := range storageCategoryOrder {
		stats := StorageCategoryStats{Category: category, Records: counts[category]}
		if category == StorageUserTraffic {
			entities := userTrafficUsers
			stats.Entities = &entities
			stats.Collector = &collector
		}
		categories = append(categories, stats)
	}
	return StorageStats{Driver: "sqlite", Durable: true, DatabaseBytes: databaseBytes, Categories: categories}, nil
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
	if s.readOnly {
		return s.db.Close()
	}
	var errs []string
	if s.maintenanceStop != nil {
		close(s.maintenanceStop)
		<-s.maintenanceDone
		s.maintenanceStop = nil
		s.maintenanceDone = nil
	}
	s.liveMu.Lock()
	s.metricsClosed = true
	s.liveMu.Unlock()
	if err := s.flushMetrics(); err != nil {
		errs = append(errs, err.Error())
	}
	ctx, cancel := historyOperationContext(context.Background())
	defer cancel()
	if _, err := s.db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		errs = append(errs, err.Error())
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
