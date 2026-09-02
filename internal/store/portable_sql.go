//go:build !lite

package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

// ExportData returns a consistent, driver-neutral snapshot of a SQL store.
func (s *SQLite) ExportData() (PortableData, error) {
	data := PortableData{
		FormatVersion: portableFormatVersion,
		Sessions:      make(map[string]Session),
		SubpageNonces: make(map[string]string),
		Settings:      make(map[string]string),
		Journal:       make(map[string][]UpdateJournalEntry),
		Metrics:       make(map[string][]MetricPoint),
	}
	err := sqlstore.WithTx(context.Background(), s.db, &sql.TxOptions{ReadOnly: true}, func(tx *sql.Tx) error {
		var err error
		if data.Sessions, err = exportSessions(s, tx); err != nil {
			return err
		}
		if data.Audit, err = exportAudit(s, tx); err != nil {
			return err
		}
		if data.Journal, err = exportJournal(s, tx); err != nil {
			return err
		}
		if data.Metrics, err = exportMetrics(s, tx); err != nil {
			return err
		}
		if data.SubpageNonces, err = exportStringMap(s, tx, `SELECT username, nonce FROM subpage_nonces ORDER BY username`); err != nil {
			return fmt.Errorf("export subpage nonces: %w", err)
		}
		if data.Settings, err = exportStringMap(s, tx, `SELECT setting_key, value FROM settings WHERE setting_key <> 'migration.memory_mirror_imported' ORDER BY setting_key`); err != nil {
			return fmt.Errorf("export settings: %w", err)
		}
		data.Policies, err = exportPolicies(s, tx)
		return err
	})
	if err != nil {
		return PortableData{}, fmt.Errorf("export %s store: %w", s.driver, err)
	}
	return data, nil
}

