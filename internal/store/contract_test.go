package store

import (
	"fmt"
	"testing"
	"time"
)

type storeFactory func(*testing.T) Store

// runStoreContract is the single behavioral suite for every backend. Driver-
// specific tests cover SQL syntax and migrations; this suite protects the
// semantics consumed by auth, hub, journal and settings code.
func runStoreContract(t *testing.T, factory storeFactory) Store {
	t.Helper()
	st := factory(t)
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	prefix := fmt.Sprintf("contract-%d", time.Now().UnixNano())
	now := time.Now().UTC().Truncate(time.Second)

	t.Run("sessions", func(t *testing.T) {
		first := Session{IDHash: prefix + "-a", Created: now, LastSeen: now, IP: "127.0.0.1", UserAgentLabel: "test", AuthMethod: "password"}
		second := Session{IDHash: prefix + "-b", Created: now.Add(time.Second), LastSeen: now.Add(time.Second), IP: "::1", UserAgentLabel: "test-2", AuthMethod: "password"}
		if err := st.PutSession(first); err != nil {
			t.Fatal(err)
		}
		if err := st.PutSession(second); err != nil {
			t.Fatal(err)
		}
		if err := st.TouchSession(first.IDHash, now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		got, ok, err := st.GetSession(first.IDHash)
		if err != nil || !ok || !got.LastSeen.Equal(now.Add(time.Minute)) {
			t.Fatalf("GetSession = %+v, %v, %v", got, ok, err)
		}
		if err := st.DeleteOtherSessions(second.IDHash); err != nil {
			t.Fatal(err)
		}
		if _, ok, err := st.GetSession(first.IDHash); err != nil || ok {
			t.Fatalf("first session survived: ok=%v err=%v", ok, err)
		}
		if err := st.DeleteSession(second.IDHash); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("settings_and_nonce", func(t *testing.T) {
		if err := st.SetSetting(prefix, "one"); err != nil {
			t.Fatal(err)
		}
		if err := st.SetSetting(prefix, "two"); err != nil {
			t.Fatal(err)
		}
		if got, ok, err := st.GetSetting(prefix); err != nil || !ok || got != "two" {
			t.Fatalf("GetSetting = %q, %v, %v", got, ok, err)
		}
		if err := st.SetSubpageNonce(prefix, "nonce-1"); err != nil {
			t.Fatal(err)
		}
		if err := st.SetSubpageNonce(prefix, "nonce-2"); err != nil {
			t.Fatal(err)
		}
		if got, err := st.GetSubpageNonce(prefix); err != nil || got != "nonce-2" {
			t.Fatalf("GetSubpageNonce = %q, %v", got, err)
		}
	})

	t.Run("audit_and_journal", func(t *testing.T) {
		auditID := prefix + "-audit"
		if err := st.AppendAudit(AuditEntry{TS: now, ID: auditID, Action: "contract", Outcome: "success"}); err != nil {
			t.Fatal(err)
		}
		audit, err := st.ListAudit(1000)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, entry := range audit {
			found = found || entry.ID == auditID
		}
		if !found {
			t.Fatalf("audit entry %q not found", auditID)
		}

		target := prefix + "-panel"
		if err := st.AppendUpdateJournal(UpdateJournalEntry{Target: target, RunID: prefix, Phase: "checking", TS: now}); err != nil {
			t.Fatal(err)
		}
		journal, err := st.ListUpdateJournal(target, 10)
		if err != nil || len(journal) != 1 || journal[0].RunID != prefix {
			t.Fatalf("ListUpdateJournal = %+v, %v", journal, err)
		}
	})

	t.Run("history_events", func(t *testing.T) {
		entity := "dc:" + prefix
		event := HistoryEvent{
			TS: now, Category: StorageEvents, Kind: "dc.coverage.changed",
			Entity: entity, State: "66", PreviousState: "100", Severity: "warning",
			Attributes: map[string]string{"route": "media"},
		}
		if err := st.AppendHistoryEvent(event); err != nil {
			t.Fatal(err)
		}
		got, err := st.ListHistoryEvents(HistoryEventFilter{From: now.Add(-time.Second), Category: StorageEvents, Kind: event.Kind, Entity: entity, Limit: 1})
		if err != nil || len(got) != 1 {
			t.Fatalf("ListHistoryEvents = %+v, %v", got, err)
		}
		if got[0].ID <= 0 || got[0].State != "66" || got[0].PreviousState != "100" || got[0].Attributes["route"] != "media" {
			t.Fatalf("history event = %+v", got[0])
		}
	})

	t.Run("metrics_policies_and_stats", func(t *testing.T) {
		metric := "traffic"
		point := MetricPoint{TS: now.Unix(), Value: 42.5}
		if err := st.RecordMetric(metric, point); err != nil {
			t.Fatal(err)
		}
		points, err := st.MetricRange(metric, now.Add(-time.Minute).Unix())
		if err != nil || len(points) == 0 || points[len(points)-1] != point {
			t.Fatalf("MetricRange = %+v, %v", points, err)
		}
		if err := st.RecordMetrics([]NamedMetricPoint{
			{Name: "connections", Point: MetricPoint{TS: now.Unix(), Value: 3}},
			{Name: "active_users", Point: MetricPoint{TS: now.Unix(), Value: 2}},
		}); err != nil {
			t.Fatal(err)
		}
		if got, err := st.MetricRange("active_users", now.Add(-time.Minute).Unix()); err != nil || len(got) != 1 || got[0].Value != 2 {
			t.Fatalf("batched MetricRange = %+v, %v", got, err)
		}
		policies, err := st.ListStoragePolicies()
		if err != nil || len(policies) != len(DefaultStoragePolicies()) {
			t.Fatalf("ListStoragePolicies = %+v, %v", policies, err)
		}
		if err := st.ReplaceStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
		stats, err := st.StorageStats()
		if err != nil || stats.Driver != st.Driver() || len(stats.Categories) != len(policies) {
			t.Fatalf("StorageStats = %+v, %v", stats, err)
		}
		if err := st.PurgeHistory(StorageTraffic); err != nil {
			t.Fatal(err)
		}
		if points, err := st.MetricRange(metric, 0); err != nil || len(points) != 0 {
			t.Fatalf("MetricRange after purge = %+v, %v", points, err)
		}
	})

	t.Run("sparse_user_traffic", func(t *testing.T) {
		username := prefix + "-traffic"
		policies, err := st.ListStoragePolicies()
		if err != nil {
			t.Fatal(err)
		}
		for i := range policies {
			if policies[i].Category == StorageUserTraffic {
				policies[i].Enabled = true
			}
		}
		if err := st.ReplaceStoragePolicies(policies); err != nil {
			t.Fatal(err)
		}
		if err := st.RecordUserTraffic([]UserTrafficDelta{
			{Username: username, TS: now.Unix(), Bytes: 100},
			{Username: username, TS: now.Add(time.Minute).Unix(), Bytes: 50},
			{Username: username, TS: now.Add(2 * time.Minute).Unix(), Bytes: 0},
		}); err != nil {
			t.Fatal(err)
		}
		points, err := st.UserTrafficRange(username, now.Add(-time.Hour).Unix())
		if err != nil || len(points) != 1 || points[0].Tier != MetricTierQuarter || points[0].Value != 150 || points[0].Samples != 2 {
			t.Fatalf("UserTrafficRange = %+v, %v", points, err)
		}
		if st.UserTrafficRetention() <= 0 {
			t.Fatal("enabled user traffic retention is zero")
		}
		if err := st.DeleteUserHistory(username); err != nil {
			t.Fatal(err)
		}
		if points, err := st.UserTrafficRange(username, now.Add(-time.Hour).Unix()); err != nil || len(points) != 0 {
			t.Fatalf("history survived user deletion: %+v, %v", points, err)
		}
	})

	t.Run("portable_export", func(t *testing.T) {
		portable, ok := st.(PortableStore)
		if !ok {
			t.Fatalf("%s does not implement PortableStore", st.Driver())
		}
		data, err := portable.ExportData()
		if err != nil {
			t.Fatal(err)
		}
		if data.FormatVersion != portableFormatVersion || data.Settings[prefix] != "two" || data.SubpageNonces[prefix] != "nonce-2" {
			t.Fatalf("portable export omitted state: %+v", data)
		}
		if len(data.Journal[prefix+"-panel"]) != 1 {
			t.Fatalf("portable export journal = %+v", data.Journal[prefix+"-panel"])
		}
		if len(data.Events) != 1 || data.Events[0].Entity != "dc:"+prefix {
			t.Fatalf("portable export events = %+v", data.Events)
		}
	})
	return st
}

func TestMemoryStoreContract(t *testing.T) {
	runStoreContract(t, func(t *testing.T) Store {
		opened, err := NewMemory("")
		if err != nil {
			t.Fatal(err)
		}
		return opened
	})
}
