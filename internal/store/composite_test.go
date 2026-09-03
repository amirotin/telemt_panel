package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCompositeRoutesStateAndHistory(t *testing.T) {
	state, err := NewState("")
	if err != nil {
		t.Fatal(err)
	}
	history, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	combined, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	defer combined.Close()
	if combined.StateDurable() {
		t.Fatal("process-local state was reported as durable")
	}

	now := time.Now().UTC().Truncate(time.Second)
	if err := combined.PutSession(Session{IDHash: "session", Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := combined.AppendAudit(AuditEntry{ID: "audit", TS: now}); err != nil {
		t.Fatal(err)
	}
	if err := combined.RecordMetric("connections", MetricPoint{TS: now.Unix(), Value: 12}); err != nil {
		t.Fatal(err)
	}
	if err := combined.AppendHistoryEvent(HistoryEvent{TS: now, Category: StorageEvents, Kind: "runtime.changed"}); err != nil {
		t.Fatal(err)
	}

	if _, ok, err := state.GetSession("session"); err != nil || !ok {
		t.Fatalf("state session: ok=%v err=%v", ok, err)
	}
	if _, ok, err := history.GetSession("session"); err != nil || ok {
		t.Fatalf("session leaked into history store: ok=%v err=%v", ok, err)
	}
	if points, err := state.MetricRange("connections", 0); err != nil || len(points) != 0 {
		t.Fatalf("metric leaked into state store: %+v, %v", points, err)
	}
	if points, err := history.MetricRange("connections", 0); err != nil || len(points) != 1 {
		t.Fatalf("history metric: %+v, %v", points, err)
	}
	if entries, err := history.ListAudit(0); err != nil || len(entries) != 0 {
		t.Fatalf("audit leaked into history store: %+v, %v", entries, err)
	}
	if events, err := state.ListHistoryEvents(HistoryEventFilter{}); err != nil || len(events) != 0 {
		t.Fatalf("event leaked into state store: %+v, %v", events, err)
	}
	stats, err := combined.StorageStats()
	if err != nil {
		t.Fatal(err)
	}
	foundAudit := false
	for _, category := range stats.Categories {
		if category.Category == StorageAudit {
			foundAudit = true
			if category.Records != 1 {
				t.Fatalf("combined audit stats = %d, want 1", category.Records)
			}
		}
	}
	if !foundAudit {
		t.Fatal("combined storage stats omitted audit category")
	}
	if err := combined.PurgeHistory(StorageAudit); err != nil {
		t.Fatal(err)
	}
	if entries, err := state.ListAudit(0); err != nil || len(entries) != 0 {
		t.Fatalf("state audit after purge: %+v, %v", entries, err)
	}
	if points, err := history.MetricRange("connections", 0); err != nil || len(points) != 1 {
		t.Fatalf("audit purge affected history metric: %+v, %v", points, err)
	}
}

func TestCompositeReloadsPersistedPoliciesIntoHistory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	state, err := NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	history, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	combined, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	if !combined.StateDurable() {
		t.Fatal("file-backed state was reported as volatile")
	}
	policies, err := combined.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		if policies[i].Category == StorageUserTraffic {
			policies[i].Enabled = true
			policies[i].RetentionDays = 45
		}
	}
	if err := combined.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if err := combined.Close(); err != nil {
		t.Fatal(err)
	}

	reopenedState, err := NewState(path)
	if err != nil {
		t.Fatal(err)
	}
	reopenedHistory, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := NewComposite(reopenedState, reopenedHistory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	historyPolicies, err := reopenedHistory.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for _, policy := range historyPolicies {
		if policy.Category == StorageUserTraffic {
			if !policy.Enabled || policy.RetentionDays != 45 {
				t.Fatalf("history policy was not restored from state: %+v", policy)
			}
			return
		}
	}
	t.Fatal("user traffic policy missing")
}

type rejectingPolicyHistory struct {
	HistoryStore
	failNext bool
}

func (s *rejectingPolicyHistory) ApplyStoragePolicies(policies []StoragePolicy) error {
	if s.failNext {
		s.failNext = false
		if err := s.HistoryStore.ApplyStoragePolicies(policies); err != nil {
			return err
		}
		return errors.New("history policy failure")
	}
	return s.HistoryStore.ApplyStoragePolicies(policies)
}

func TestCompositeDoesNotPersistRejectedHistoryPolicies(t *testing.T) {
	state, err := NewState("")
	if err != nil {
		t.Fatal(err)
	}
	history, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	wrapper := &rejectingPolicyHistory{HistoryStore: history}
	combined, err := NewComposite(state, wrapper)
	if err != nil {
		t.Fatal(err)
	}
	defer combined.Close()
	policies, err := combined.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		if policies[i].Category == StorageEvents {
			policies[i].Enabled = false
		}
	}
	wrapper.failNext = true
	if err := combined.ReplaceStoragePolicies(policies); err == nil {
		t.Fatal("ReplaceStoragePolicies accepted policies rejected by history")
	}
	got, err := state.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for _, policy := range got {
		if policy.Category == StorageEvents && !policy.Enabled {
			t.Fatal("rejected history policy was persisted to state")
		}
	}
	historyPolicies, err := history.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for _, policy := range historyPolicies {
		if policy.Category == StorageEvents && !policy.Enabled {
			t.Fatal("history retained a partially applied rejected policy")
		}
	}
}

func TestCompositeRollsBackHistoryWhenStateImportFails(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "panel-state.json")
	state, err := NewState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	history, err := NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	combined, err := NewComposite(state, history)
	if err != nil {
		t.Fatal(err)
	}
	defer combined.Close()
	data := PortableData{
		FormatVersion: portableFormatVersion,
		Settings:      map[string]string{"theme": "dark"},
		Policies:      DefaultStoragePolicies(),
		Metrics: map[string][]MetricPoint{
			"connections": {{TS: time.Now().Unix(), Value: 12}},
		},
	}
	if err := combined.ImportData(data); err == nil {
		t.Fatal("ImportData hid a state-file write failure")
	}
	if points, err := history.MetricRange("connections", 0); err != nil || len(points) != 0 {
		t.Fatalf("history survived failed state import: %+v, %v", points, err)
	}
}