// ImportData fills a fresh SQL store in one transaction. Existing application
// state is never merged or overwritten.
func (s *SQLite) ImportData(data PortableData) error {
	data, err := normalizePortableData(data)
	if err != nil {
		return err
	}
	err = sqlstore.WithTx(context.Background(), s.db, nil, func(tx *sql.Tx) error {
		var count int
		if err := tx.QueryRow(s.bind(`SELECT
			(SELECT count(*) FROM sessions) +
			(SELECT count(*) FROM subpage_nonces) +
			(SELECT count(*) FROM settings) +
			(SELECT count(*) FROM update_journal) +
			(SELECT count(*) FROM audit_entries) +
			(SELECT count(*) FROM metric_points)`)).Scan(&count); err != nil {
			return fmt.Errorf("inspect destination: %w", err)
		}
		if count != 0 {
			return ErrStoreNotEmpty
		}

		for _, session := range data.Sessions {
			if _, err := tx.Exec(s.bind(`INSERT INTO sessions(id_hash, created_ns, last_seen_ns, ip, user_agent_label, auth_method) VALUES(?, ?, ?, ?, ?, ?)`), session.IDHash, session.Created.UnixNano(), session.LastSeen.UnixNano(), session.IP, session.UserAgentLabel, session.AuthMethod); err != nil {
				return fmt.Errorf("import session: %w", err)
			}
		}
		for _, entry := range data.Audit {
			if _, err := tx.Exec(s.bind(`INSERT INTO audit_entries(ts_ns, id, action, actor, target, outcome, ip, subject, detail) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`), entry.TS.UnixNano(), entry.ID, entry.Action, entry.Actor, entry.Target, entry.Outcome, entry.IP, entry.Subject, entry.Detail); err != nil {
				return fmt.Errorf("import audit entry: %w", err)
			}
		}
		for _, target := range sortedKeys(data.Journal) {
			for _, entry := range data.Journal[target] {
				if _, err := tx.Exec(s.bind(`INSERT INTO update_journal(target, run_id, phase, version_from, version_to, ts_ns, detail) VALUES(?, ?, ?, ?, ?, ?, ?)`), entry.Target, entry.RunID, entry.Phase, entry.VersionFrom, entry.VersionTo, entry.TS.UnixNano(), entry.Detail); err != nil {
					return fmt.Errorf("import update journal: %w", err)
				}
			}
		}
		for username, nonce := range data.SubpageNonces {
			if _, err := tx.Exec(s.bind(`INSERT INTO subpage_nonces(username, nonce) VALUES(?, ?)`), username, nonce); err != nil {
				return fmt.Errorf("import subpage nonce: %w", err)
			}
		}
		for key, value := range data.Settings {
			if _, err := tx.Exec(s.bind(`INSERT INTO settings(setting_key, value) VALUES(?, ?)`), key, value); err != nil {
				return fmt.Errorf("import setting: %w", err)
			}
		}
		for _, name := range sortedKeys(data.Metrics) {
			for _, point := range data.Metrics[name] {
				if _, err := tx.Exec(s.bind(`INSERT INTO metric_points(name, category, ts, value) VALUES(?, ?, ?, ?)`), name, metricCategory(name), point.TS, point.Value); err != nil {
					return fmt.Errorf("import metric point: %w", err)
				}
			}
		}
		for _, policy := range data.Policies {
			if _, err := tx.Exec(s.bind(`UPDATE storage_policies SET enabled = ?, retention_days = ? WHERE category = ?`), policy.Enabled, policy.RetentionDays, policy.Category); err != nil {
				return fmt.Errorf("import storage policy: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("import %s store: %w", s.driver, err)
	}
	if len(data.Policies) > 0 {
		s.policyMu.Lock()
		s.policies = policyMap(data.Policies)
		s.policyMu.Unlock()
	}
	return nil
}

func exportSessions(s *SQLite, tx *sql.Tx) (map[string]Session, error) {
	rows, err := tx.Query(s.bind(`SELECT id_hash, created_ns, last_seen_ns, ip, user_agent_label, auth_method FROM sessions ORDER BY id_hash`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]Session)
	for rows.Next() {
		var item Session
		var createdNS, lastSeenNS int64
		if err := rows.Scan(&item.IDHash, &createdNS, &lastSeenNS, &item.IP, &item.UserAgentLabel, &item.AuthMethod); err != nil {
			return nil, err
		}
		item.Created = time.Unix(0, createdNS).UTC()
		item.LastSeen = time.Unix(0, lastSeenNS).UTC()
		out[item.IDHash] = item
	}
	return out, rows.Err()
}

func exportAudit(s *SQLite, tx *sql.Tx) ([]AuditEntry, error) {
	rows, err := tx.Query(s.bind(`SELECT ts_ns, id, action, actor, target, outcome, ip, subject, detail FROM audit_entries ORDER BY seq`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var item AuditEntry
		var tsNS int64
		if err := rows.Scan(&tsNS, &item.ID, &item.Action, &item.Actor, &item.Target, &item.Outcome, &item.IP, &item.Subject, &item.Detail); err != nil {
			return nil, err
		}
		item.TS = time.Unix(0, tsNS).UTC()
		out = append(out, item)
	}
	return out, rows.Err()
}

func exportJournal(s *SQLite, tx *sql.Tx) (map[string][]UpdateJournalEntry, error) {
	rows, err := tx.Query(s.bind(`SELECT target, run_id, phase, version_from, version_to, ts_ns, detail FROM update_journal ORDER BY seq`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]UpdateJournalEntry)
	for rows.Next() {
		var item UpdateJournalEntry
		var tsNS int64
		if err := rows.Scan(&item.Target, &item.RunID, &item.Phase, &item.VersionFrom, &item.VersionTo, &tsNS, &item.Detail); err != nil {
			return nil, err
		}
		item.TS = time.Unix(0, tsNS).UTC()
		out[item.Target] = append(out[item.Target], item)
	}
	return out, rows.Err()
}

func exportMetrics(s *SQLite, tx *sql.Tx) (map[string][]MetricPoint, error) {
	rows, err := tx.Query(s.bind(`SELECT name, ts, value FROM metric_points ORDER BY name, ts`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]MetricPoint)
	for rows.Next() {
		var name string
		var point MetricPoint
		if err := rows.Scan(&name, &point.TS, &point.Value); err != nil {
			return nil, err
		}
		out[name] = append(out[name], point)
	}
	return out, rows.Err()
}

func exportStringMap(s *SQLite, tx *sql.Tx, query string) (map[string]string, error) {
	rows, err := tx.Query(s.bind(query))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		out[key] = value
	}
	return out, rows.Err()
}

func exportPolicies(s *SQLite, tx *sql.Tx) ([]StoragePolicy, error) {
	rows, err := tx.Query(s.bind(`SELECT category, enabled, retention_days FROM storage_policies ORDER BY category`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byCategory := make(map[StorageCategory]StoragePolicy)
	for rows.Next() {
		var policy StoragePolicy
		if err := rows.Scan(&policy.Category, &policy.Enabled, &policy.RetentionDays); err != nil {
			return nil, err
		}
		byCategory[policy.Category] = policy
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return policiesFromMap(byCategory), nil
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
