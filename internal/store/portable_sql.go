//go:build !lite

package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/amirotin/telemt_panel/internal/store/sqlstore"
)

// ExportData returns only observability history. Control-plane state is
// exported by Composite from panel-state.json.
func (s *SQLite) ExportData() (PortableData, error) {
	if err := s.flushMetrics(); err != nil {
		return PortableData{}, err
	}
	cutoff := time.Now().Unix() - int64(s.UserIPRetention()/time.Second)
	data := PortableData{FormatVersion: portableFormatVersion, Metrics: make(map[string][]MetricPoint), UserIPs: []UserIPRecord{}}
	err := sqlstore.WithTx(context.Background(), s.db, &sql.TxOptions{ReadOnly: true}, func(tx *sql.Tx) error {
		if err := walkPortableMetrics(s, tx, func(name string, point MetricPoint) error {
			data.Metrics[name] = append(data.Metrics[name], point)
			return nil
		}); err != nil {
			return err
		}
		if err := walkPortableEvents(s, tx, func(event HistoryEvent) error {
			data.Events = append(data.Events, event)
			return nil
		}); err != nil {
			return err
		}
		if err := walkPortableUserTrafficUsers(s, tx, func(item PortableUserTrafficUser) error {
			data.UserTraffic = append(data.UserTraffic, item)
			return nil
		}); err != nil {
			return err
		}
		if err := walkPortableUserTrafficBuckets(s, tx, func(item PortableUserTrafficBucket) error {
			data.UserTrafficBuckets = append(data.UserTrafficBuckets, item)
			return nil
		}); err != nil {
			return err
		}
		collector, err := readPortableUserTrafficCollector(s, tx)
		if err != nil {
			return err
		}
		data.UserTrafficCollector = collector
		collection, err := readPortableUserIPCollection(tx)
		if err != nil {
			return err
		}
		data.UserIPCollection = collection
		return walkPortableUserIPs(tx, cutoff, func(item UserIPRecord) error {
			data.UserIPs = append(data.UserIPs, item)
			return nil
		})
	})
	if err != nil {
		return PortableData{}, fmt.Errorf("export sqlite history: %w", err)
	}
	return data, nil
}

// ExportJSON streams one internally consistent SQLite history snapshot.
func (s *SQLite) ExportJSON(w io.Writer) error {
	state := PortableData{
		FormatVersion: portableFormatVersion,
		Sessions:      make(map[string]Session), SubpageNonces: make(map[string]string),
		Settings: make(map[string]string), Journal: make(map[string][]UpdateJournalEntry),
	}
	return s.exportJSON(w, state)
}

func (s *SQLite) exportJSON(out io.Writer, state PortableData) error {
	if err := s.flushMetrics(); err != nil {
		return err
	}
	cutoff := time.Now().Unix() - int64(s.UserIPRetention()/time.Second)
	w := newPortableJSONWriter(out)
	w.header(state)
	err := sqlstore.WithTx(context.Background(), s.db, &sql.TxOptions{ReadOnly: true}, func(tx *sql.Tx) error {
		if err := streamPortableSQLHistory(s, tx, cutoff, w); err != nil {
			return err
		}
		return w.finish()
	})
	if err != nil {
		return fmt.Errorf("export sqlite history: %w", err)
	}
	return nil
}

