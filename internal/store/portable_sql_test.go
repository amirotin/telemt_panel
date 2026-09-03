//go:build !lite

package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestPortableSQLImportRollsBackCompletely(t *testing.T) {
	st, err := NewSQLite(filepath.Join(t.TempDir(), "panel.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Unix(1_800_000_000, 0).UTC()
	data := PortableData{
		FormatVersion: portableFormatVersion,
		Metrics: map[string][]MetricPoint{
			"connections": {
				{TS: now.Unix(), Value: 1},
				{TS: now.Unix(), Value: 2},
			},
		},
	}
	if err := st.ImportData(data); err == nil {
		t.Fatal("ImportData accepted duplicate metric keys")
	}

	data.Metrics["connections"] = data.Metrics["connections"][:1]
	if err := st.ImportData(data); err != nil {
		t.Fatalf("valid import after rollback: %v", err)
	}
	if points, err := st.MetricRange("connections", 0); err != nil || len(points) != 1 || points[0].Value != 1 {
		t.Fatalf("metrics after import = %+v, %v", points, err)
	}
}

func TestRemoteStoreOperationContextHasDeadline(t *testing.T) {
	st := &SQLite{remote: true}
	ctx, cancel := st.operationContext()
	defer cancel()
	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("remote store operation has no deadline")
	}
	remaining := time.Until(deadline)
	if remaining <= 0 || remaining > sqlOperationTimeout {
		t.Fatalf("remote store deadline in %v, want (0, %v]", remaining, sqlOperationTimeout)
	}
}
