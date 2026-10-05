//go:build !lite

package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"testing"
	"time"
)

type interleavedExportWriter struct {
	bytes.Buffer
	trigger func() error
	done    bool
}

func (w *interleavedExportWriter) Write(p []byte) (int, error) {
	if !w.done && bytes.Contains(p, []byte(`"Value":42`)) {
		w.done = true
		if err := w.trigger(); err != nil {
			return 0, err
		}
	}
	return w.Buffer.Write(p)
}

func TestReadOnlyExportUsesOneWALSnapshotDuringWriterCommits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	writer, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	batch := make([]NamedMetricPoint, 256)
	for i := range batch {
		batch[i] = NamedMetricPoint{Name: fmt.Sprintf("traffic.%03d", i), Point: MetricPoint{TS: time.Now().Unix(), Value: 42}}
	}
	if err := writer.RecordMetrics(batch); err != nil {
		t.Fatal(err)
	}
	if err := writer.flushMetrics(); err != nil {
		t.Fatal(err)
	}
	if err := writer.AppendHistoryEvent(HistoryEvent{TS: time.Now(), Category: StorageEvents, Kind: "before", Entity: "test", Severity: "info"}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := OpenReadOnlyTransfer("", OpenOptions{Driver: "sqlite", Path: path})
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	output := &interleavedExportWriter{trigger: func() error {
		if err := writer.RecordMetric("new", MetricPoint{TS: time.Now().Unix(), Value: 99}); err != nil {
			return err
		}
		if err := writer.flushMetrics(); err != nil {
			return err
		}
		return writer.AppendHistoryEvent(HistoryEvent{TS: time.Now(), Category: StorageEvents, Kind: "after", Entity: "test", Severity: "info"})
	}}
	if err := snapshot.ExportJSON(output); err != nil {
		t.Fatal(err)
	}
	if !output.done {
		t.Fatal("writer did not interleave after first metric was read")
	}
	var data PortableData
	if err := json.Unmarshal(output.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Events) != 1 || data.Events[0].Kind != "before" || len(data.Metrics["new"]) != 0 {
		t.Fatalf("export mixed committed snapshots: metrics=%+v events=%+v", data.Metrics, data.Events)
	}
}

func TestReadOnlySQLiteRejectsWritesAndDoesNotMigrateBaseline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	writer, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.db.Exec(`PRAGMA user_version=11`); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	history, err := openReadOnlySQLite(path, DefaultStoragePolicies())
	if err != nil {
		t.Fatal(err)
	}
	reader := history.(*SQLite)
	defer reader.Close()
	if _, err := reader.db.Exec(`CREATE TABLE export_must_not_write(id INTEGER)`); err == nil {
		t.Fatal("readonly SQLite connection accepted a write")
	}
	if err := reader.ExportJSON(io.Discard); err != nil {
		t.Fatal(err)
	}
	var version int
	if err := reader.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != 11 {
		t.Fatalf("readonly export migrated schema=%d error=%v", version, err)
	}
}
