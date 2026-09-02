//go:build !lite

package store

import (
	"context"
	"database/sql"
	"encoding/json"
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

// SQLite is the durable Store implementation. It keeps mandatory panel
// state and optional history in one transactional database.
type SQLite struct {
	db      *sql.DB
	path    string
	driver  string
	remote  bool
	schema  int
	dialect sqlstore.Dialect

	policyMu  sync.RWMutex
	policies  map[StorageCategory]StoragePolicy
	lastPrune map[StorageCategory]time.Time

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

// NewSQLite opens or creates a durable store at path. When the database is
// new, mirrorPath is imported transactionally so existing sessions and panel
// settings survive the switch from the memory driver.
func NewSQLite(path, mirrorPath string) (*SQLite, error) {
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
	q := u.Query()
	q.Set("_txlock", "immediate")
	u.RawQuery = q.Encode()
	db, err := sqlitedriver.Open(u.String())
	if err != nil {
		return nil, fmt.Errorf("open sqlite store: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	s := newSQLStore(db, sqlstore.SQLiteDialect{}, "sqlite", path, false)
	if err := s.initialize(mirrorPath); err != nil {
		db.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		db.Close()
		return nil, fmt.Errorf("secure sqlite store: %w", err)
	}
	s.startMetricMaintenance()
	return s, nil
}

// Driver returns the backend name.
func (s *SQLite) Driver() string { return s.driver }

// Info reports SQLite capabilities and its current on-disk footprint.
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
	return Info{Driver: s.driver, Durable: true, Remote: false, Schema: s.schema, SizeHint: size}
}

func newSQLStore(db *sql.DB, dialect sqlstore.Dialect, driver, path string, remote bool) *SQLite {
	return &SQLite{
		db: db, path: path, driver: driver, remote: remote, dialect: dialect,
		policies: defaultPolicyMap(), lastPrune: make(map[StorageCategory]time.Time),
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
	Register("sqlite", func(options OpenOptions) (Store, error) {
		return NewSQLite(options.Path, options.MirrorPath)
	})
}

func (s *SQLite) initialize(mirrorPath string) error {
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
	if err := s.importMirror(mirrorPath); err != nil {
		return err
	}
	return s.loadPolicies()
}

func (s *SQLite) initializeSQL(ctx context.Context) error {
	version, err := sqlstore.Migrate(ctx, s.db, s.dialect)
	if err != nil {
		return fmt.Errorf("migrate %s store: %w", s.driver, err)
	}
	s.schema = version
	return s.loadPolicies()
}

func (s *SQLite) loadPolicies() error {
	rows, err := s.query(`SELECT category, enabled, retention_days FROM storage_policies`)
	if err != nil {
		return fmt.Errorf("read %s storage policies: %w", s.driver, err)
	}
	defer rows.Close()
	byCategory := defaultPolicyMap()
	for rows.Next() {
		var policy StoragePolicy
		if err := rows.Scan(&policy.Category, &policy.Enabled, &policy.RetentionDays); err != nil {
			return fmt.Errorf("scan %s storage policy: %w", s.driver, err)
		}
		if _, ok := byCategory[policy.Category]; !ok {
			return fmt.Errorf("unknown %s storage policy category %q", s.driver, policy.Category)
		}
		byCategory[policy.Category] = policy
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate %s storage policies: %w", s.driver, err)
	}
	policies := policiesFromMap(byCategory)
	if err := ValidateStoragePolicies(policies); err != nil {
		return fmt.Errorf("validate %s storage policies: %w", s.driver, err)
	}
	s.policyMu.Lock()
	s.policies = byCategory
	s.policyMu.Unlock()
	return nil
}

func (s *SQLite) importMirror(mirrorPath string) error {
	if mirrorPath == "" {
		return nil
	}
	var marker string
	err := s.queryRow(`SELECT value FROM settings WHERE setting_key = 'migration.memory_mirror_imported'`).Scan(&marker)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("check memory mirror migration: %w", err)
	}

	data, err := os.ReadFile(mirrorPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read memory mirror for migration: %w", err)
	}
	var mirror mirrorFile
	if err := json.Unmarshal(data, &mirror); err != nil {
		return fmt.Errorf("decode memory mirror for migration: %w", err)
	}

	return sqlstore.WithTx(context.Background(), s.db, nil, func(tx *sql.Tx) error {
		var existing int
		if err := tx.QueryRow(s.bind(`SELECT
		(SELECT count(*) FROM sessions) +
		(SELECT count(*) FROM subpage_nonces) +
		(SELECT count(*) FROM settings) +
		(SELECT count(*) FROM update_journal) +
		(SELECT count(*) FROM audit_entries) +
		(SELECT count(*) FROM metric_points)`)).Scan(&existing); err != nil {
			return fmt.Errorf("inspect sqlite store before mirror migration: %w", err)
		}
		if existing > 0 {
			return nil
		}

		for _, session := range mirror.Sessions {
			if _, err := tx.Exec(s.bind(`INSERT INTO sessions(id_hash, created_ns, last_seen_ns, ip, user_agent_label, auth_method) VALUES(?, ?, ?, ?, ?, ?)`),
				session.IDHash, session.Created.UnixNano(), session.LastSeen.UnixNano(), session.IP, session.UserAgentLabel, session.AuthMethod); err != nil {
				return fmt.Errorf("import mirrored session: %w", err)
			}
		}
		for username, nonce := range mirror.SubpageNonces {
			if _, err := tx.Exec(s.bind(`INSERT INTO subpage_nonces(username, nonce) VALUES(?, ?)`), username, nonce); err != nil {
				return fmt.Errorf("import mirrored subpage nonce: %w", err)
			}
		}
		for key, value := range mirror.Settings {
			if _, err := tx.Exec(s.bind(`INSERT INTO settings(setting_key, value) VALUES(?, ?)`), key, value); err != nil {
				return fmt.Errorf("import mirrored setting: %w", err)
			}
		}
		for _, entries := range mirror.Journal {
			for _, entry := range entries {
				if _, err := tx.Exec(s.bind(`INSERT INTO update_journal(target, run_id, phase, version_from, version_to, ts_ns, detail) VALUES(?, ?, ?, ?, ?, ?, ?)`),
					entry.Target, entry.RunID, entry.Phase, entry.VersionFrom, entry.VersionTo, entry.TS.UnixNano(), entry.Detail); err != nil {
					return fmt.Errorf("import mirrored update journal: %w", err)
				}
			}
		}
		if len(mirror.Policies) > 0 {
			if err := ValidateStoragePolicies(mirror.Policies); err != nil {
				return fmt.Errorf("import mirrored storage policies: %w", err)
			}
			for _, policy := range mirror.Policies {
				if _, err := tx.Exec(s.bind(`UPDATE storage_policies SET enabled = ?, retention_days = ? WHERE category = ?`), policy.Enabled, policy.RetentionDays, policy.Category); err != nil {
					return fmt.Errorf("import mirrored storage policy: %w", err)
				}
			}
		}
		if _, err := tx.Exec(`INSERT INTO settings(setting_key, value) VALUES('migration.memory_mirror_imported', '1')`); err != nil {
			return fmt.Errorf("mark memory mirror migration: %w", err)
		}
		return nil
	})
}

// PutSession creates or replaces a session.
func (s *SQLite) PutSession(session Session) error {
	query := s.dialect.Upsert("sessions", []string{"id_hash"}, []string{"created_ns", "last_seen_ns", "ip", "user_agent_label", "auth_method"})
	_, err := s.exec(query,
		session.IDHash, session.Created.UnixNano(), session.LastSeen.UnixNano(), session.IP, session.UserAgentLabel, session.AuthMethod)
	return wrapSQLError("put session", err)
}

// GetSession looks up a session by its token hash.
func (s *SQLite) GetSession(idHash string) (Session, bool, error) {
	var session Session
	var createdNS, lastSeenNS int64
	err := s.queryRow(`SELECT id_hash, created_ns, last_seen_ns, ip, user_agent_label, auth_method FROM sessions WHERE id_hash = ?`, idHash).
		Scan(&session.IDHash, &createdNS, &lastSeenNS, &session.IP, &session.UserAgentLabel, &session.AuthMethod)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, fmt.Errorf("get session: %w", err)
	}
	session.Created = time.Unix(0, createdNS).UTC()
	session.LastSeen = time.Unix(0, lastSeenNS).UTC()
	return session, true, nil
}

// TouchSession advances a session's last-seen timestamp.
func (s *SQLite) TouchSession(idHash string, at time.Time) error {
	_, err := s.exec(`UPDATE sessions SET last_seen_ns = ? WHERE id_hash = ?`, at.UnixNano(), idHash)
	return wrapSQLError("touch session", err)
}

// DeleteSession removes one session.
func (s *SQLite) DeleteSession(idHash string) error {
	_, err := s.exec(`DELETE FROM sessions WHERE id_hash = ?`, idHash)
	return wrapSQLError("delete session", err)
}

// DeleteOtherSessions removes every session except the supplied hash.
func (s *SQLite) DeleteOtherSessions(keepIDHash string) error {
	_, err := s.exec(`DELETE FROM sessions WHERE id_hash <> ?`, keepIDHash)
	return wrapSQLError("delete other sessions", err)
}

// ListSessions returns sessions newest first.
func (s *SQLite) ListSessions() ([]Session, error) {
	rows, err := s.query(`SELECT id_hash, created_ns, last_seen_ns, ip, user_agent_label, auth_method FROM sessions ORDER BY created_ns DESC`)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var session Session
		var createdNS, lastSeenNS int64
		if err := rows.Scan(&session.IDHash, &createdNS, &lastSeenNS, &session.IP, &session.UserAgentLabel, &session.AuthMethod); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		session.Created = time.Unix(0, createdNS).UTC()
		session.LastSeen = time.Unix(0, lastSeenNS).UTC()
		out = append(out, session)
	}
	return out, rows.Err()
}

// AppendAudit records an audit entry when that history family is enabled.
func (s *SQLite) AppendAudit(entry AuditEntry) error {
	policy := s.policy(StorageAudit)
	if !policy.Enabled {
		return nil
	}
	_, err := s.exec(`INSERT INTO audit_entries(ts_ns, id, action, actor, target, outcome, ip, subject, detail) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		entry.TS.UnixNano(), entry.ID, entry.Action, entry.Actor, entry.Target, entry.Outcome, entry.IP, entry.Subject, entry.Detail)
	if err != nil {
		return fmt.Errorf("append audit: %w", err)
	}
	return s.prune(StorageAudit, time.Now())
}

// ListAudit returns audit entries newest first.
func (s *SQLite) ListAudit(limit int) ([]AuditEntry, error) {
	query := `SELECT ts_ns, id, action, actor, target, outcome, ip, subject, detail FROM audit_entries ORDER BY ts_ns DESC, seq DESC`
	var rows *queryRows
	var err error
	if limit > 0 {
		rows, err = s.query(query+` LIMIT ?`, limit)
	} else {
		rows, err = s.query(query)
	}
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var entry AuditEntry
		var tsNS int64
		if err := rows.Scan(&tsNS, &entry.ID, &entry.Action, &entry.Actor, &entry.Target, &entry.Outcome, &entry.IP, &entry.Subject, &entry.Detail); err != nil {
			return nil, fmt.Errorf("scan audit entry: %w", err)
		}
		entry.TS = time.Unix(0, tsNS).UTC()
		out = append(out, entry)
	}
	return out, rows.Err()
}

// AppendUpdateJournal records a mandatory update recovery step.
func (s *SQLite) AppendUpdateJournal(entry UpdateJournalEntry) error {
	return s.withOperationTx(func(tx *sql.Tx) error {
		if _, err := tx.Exec(s.bind(`INSERT INTO update_journal(target, run_id, phase, version_from, version_to, ts_ns, detail) VALUES(?, ?, ?, ?, ?, ?, ?)`),
			entry.Target, entry.RunID, entry.Phase, entry.VersionFrom, entry.VersionTo, entry.TS.UnixNano(), entry.Detail); err != nil {
			return fmt.Errorf("append update journal: %w", err)
		}
		var oldestKept int64
		err := tx.QueryRow(s.bind(`SELECT seq FROM update_journal WHERE target = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`), entry.Target, journalCap-1).Scan(&oldestKept)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("find update journal trim boundary: %w", err)
		}
		if err == nil {
			if _, err := tx.Exec(s.bind(`DELETE FROM update_journal WHERE target = ? AND seq < ?`), entry.Target, oldestKept); err != nil {
				return fmt.Errorf("trim update journal: %w", err)
			}
		}
		return nil
	})
}

// ListUpdateJournal returns update records newest first.
func (s *SQLite) ListUpdateJournal(target string, limit int) ([]UpdateJournalEntry, error) {
	query := `SELECT target, run_id, phase, version_from, version_to, ts_ns, detail FROM update_journal WHERE target = ? ORDER BY seq DESC`
	args := []any{target}
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list update journal: %w", err)
	}
	defer rows.Close()
	var out []UpdateJournalEntry
	for rows.Next() {
		var entry UpdateJournalEntry
		var tsNS int64
		if err := rows.Scan(&entry.Target, &entry.RunID, &entry.Phase, &entry.VersionFrom, &entry.VersionTo, &tsNS, &entry.Detail); err != nil {
			return nil, fmt.Errorf("scan update journal entry: %w", err)
		}
		entry.TS = time.Unix(0, tsNS).UTC()
		out = append(out, entry)
	}
	return out, rows.Err()
}

// MetricRetention reports the configured metric retention.
func (s *SQLite) MetricRetention(name string) time.Duration {
	policy := s.policy(metricCategory(name))
	if !policy.Enabled {
		return 0
	}
	return retentionDuration(policy)
}

// GetSubpageNonce returns the current nonce for a user.
func (s *SQLite) GetSubpageNonce(username string) (string, error) {
	var nonce string
	err := s.queryRow(`SELECT nonce FROM subpage_nonces WHERE username = ?`, username).Scan(&nonce)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get subpage nonce: %w", err)
	}
	return nonce, nil
}

// SetSubpageNonce sets the current nonce for a user.
func (s *SQLite) SetSubpageNonce(username, nonce string) error {
	_, err := s.exec(s.dialect.Upsert("subpage_nonces", []string{"username"}, []string{"nonce"}), username, nonce)
	return wrapSQLError("set subpage nonce", err)
}

// GetSetting returns a persisted panel setting.
func (s *SQLite) GetSetting(key string) (string, bool, error) {
	var value string
	err := s.queryRow(`SELECT value FROM settings WHERE setting_key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("get setting: %w", err)
	}
	return value, true, nil
}

// SetSetting creates or replaces a panel setting.
func (s *SQLite) SetSetting(key, value string) error {
	_, err := s.exec(s.dialect.Upsert("settings", []string{"setting_key"}, []string{"value"}), key, value)
	return wrapSQLError("set setting", err)
}

// ListStoragePolicies returns every policy in stable UI order.
func (s *SQLite) ListStoragePolicies() ([]StoragePolicy, error) {
	s.policyMu.RLock()
	defer s.policyMu.RUnlock()
	return policiesFromMap(s.policies), nil
}

// ReplaceStoragePolicies atomically persists a complete policy set.
func (s *SQLite) ReplaceStoragePolicies(policies []StoragePolicy) error {
	if err := ValidateStoragePolicies(policies); err != nil {
		return err
	}
	if err := s.withOperationTx(func(tx *sql.Tx) error {
		for _, policy := range policies {
			if _, err := tx.Exec(s.bind(`UPDATE storage_policies SET enabled = ?, retention_days = ? WHERE category = ?`), policy.Enabled, policy.RetentionDays, policy.Category); err != nil {
				return fmt.Errorf("update storage policy %q: %w", policy.Category, err)
			}
		}
		return nil
	}); err != nil {
		return fmt.Errorf("replace storage policies: %w", err)
	}
	s.policyMu.Lock()
	s.policies = policyMap(policies)
	for category := range s.lastPrune {
		delete(s.lastPrune, category)
	}
	s.policyMu.Unlock()
	for _, policy := range policies {
		if policy.Enabled {
			if err := s.prune(policy.Category, time.Now()); err != nil {
				return err
			}
		}
	}
	return nil
}

// PurgeHistory permanently removes all stored rows in a category.
func (s *SQLite) PurgeHistory(category StorageCategory) error {
	if _, ok := defaultPolicyMap()[category]; !ok {
		return fmt.Errorf("unknown storage category %q", category)
	}
	return s.withOperationTx(func(tx *sql.Tx) error {
		if category == StorageAudit {
			if _, err := tx.Exec(`DELETE FROM audit_entries`); err != nil {
				return fmt.Errorf("purge audit history: %w", err)
			}
		}
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

// StorageStats reports database footprint and history record counts.
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
			rows.Close()
			return StorageStats{}, fmt.Errorf("scan metric history count: %w", err)
		}
		counts[category] += count
	}
	if err := rows.Close(); err != nil {
		return StorageStats{}, fmt.Errorf("close metric history count: %w", err)
	}
	var auditCount int64
	if err := s.queryRow(`SELECT count(*) FROM audit_entries`).Scan(&auditCount); err != nil {
		return StorageStats{}, fmt.Errorf("count audit history: %w", err)
	}
	counts[StorageAudit] = auditCount
	var eventCount int64
	if err := s.queryRow(`SELECT count(*) FROM history_events`).Scan(&eventCount); err != nil {
		return StorageStats{}, fmt.Errorf("count event history: %w", err)
	}
	counts[StorageEvents] = eventCount
	var databaseBytes int64
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

func (s *SQLite) prune(category StorageCategory, now time.Time) error {
	s.policyMu.Lock()
	if last := s.lastPrune[category]; !last.IsZero() && now.Sub(last) < time.Hour {
		s.policyMu.Unlock()
		return nil
	}
	policy := s.policies[category]
	s.policyMu.Unlock()
	if !policy.Enabled {
		return nil
	}
	cutoff := now.Add(-retentionDuration(policy))
	if category == StorageAudit {
		if _, err := s.exec(`DELETE FROM audit_entries WHERE ts_ns < ?`, cutoff.UnixNano()); err != nil {
			return fmt.Errorf("prune audit history: %w", err)
		}
	}
	if category == StorageEvents {
		if _, err := s.exec(`DELETE FROM history_events WHERE category = ? AND ts_ns < ?`, category, cutoff.UnixNano()); err != nil {
			return fmt.Errorf("prune event history: %w", err)
		}
	}
	for _, tier := range metricTierRetention {
		tierCutoff := cutoff
		if tier.keep > 0 && now.Add(-tier.keep).After(tierCutoff) {
			tierCutoff = now.Add(-tier.keep)
		}
		if category == StorageUserTraffic && tier.tier == MetricTierQuarter && now.Add(-userTrafficFineRetention).After(tierCutoff) {
			tierCutoff = now.Add(-userTrafficFineRetention)
		}
		if _, err := s.exec(`DELETE FROM metric_points WHERE category = ? AND tier = ? AND ts < ?`, category, tier.sql, tierCutoff.Unix()); err != nil {
			return fmt.Errorf("prune %s metric history: %w", tier.sql, err)
		}
	}
	s.policyMu.Lock()
	s.lastPrune[category] = now
	s.policyMu.Unlock()
	return nil
}

// Close checkpoints the WAL before closing the database.
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
