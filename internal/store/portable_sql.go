//go:build !lite

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

// ExportData returns only observability history. Control-plane state is
// exported by Composite from panel-state.json.
func (s *SQLite) ExportData() (PortableData, error) {
	if err := s.flushMetrics(); err != nil {
		return PortableData{}, err
	}
	data := PortableData{FormatVersion: portableFormatVersion, Metrics: make(map[string][]MetricPoint)}
	err := sqlstore.WithTx(context.Background(), s.db, &sql.TxOptions{ReadOnly: true}, func(tx *sql.Tx) error {
		var err error
		if data.Metrics, err = exportMetrics(s, tx); err != nil {
			return err
		}
		data.Events, err = exportEvents(s, tx)
		if err != nil {
			return err
		}
		data.UserTraffic, data.UserTrafficBuckets, data.UserTrafficCollector, err = exportUserTraffic(s, tx)
		if err != nil {
			return err
		}
		data.UserIPs, data.UserIPCollection, err = exportUserIPs(tx, time.Now().Unix()-int64(s.UserIPRetention()/time.Second))
		return err
	})
	if err != nil {
		return PortableData{}, fmt.Errorf("export sqlite history: %w", err)
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
			(SELECT count(*) FROM user_ip_history) +
			(SELECT count(*) FROM user_ip_history_collection) +
			(SELECT count(*) FROM history_events) +
			(SELECT count(*) FROM user_traffic_users) +
			(SELECT count(*) FROM user_traffic_buckets) +
			(SELECT count(*) FROM user_traffic_collector)`)).Scan(&count); err != nil {
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
				lastTS := point.LastTS
				if lastTS == 0 {
					lastTS = point.TS
				}
				if _, err := tx.Exec(s.bind(`INSERT INTO metric_points(name, category, tier, ts, value, max, samples, last_ts, min_value, first_ts, first_value, delta, observed_seconds, gaps) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), name, metricCategory(name), tier, point.TS, point.Value, maxValue, samples, lastTS, point.Min, point.FirstTS, point.FirstValue, point.Delta, point.ObservedSeconds, point.Gaps); err != nil {
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
		userIDs := make(map[string]int64, len(data.UserTraffic))
		for _, r := range data.UserIPs {
			if _, err := tx.Exec("INSERT INTO user_ip_history(username,ip,family,first_ts,last_ts,observations,last_active_ts,source) VALUES(?,?,?,?,?,?,?,?)", r.Username, r.IP, r.Family, r.First, r.Last, r.Observations, r.LastActive, r.Source); err != nil {
				return err
			}
		}
		if data.UserIPCollection != nil {
			if err := writeUserIPCollection(tx, *data.UserIPCollection); err != nil {
				return err
			}
		}
		for _, item := range data.UserTraffic {
			summary := item.Summary
			result, err := tx.Exec(s.bind(`INSERT INTO user_traffic_users
				(username, total_bytes, since_ts, updated_ts, month_key, month_bytes,
				 last_raw_octets, last_source_started_at, deleted_ts, continuity)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
				summary.Username, summary.ObservedTotalBytes, summary.ObservedSinceEpochSecs,
				summary.LastActivityEpochSecs, summary.MonthKey, summary.CurrentMonthBytes,
				item.LastRawOctets, item.LastSourceStartedAt, nullablePortableTimestamp(summary.DeletedEpochSecs), summary.Continuity)
			if err != nil {
				return fmt.Errorf("import user traffic summary: %w", err)
			}
			id, err := result.LastInsertId()
			if err != nil {
				return fmt.Errorf("read imported user traffic id: %w", err)
			}
			userIDs[summary.Username] = id
		}
		for _, bucket := range data.UserTrafficBuckets {
			if _, err := tx.Exec(s.bind(`INSERT INTO user_traffic_buckets(user_id, tier, ts, bytes) VALUES(?, ?, ?, ?)`),
				userIDs[bucket.Username], portableUserTrafficTier(bucket.Tier), bucket.TS, bucket.Bytes); err != nil {
				return fmt.Errorf("import user traffic bucket: %w", err)
			}
		}
		if state := data.UserTrafficCollector; state != nil {
			if _, err := tx.Exec(s.bind(`INSERT INTO user_traffic_collector(singleton, last_success_ts, source_started_at, source_state, continuity)
				VALUES (1, ?, ?, ?, ?)`), state.LastSuccessTS, state.SourceStartedAt, state.SourceState, state.Continuity); err != nil {
				return fmt.Errorf("import user traffic collector: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("import sqlite history: %w", err)
	}
	return nil
}

func (s *SQLite) rollbackImportedHistory() error {
	return sqlstore.WithTx(context.Background(), s.db, nil, func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM user_ip_history"); err != nil {
			return err
		}
		if _, err := tx.Exec("DELETE FROM user_ip_history_collection"); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM user_traffic_collector`); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM user_traffic_buckets`); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM user_traffic_users`); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM history_events`); err != nil {
			return err
		}
		_, err := tx.Exec(`DELETE FROM metric_points`)
		return err
	})
}

func exportUserTraffic(s *SQLite, tx *sql.Tx) ([]PortableUserTrafficUser, []PortableUserTrafficBucket, *UserTrafficCollectorState, error) {
	rows, err := tx.Query(s.bind(`SELECT username, total_bytes, since_ts, updated_ts, month_key, month_bytes,
		last_raw_octets, last_source_started_at, deleted_ts, continuity FROM user_traffic_users ORDER BY username`))
	if err != nil {
		return nil, nil, nil, err
	}
	var users []PortableUserTrafficUser
	for rows.Next() {
		var item PortableUserTrafficUser
		var raw, source, deleted sql.NullInt64
		if err := rows.Scan(&item.Summary.Username, &item.Summary.ObservedTotalBytes,
			&item.Summary.ObservedSinceEpochSecs, &item.Summary.LastActivityEpochSecs,
			&item.Summary.MonthKey, &item.Summary.CurrentMonthBytes, &raw, &source,
			&deleted, &item.Summary.Continuity); err != nil {
			rows.Close()
			return nil, nil, nil, err
		}
		if raw.Valid {
			rawValue, sourceValue := raw.Int64, source.Int64
			item.LastRawOctets, item.LastSourceStartedAt = &rawValue, &sourceValue
		}
		if deleted.Valid {
			item.Summary.DeletedEpochSecs = deleted.Int64
		}
		users = append(users, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, nil, nil, err
	}

	rows, err = tx.Query(s.bind(`SELECT users.username, buckets.tier, buckets.ts, buckets.bytes
		FROM user_traffic_buckets AS buckets JOIN user_traffic_users AS users ON users.id = buckets.user_id
		ORDER BY users.username, buckets.tier, buckets.ts`))
	if err != nil {
		return nil, nil, nil, err
	}
	var buckets []PortableUserTrafficBucket
	for rows.Next() {
		var item PortableUserTrafficBucket
		var tier int
		if err := rows.Scan(&item.Username, &tier, &item.TS, &item.Bytes); err != nil {
			rows.Close()
			return nil, nil, nil, err
		}
		item.Tier = userTrafficMetricTier(tier)
		buckets = append(buckets, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, nil, nil, err
	}

	var state UserTrafficCollectorState
	err = tx.QueryRow(s.bind(`SELECT last_success_ts, source_started_at, source_state, continuity
		FROM user_traffic_collector WHERE singleton = 1`)).Scan(
		&state.LastSuccessTS, &state.SourceStartedAt, &state.SourceState, &state.Continuity)
	if errors.Is(err, sql.ErrNoRows) {
		return users, buckets, nil, nil
	}
	if err != nil {
		return nil, nil, nil, err
	}
	return users, buckets, &state, nil
}

func nullablePortableTimestamp(value int64) any {
	if value == 0 {
		return nil
	}
	return value
}

func portableUserTrafficTier(tier MetricTier) int {
	switch tier {
	case MetricTierQuarter:
		return 0
	case MetricTierHour:
		return 1
	default:
		return 2
	}
}

func exportMetrics(s *SQLite, tx *sql.Tx) (map[string][]MetricPoint, error) {
	rows, err := tx.Query(s.bind("SELECT name, " + metricPointColumns + " FROM metric_points ORDER BY name, tier, ts"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]MetricPoint)
	for rows.Next() {
		var name string
		var tier string
		var point MetricPoint
		if err := rows.Scan(&name, &tier, &point.TS, &point.Value, &point.Max, &point.Samples, &point.LastTS,
			&point.Min, &point.FirstTS, &point.FirstValue, &point.Delta, &point.ObservedSeconds, &point.Gaps); err != nil {
			return nil, err
		}
		point.Tier = metricTierFromSQL(tier)
		if point.Tier == MetricTierRaw {
			point = MetricPoint{TS: point.TS, Value: point.Value}
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