// ImportData fills a fresh history database. State fields in a combined
// backup are deliberately ignored here and restored by Composite instead.
func (s *SQLite) ImportData(data PortableData) error {
	data, err := normalizePortableData(data)
	if err != nil {
		return err
	}
	if err := s.flushMetrics(); err != nil {
		return err
	}
	err = sqlstore.WithTx(context.Background(), s.db, nil, func(tx *sql.Tx) error {
		empty, err := portableSQLiteHistoryEmpty(tx)
		if err != nil {
			return fmt.Errorf("inspect history destination: %w", err)
		}
		if !empty {
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
				if _, err := tx.Exec(`INSERT INTO metric_points(name, category, tier, ts, value, max, samples, last_ts, min_value, first_ts, first_value, delta, observed_seconds, gaps) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, name, metricCategory(name), tier, point.TS, point.Value, maxValue, samples, lastTS, point.Min, point.FirstTS, point.FirstValue, point.Delta, point.ObservedSeconds, point.Gaps); err != nil {
					return fmt.Errorf("import metric point: %w", err)
				}
			}
		}
		for _, event := range data.Events {
			attributes, err := json.Marshal(event.Attributes)
			if err != nil {
				return fmt.Errorf("encode imported history event attributes: %w", err)
			}
			if _, err := tx.Exec(`INSERT INTO history_events(ts_ns, category, kind, entity, state, previous_state, severity, attributes_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`, event.TS.UnixNano(), event.Category, event.Kind, event.Entity, event.State, event.PreviousState, event.Severity, string(attributes)); err != nil {
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
			result, err := tx.Exec(`INSERT INTO user_traffic_users
				(username, total_bytes, since_ts, updated_ts, month_key, month_bytes,
				 last_raw_octets, last_source_started_at, deleted_ts, continuity)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			if _, err := tx.Exec(`INSERT INTO user_traffic_buckets(user_id, tier, ts, bytes) VALUES(?, ?, ?, ?)`,
				userIDs[bucket.Username], portableUserTrafficTier(bucket.Tier), bucket.TS, bucket.Bytes); err != nil {
				return fmt.Errorf("import user traffic bucket: %w", err)
			}
		}
		if state := data.UserTrafficCollector; state != nil {
			if _, err := tx.Exec(`INSERT INTO user_traffic_collector(singleton, last_success_ts, source_started_at, source_state, continuity)
				VALUES (1, ?, ?, ?, ?)`, state.LastSuccessTS, state.SourceStartedAt, state.SourceState, state.Continuity); err != nil {
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

func walkPortableUserTrafficUsers(s *SQLite, tx *sql.Tx, emit func(PortableUserTrafficUser) error) (err error) {
	rows, err := tx.Query(`SELECT username, total_bytes, since_ts, updated_ts, month_key, month_bytes,
		last_raw_octets, last_source_started_at, deleted_ts, continuity FROM user_traffic_users ORDER BY username`)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	for rows.Next() {
		var item PortableUserTrafficUser
		var raw, source, deleted sql.NullInt64
		if err := rows.Scan(&item.Summary.Username, &item.Summary.ObservedTotalBytes,
			&item.Summary.ObservedSinceEpochSecs, &item.Summary.LastActivityEpochSecs,
			&item.Summary.MonthKey, &item.Summary.CurrentMonthBytes, &raw, &source,
			&deleted, &item.Summary.Continuity); err != nil {
			return err
		}
		if raw.Valid {
			rawValue := raw.Int64
			item.LastRawOctets = &rawValue
		}
		if source.Valid {
			sourceValue := source.Int64
			item.LastSourceStartedAt = &sourceValue
		}
		if deleted.Valid {
			item.Summary.DeletedEpochSecs = deleted.Int64
		}
		if err := emit(item); err != nil {
			return err
		}
	}
	return rows.Err()
}

func walkPortableUserTrafficBuckets(s *SQLite, tx *sql.Tx, emit func(PortableUserTrafficBucket) error) (err error) {
	rows, err := tx.Query(`SELECT users.username, buckets.tier, buckets.ts, buckets.bytes
		FROM user_traffic_buckets AS buckets JOIN user_traffic_users AS users ON users.id = buckets.user_id
		ORDER BY users.username, buckets.tier, buckets.ts`)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	for rows.Next() {
		var item PortableUserTrafficBucket
		var tier int
		if err := rows.Scan(&item.Username, &tier, &item.TS, &item.Bytes); err != nil {
			return err
		}
		item.Tier = userTrafficMetricTier(tier)
		if err := emit(item); err != nil {
			return err
		}
	}
	return rows.Err()
}

func readPortableUserTrafficCollector(s *SQLite, tx *sql.Tx) (*UserTrafficCollectorState, error) {
	var state UserTrafficCollectorState
	err := tx.QueryRow(`SELECT last_success_ts, source_started_at, source_state, continuity
		FROM user_traffic_collector WHERE singleton = 1`).Scan(
		&state.LastSuccessTS, &state.SourceStartedAt, &state.SourceState, &state.Continuity)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &state, nil
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

func walkPortableMetrics(s *SQLite, tx *sql.Tx, emit func(string, MetricPoint) error) (err error) {
	rows, err := tx.Query("SELECT name, " + metricPointColumns + " FROM metric_points ORDER BY name, tier, ts")
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	for rows.Next() {
		var name string
		var tier string
		var point MetricPoint
		if err := rows.Scan(&name, &tier, &point.TS, &point.Value, &point.Max, &point.Samples, &point.LastTS,
			&point.Min, &point.FirstTS, &point.FirstValue, &point.Delta, &point.ObservedSeconds, &point.Gaps); err != nil {
			return err
		}
		point.Tier = metricTierFromSQL(tier)
		if point.Tier == MetricTierRaw {
			point = MetricPoint{TS: point.TS, Value: point.Value}
		}
		if err := emit(name, point); err != nil {
			return err
		}
	}
	return rows.Err()
}

func walkPortableEvents(s *SQLite, tx *sql.Tx, emit func(HistoryEvent) error) (err error) {
	rows, err := tx.Query(`SELECT seq, ts_ns, category, kind, entity, state, previous_state, severity, attributes_json FROM history_events ORDER BY seq`)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, rows.Close()) }()
	for rows.Next() {
		var item HistoryEvent
		var tsNS int64
		var attributes string
		if err := rows.Scan(&item.ID, &tsNS, &item.Category, &item.Kind, &item.Entity, &item.State, &item.PreviousState, &item.Severity, &attributes); err != nil {
			return err
		}
		item.TS = time.Unix(0, tsNS).UTC()
		item.ID = 0
		if attributes != "" && attributes != "null" {
			if err := json.Unmarshal([]byte(attributes), &item.Attributes); err != nil {
				return err
			}
		}
		if err := emit(item); err != nil {
			return err
		}
	}
	return rows.Err()
}

func streamPortableSQLHistory(s *SQLite, tx *sql.Tx, cutoff int64, w *portableJSONWriter) error {
	var orphan bool
	if err := tx.QueryRow(`SELECT EXISTS(
		SELECT 1 FROM user_traffic_buckets AS buckets
		LEFT JOIN user_traffic_users AS users ON users.id = buckets.user_id
		WHERE users.id IS NULL LIMIT 1)`).Scan(&orphan); err != nil {
		return err
	}
	if orphan {
		return errors.New("portable user traffic contains an orphan bucket")
	}

	metricsStarted := false
	firstMetricName := true
	firstMetricPoint := true
	currentMetric := ""
	var previousTier MetricTier
	var previousTS int64
	if err := walkPortableMetrics(s, tx, func(name string, point MetricPoint) error {
		if err := validatePortableMetric(name, point); err != nil {
			return err
		}
		if name == currentMetric && point.Tier == previousTier && point.TS == previousTS {
			return fmt.Errorf("duplicate portable metric point %q", name)
		}
		if !metricsStarted {
			metricsStarted = true
			firstMetricName = w.beginObject("metrics")
		}
		if name != currentMetric {
			if currentMetric != "" {
				w.raw("]")
			}
			w.objectKey(&firstMetricName, name)
			w.raw("[")
			currentMetric = name
			firstMetricPoint = true
		}
		w.element(&firstMetricPoint, point)
		previousTier, previousTS = point.Tier, point.TS
		return w.err
	}); err != nil {
		return err
	}
	if metricsStarted {
		w.raw("]}")
	}

	eventsStarted := false
	firstEvent := true
	if err := walkPortableEvents(s, tx, func(event HistoryEvent) error {
		if err := normalizePortableEvent(&event); err != nil {
			return err
		}
		if !eventsStarted {
			eventsStarted = true
			firstEvent = w.beginArray("events")
		}
		w.element(&firstEvent, event)
		return w.err
	}); err != nil {
		return err
	}
	if eventsStarted {
		w.raw("]")
	}

	usersStarted := false
	firstUser := true
	previousUser := ""
	if err := walkPortableUserTrafficUsers(s, tx, func(item PortableUserTrafficUser) error {
		if err := validatePortableUserTrafficUser(item); err != nil {
			return err
		}
		if item.Summary.Username == previousUser {
			return fmt.Errorf("duplicate portable user traffic entry %q", previousUser)
		}
		previousUser = item.Summary.Username
		if !usersStarted {
			usersStarted = true
			firstUser = w.beginArray("user_traffic")
		}
		w.element(&firstUser, item)
		return w.err
	}); err != nil {
		return err
	}
	if usersStarted {
		w.raw("]")
	}

	bucketsStarted := false
	firstBucket := true
	if err := walkPortableUserTrafficBuckets(s, tx, func(item PortableUserTrafficBucket) error {
		if err := validatePortableUserTrafficBucket(item); err != nil {
			return err
		}
		if !bucketsStarted {
			bucketsStarted = true
			firstBucket = w.beginArray("user_traffic_buckets")
		}
		w.element(&firstBucket, item)
		return w.err
	}); err != nil {
		return err
	}
	if bucketsStarted {
		w.raw("]")
	}

	collector, err := readPortableUserTrafficCollector(s, tx)
	if err != nil {
		return err
	}
	if collector != nil {
		if err := validatePortableUserTrafficCollector(*collector); err != nil {
			return err
		}
		w.field("user_traffic_collector", collector)
	}

	collection, err := readPortableUserIPCollection(tx)
	if err != nil {
		return err
	}
	if collection != nil {
		if err := validatePortableUserIPCollection(*collection); err != nil {
			return err
		}
	}
	ipsStarted := false
	firstIP := true
	totalIPs, perUser := 0, 0
	previousIPUser, previousIP := "", ""
	if err := walkPortableUserIPs(tx, cutoff, func(item UserIPRecord) error {
		if err := validatePortableUserIPRecord(item, collection); err != nil {
			return err
		}
		totalIPs++
		if item.Username != previousIPUser {
			previousIPUser, previousIP, perUser = item.Username, "", 0
		}
		perUser++
		if totalIPs > UserIPSQLiteLimit || perUser > UserIPPerUserLimit || item.IP == previousIP {
			return errors.New("duplicate or excessive imported user IP records")
		}
		previousIP = item.IP
		if !ipsStarted {
			ipsStarted = true
			firstIP = w.beginArray("user_ip_history")
		}
		w.element(&firstIP, item)
		return w.err
	}); err != nil {
		return err
	}
	if ipsStarted {
		w.raw("]")
	}
	if collection != nil {
		w.field("user_ip_collection", collection)
	}
	return w.err
}

func (s *SQLite) portableHistoryEmpty() (bool, error) {
	if err := s.flushMetrics(); err != nil {
		return false, err
	}
	var empty bool
	err := sqlstore.WithTx(context.Background(), s.db, &sql.TxOptions{ReadOnly: true}, func(tx *sql.Tx) error {
		var err error
		empty, err = portableSQLiteHistoryEmpty(tx)
		return err
	})
	return empty, err
}

func portableSQLiteHistoryEmpty(tx *sql.Tx) (bool, error) {
	for _, table := range []string{
		"metric_points", "user_ip_history", "user_ip_history_collection", "history_events",
		"user_traffic_users", "user_traffic_buckets", "user_traffic_collector",
	} {
		var exists bool
		if err := tx.QueryRow("SELECT EXISTS(SELECT 1 FROM " + table + " LIMIT 1)").Scan(&exists); err != nil {
			return false, err
		}
		if exists {
			return false, nil
		}
	}
	return true, nil
}
