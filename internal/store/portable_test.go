package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
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
				history, err := Open(OpenOptions{Driver: "sqlite", Path: filepath.Join(t.TempDir(), "panel.db")})
				if err != nil {
					t.Fatal(err)
				}
				state, err := NewState(filepath.Join(t.TempDir(), "panel-state.json"))
				if err != nil {
					_ = history.Close()
					t.Fatal(err)
				}
				combined, err := NewComposite(state, history)
				if err != nil {
					_ = history.Close()
					_ = state.Close()
					t.Fatal(err)
				}
				return combined
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

func TestPortableJSONMemoryPreservesNilAndEmptyMetricSeries(t *testing.T) {
	st, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.ImportData(PortableData{
		FormatVersion: portableFormatVersion,
		Metrics: map[string][]MetricPoint{
			"nil-series":   nil,
			"empty-series": {},
		},
	}); err != nil {
		t.Fatal(err)
	}
	var raw bytes.Buffer
	if err := st.ExportJSON(&raw); err != nil {
		t.Fatal(err)
	}
	var got PortableData
	if err := json.Unmarshal(raw.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Metrics["nil-series"] != nil {
		t.Fatalf("nil metric series became %#v", got.Metrics["nil-series"])
	}
	if got.Metrics["empty-series"] == nil {
		t.Fatal("empty metric series became nil")
	}
}

func TestPortableAcceptsOnlyFormatSeven(t *testing.T) {
	for _, version := range []int{0, 1, 2, 3, 4, 5, 6, 8} {
		t.Run(fmt.Sprintf("version_%d", version), func(t *testing.T) {
			_, err := normalizePortableData(PortableData{FormatVersion: version})
			want := fmt.Sprintf("unsupported store export format version %d (supported: 7)", version)
			if err == nil || err.Error() != want {
				t.Fatalf("normalizePortableData version %d error = %v, want %q", version, err, want)
			}
		})
	}
}

func TestPortableFormatSevenExportOmitsLegacyChallenges(t *testing.T) {
	st, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	flowHash := fmt.Sprintf("%x", sha256.Sum256([]byte("portable-flow")))
	if err := st.PutWebAuthnChallenge(WebAuthnChallenge{
		FlowHash: flowHash, Kind: "login", SessionData: []byte(`{"challenge":"one"}`),
		Origin: "https://panel.example", RPID: "panel.example", Expires: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	var raw bytes.Buffer
	if err := st.ExportJSON(&raw); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw.Bytes(), []byte("webauthn_challenges")) {
		t.Fatalf("format-7 export contains process-local challenge field: %s", raw.Bytes())
	}
}

func TestPortableStateImportReportsFileFailure(t *testing.T) {
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
		t.Fatal("ImportData hid a state-file write failure")
	}
	if _, ok, err := st.GetSetting("must-persist"); err != nil || ok {
		t.Fatalf("failed import mutated memory state: ok=%v err=%v", ok, err)
	}
}

func TestPortableMemoryImportRefusesVolatileHistory(t *testing.T) {
	st, err := NewState(filepath.Join(t.TempDir(), "panel-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	data := PortableData{
		FormatVersion: portableFormatVersion,
		Policies:      DefaultStoragePolicies(),
		Events:        []HistoryEvent{{Category: StorageEvents, Kind: "would-be-lost"}},
	}
	if err := st.ImportData(data); err == nil {
		t.Fatal("ImportData accepted history that the state file cannot persist")
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
	handle := make([]byte, webAuthnUserHandleBytes)
	for i := range handle {
		handle[i] = byte(i + 1)
	}
	if _, err := st.GetOrCreateWebAuthnUserHandle(handle); err != nil {
		t.Fatalf("populate WebAuthn user handle: %v", err)
	}
	credentialID := base64.RawURLEncoding.EncodeToString([]byte("portable-credential"))
	if err := st.AddWebAuthnCredential(WebAuthnCredential{
		ID: credentialID, Name: "Portable key", CredentialData: []byte(`{"id":"portable"}`),
		SignCount: 7, Created: now, LastUsed: now.Add(time.Minute),
	}); err != nil {
		t.Fatalf("populate WebAuthn credential: %v", err)
	}
	flowHash := fmt.Sprintf("%x", sha256.Sum256([]byte("portable-flow")))
	if err := st.PutWebAuthnChallenge(WebAuthnChallenge{
		FlowHash: flowHash, Kind: "register", SessionData: []byte(`{"challenge":"portable"}`),
		Origin: "https://panel.example", RPID: "panel.example", Expires: now.Add(time.Hour),
	}); err != nil {
		t.Fatalf("populate WebAuthn challenge: %v", err)
	}
}
