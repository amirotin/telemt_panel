//go:build !lite

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

// ExportData returns only observability history. Control-plane state is
// exported by Composite from panel-state.json.
func (s *SQLite) ExportData() (PortableData, error) {
	data := PortableData{FormatVersion: portableFormatVersion, Metrics: make(map[string][]MetricPoint)}
	err := sqlstore.WithTx(context.Background(), s.db, &sql.TxOptions{ReadOnly: true}, func(tx *sql.Tx) error {
		var err error
		if data.Metrics, err = exportMetrics(s, tx); err != nil {
			return err
		}
		data.Events, err = exportEvents(s, tx)
		return err
	})
	if err != nil {
		return PortableData{}, fmt.Errorf("export %s history: %w", s.driver, err)
	}
	return data, nil
}

// ImportData fills a fresh history database. State fields in a combined
// backup are deliberately ignored here and restored by Composite instead.
func (s *SQLite) ImportData(data PortableData) error {
	data, err := normalizePortableData(data)
	if err != nil {
		return err
	}
	err = sqlstore.WithTx(context.Background(), s.db, nil, func(tx *sql.Tx) error {
		var count int
		if err := tx.QueryRow(s.bind(`SELECT
			(SELECT count(*) FROM metric_points) +
			(SELECT count(*) FROM history_events)`)).Scan(&count); err != nil {
			return fmt.Errorf("inspect history destination: %w", err)
		}
		if count != 0 {
			return ErrStoreNotEmpty
		}

		for _, name := range sortedKeys(data.Metrics) {
			for _, point := range data.Metrics[name] {
				tier := metricTierSQL(point.Tier)
				maxValue := point.Max
				samples := point.Samples
				if point.Tier == MetricTierRaw {
					maxValue = point.Value
					samples = 1
				}
				if samples < 1 {
					samples = 1
				}
				if _, err := tx.Exec(s.bind(`INSERT INTO metric_points(name, category, tier, ts, value, max, samples, last_ts) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`), name, metricCategory(name), tier, point.TS, point.Value, maxValue, samples, point.TS); err != nil {
					return fmt.Errorf("import metric point: %w", err)
				}
			}
		}
		for _, event := range data.Events {
			attributes, err := json.Marshal(event.Attributes)
			if err != nil {
				return fmt.Errorf("encode imported history event attributes: %w", err)
			}
			if _, err := tx.Exec(s.bind(`INSERT INTO history_events(ts_ns, category, kind, entity, state, previous_state, severity, attributes_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`), event.TS.UnixNano(), event.Category, event.Kind, event.Entity, event.State, event.PreviousState, event.Severity, string(attributes)); err != nil {
				return fmt.Errorf("import history event: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("import %s history: %w", s.driver, err)
	}
	return nil
}

func (s *SQLite) rollbackImportedHistory() error {
	return sqlstore.WithTx(context.Background(), s.db, nil, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`DELETE FROM history_events`); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM metric_points`)
		return err
	})
}

func exportMetrics(s *SQLite, tx *sql.Tx) (map[string][]MetricPoint, error) {
	rows, err := tx.Query(s.bind(`SELECT name, tier, ts, value, max, samples FROM metric_points ORDER BY name, tier, ts`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]MetricPoint)
	for rows.Next() {
		var name string
		var tier string
		var point MetricPoint
		if err := rows.Scan(&name, &tier, &point.TS, &point.Value, &point.Max, &point.Samples); err != nil {
			return nil, err
		}
		point.Tier = metricTierFromSQL(tier)
		if point.Tier == MetricTierRaw {
			point.Max = 0
			point.Samples = 0
		}
		out[name] = append(out[name], point)
	}
	return out, rows.Err()
}

func exportEvents(s *SQLite, tx *sql.Tx) ([]HistoryEvent, error) {
	rows, err := tx.Query(s.bind(`SELECT seq, ts_ns, category, kind, entity, state, previous_state, severity, attributes_json FROM history_events ORDER BY seq`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []HistoryEvent
	for rows.Next() {
		var item HistoryEvent
		var tsNS int64
		var attributes string
		if err := rows.Scan(&item.ID, &tsNS, &item.Category, &item.Kind, &item.Entity, &item.State, &item.PreviousState, &item.Severity, &attributes); err != nil {
			return nil, err
		}
		item.TS = time.Unix(0, tsNS).UTC()
		item.ID = 0
		if attributes != "" && attributes != "null" {
			if err := json.Unmarshal([]byte(attributes), &item.Attributes); err != nil {
				return nil, err
			}
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
