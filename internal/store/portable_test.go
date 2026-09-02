package store

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestPortableRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		open func(t *testing.T) Store
	}{
		{
			name: "memory",
			open: func(t *testing.T) Store {
				st, err := NewMemory("")
				if err != nil {
					t.Fatal(err)
				}
				return st
			},
		},
	}
	if Variant != "lite" {
		tests = append(tests, struct {
			name string
			open func(t *testing.T) Store
		}{
			name: "sqlite",
			open: func(t *testing.T) Store {
				st, err := Open(OpenOptions{Driver: "sqlite", Path: filepath.Join(t.TempDir(), "panel.db")})
				if err != nil {
					t.Fatal(err)
				}
				return st
			},
		})
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			source := test.open(t)
			defer source.Close()
			populatePortableStore(t, source)
			exported, err := source.(PortableStore).ExportData()
			if err != nil {
				t.Fatalf("ExportData: %v", err)
			}

			destination := test.open(t)
			defer destination.Close()
			if err := destination.(PortableStore).ImportData(exported); err != nil {
				t.Fatalf("ImportData: %v", err)
			}
			got, err := destination.(PortableStore).ExportData()
			if err != nil {
				t.Fatalf("destination ExportData: %v", err)
			}
			if !reflect.DeepEqual(got, exported) {
				t.Fatalf("round trip mismatch\n got: %#v\nwant: %#v", got, exported)
			}
			if err := destination.(PortableStore).ImportData(exported); !errors.Is(err, ErrStoreNotEmpty) {
				t.Fatalf("second ImportData error = %v, want ErrStoreNotEmpty", err)
			}
		})
	}
}

func TestPortableExportIsDetached(t *testing.T) {
	st, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	populatePortableStore(t, st)
	data, err := st.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	data.Settings["theme"] = "mutated"
	got, ok, err := st.GetSetting("theme")
	if err != nil || !ok || got != "dark" {
		t.Fatalf("store was mutated through export: value=%q ok=%v err=%v", got, ok, err)
	}
}

func TestPortableRejectsUnknownFormat(t *testing.T) {
	st, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.ImportData(PortableData{FormatVersion: portableFormatVersion + 1}); err == nil {
		t.Fatal("ImportData accepted a future format version")
	}
}

func TestPortableMemoryImportReportsMirrorFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	st, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	data := PortableData{
		FormatVersion: portableFormatVersion,
		Settings:      map[string]string{"must-persist": "value"},
		Policies:      DefaultStoragePolicies(),
	}
	if err := st.ImportData(data); err == nil {
		t.Fatal("ImportData hid a mirror write failure")
	}
	if _, ok, err := st.GetSetting("must-persist"); err != nil || ok {
		t.Fatalf("failed import mutated memory state: ok=%v err=%v", ok, err)
	}
}

func TestPortableMemoryImportRefusesVolatileHistory(t *testing.T) {
	st, err := NewMemory(filepath.Join(t.TempDir(), "panel-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	data := PortableData{
		FormatVersion: portableFormatVersion,
		Policies:      DefaultStoragePolicies(),
		Audit:         []AuditEntry{{ID: "would-be-lost"}},
	}
	if err := st.ImportData(data); err == nil {
		t.Fatal("ImportData accepted history that the memory mirror cannot persist")
	}
}

func TestPortableEventCountIsLimitedOnlyByMemoryDestination(t *testing.T) {
	events := make([]HistoryEvent, eventCap+1)
	for i := range events {
		events[i] = HistoryEvent{Category: StorageEvents, Kind: "test.changed", Entity: "test", State: "new", PreviousState: "old", Severity: "info"}
	}
	data := PortableData{FormatVersion: portableFormatVersion, Policies: DefaultStoragePolicies(), Events: events}
	if _, err := normalizePortableData(data); err != nil {
		t.Fatalf("driver-neutral export rejected durable event count: %v", err)
	}
	st, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.ImportData(data); err == nil {
		t.Fatal("memory import accepted more events than its bounded ring")
	}
}

func populatePortableStore(t *testing.T, st Store) {
	t.Helper()
	now := time.Unix(1_800_000_000, 123).UTC()
	checks := []error{
		st.PutSession(Session{IDHash: "session-hash", Created: now, LastSeen: now.Add(time.Minute), IP: "127.0.0.1", UserAgentLabel: "test", AuthMethod: "password"}),
		st.AppendAudit(AuditEntry{TS: now, ID: "audit-1", Action: "config.patch", Actor: "admin", Target: "telemt", Outcome: "success", IP: "127.0.0.1", Subject: "general", Detail: "changed"}),
		st.AppendUpdateJournal(UpdateJournalEntry{Target: "panel", RunID: "run-1", Phase: "complete", VersionFrom: "1.0", VersionTo: "1.1", TS: now, Detail: "ok"}),
		st.SetSubpageNonce("alice", "nonce-1"),
		st.SetSetting("theme", "dark"),
		st.RecordMetric("connections", MetricPoint{TS: now.Unix(), Value: 42}),
		st.AppendHistoryEvent(HistoryEvent{TS: now, Category: StorageEvents, Kind: "route.mode.changed", Entity: "route", State: "fallback", PreviousState: "me", Severity: "warning"}),
	}
	for _, err := range checks {
		if err != nil {
			t.Fatalf("populate store: %v", err)
		}
	}
	recovery := make([][]byte, 10)
	for i := range recovery {
		hash := sha256.Sum256([]byte(fmt.Sprintf("portable-recovery-%d", i)))
		recovery[i] = append([]byte(nil), hash[:]...)
	}
	if err := st.BeginTOTPSetup("portable-secret", now.Add(time.Hour)); err != nil {
		t.Fatalf("populate TOTP setup: %v", err)
	}
	if err := st.EnableTOTP("portable-secret", now, recovery); err != nil {
		t.Fatalf("populate TOTP state: %v", err)
	}
}
