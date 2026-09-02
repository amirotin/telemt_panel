//go:build !lite

package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// AppendHistoryEvent records one structured transition when its category is
// enabled. Empty categories default to the independently configurable events
// family.
func (s *SQLite) AppendHistoryEvent(event HistoryEvent) error {
	if event.Category == "" {
		event.Category = StorageEvents
	}
	policy, ok := defaultPolicyMap()[event.Category]
	if !ok {
		return fmt.Errorf("unknown history event category %q", event.Category)
	}
	policy = s.policy(event.Category)
	if !policy.Enabled {
		return nil
	}
	attributes, err := json.Marshal(event.Attributes)
	if err != nil {
		return fmt.Errorf("encode history event attributes: %w", err)
	}
	if event.TS.IsZero() {
		event.TS = time.Now()
	}
	if _, err := s.exec(`INSERT INTO history_events(ts_ns, category, kind, entity, state, previous_state, severity, attributes_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
		event.TS.UnixNano(), event.Category, event.Kind, event.Entity, event.State, event.PreviousState, event.Severity, string(attributes)); err != nil {
		return fmt.Errorf("append history event: %w", err)
	}
	return nil
}

// pruneHistoryEventBatch deletes at most limit expired structured events.
func (s *SQLite) pruneHistoryEventBatch(now time.Time, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	policy := s.policy(StorageEvents)
	if !policy.Enabled {
		return 0, nil
	}
	cutoff := now.Add(-retentionDuration(policy)).UnixNano()
	rows, err := s.query(`SELECT seq FROM history_events WHERE category = ? AND ts_ns < ? ORDER BY ts_ns, seq LIMIT ?`, StorageEvents, cutoff, limit)
	if err != nil {
		return 0, fmt.Errorf("select stale history events: %w", err)
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan stale history event: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("read stale history events: %w", err)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	if err := s.withOperationTx(func(tx *sql.Tx) error {
		for _, id := range ids {
			if _, err := tx.Exec(s.bind(`DELETE FROM history_events WHERE seq = ?`), id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return 0, fmt.Errorf("prune history events batch: %w", err)
	}
	return len(ids), nil
}

// ListHistoryEvents returns matching structured events newest first.
func (s *SQLite) ListHistoryEvents(filter HistoryEventFilter) ([]HistoryEvent, error) {
	query := `SELECT seq, ts_ns, category, kind, entity, state, previous_state, severity, attributes_json FROM history_events`
	where := make([]string, 0, 4)
	args := make([]any, 0, 5)
	if !filter.From.IsZero() {
		where = append(where, `ts_ns >= ?`)
		args = append(args, filter.From.UnixNano())
	}
	if filter.Category != "" {
		where = append(where, `category = ?`)
		args = append(args, filter.Category)
	}
	if filter.Kind != "" {
		where = append(where, `kind = ?`)
		args = append(args, filter.Kind)
	}
	if filter.Entity != "" {
		where = append(where, `entity = ?`)
		args = append(args, filter.Entity)
	}
	if len(where) > 0 {
		query += ` WHERE ` + strings.Join(where, ` AND `)
	}
	query += ` ORDER BY ts_ns DESC, seq DESC`
	if filter.Limit > 0 {
		query += ` LIMIT ?`
		args = append(args, filter.Limit)
	}
	rows, err := s.query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list history events: %w", err)
	}
	defer rows.Close()
	var out []HistoryEvent
	for rows.Next() {
		var event HistoryEvent
		var tsNS int64
		var attributes string
		if err := rows.Scan(&event.ID, &tsNS, &event.Category, &event.Kind, &event.Entity, &event.State, &event.PreviousState, &event.Severity, &attributes); err != nil {
			return nil, fmt.Errorf("scan history event: %w", err)
		}
		event.TS = time.Unix(0, tsNS).UTC()
		if attributes != "" && attributes != "null" {
			if err := json.Unmarshal([]byte(attributes), &event.Attributes); err != nil {
				return nil, fmt.Errorf("decode history event attributes: %w", err)
			}
		}
		out = append(out, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate history events: %w", err)
	}
	return out, nil
}
