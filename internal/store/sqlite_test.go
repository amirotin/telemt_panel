//go:build !lite

package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newSQLite(t *testing.T) (*SQLite, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "panel.db")
	store, err := NewSQLite(path, "")
	if err != nil {
		t.Fatalf("NewSQLite: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store, path
}

func TestSQLiteRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	store, err := NewSQLite(path, "")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 2, 12, 0, 0, 123, time.UTC)
	session := Session{IDHash: "hash", Created: now, LastSeen: now.Add(time.Minute), IP: "127.0.0.1", UserAgentLabel: "browser", AuthMethod: "password"}
	if err := store.PutSession(session); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendAudit(AuditEntry{TS: now, ID: "audit-1", Action: "config.patch", Actor: "admin", Target: "telemt", Outcome: "ok"}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendUpdateJournal(UpdateJournalEntry{Target: "panel", RunID: "run-1", Phase: "ready", TS: now}); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordMetric("connections", MetricPoint{TS: now.Unix(), Value: 42}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSubpageNonce("alice", "nonce"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetSetting("example", "value"); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewSQLite(path, "")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if info := reopened.Info(); info.Schema != 2 {
		t.Fatalf("schema version = %d, want 2", info.Schema)
	}
	gotSession, ok, err := reopened.GetSession("hash")
	if err != nil || !ok || gotSession != session {
		t.Fatalf("GetSession = %+v, %v, %v", gotSession, ok, err)
	}
	if got, err := reopened.ListAudit(10); err != nil || len(got) != 1 || got[0].ID != "audit-1" {
		t.Fatalf("ListAudit = %+v, %v", got, err)
	}
	if got, err := reopened.ListUpdateJournal("panel", 10); err != nil || len(got) != 1 || got[0].RunID != "run-1" {
		t.Fatalf("ListUpdateJournal = %+v, %v", got, err)
	}
	if got, err := reopened.MetricRange("connections", 0); err != nil || len(got) != 1 || got[0].Value != 42 {
		t.Fatalf("MetricRange = %+v, %v", got, err)
	}
	if got, err := reopened.GetSubpageNonce("alice"); err != nil || got != "nonce" {
		t.Fatalf("GetSubpageNonce = %q, %v", got, err)
	}
	if got, ok, err := reopened.GetSetting("example"); err != nil || !ok || got != "value" {
		t.Fatalf("GetSetting = %q, %v, %v", got, ok, err)
	}
}

func TestSQLiteRejectsFutureSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	opened, err := NewSQLite(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := opened.db.Exec(`PRAGMA user_version = 999`); err != nil {
		t.Fatal(err)
	}
	if err := opened.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSQLite(path, ""); err == nil {
		t.Fatal("NewSQLite accepted a schema newer than this binary")
	}
}

func TestSQLitePoliciesControlWritesAndRetention(t *testing.T) {
	store, _ := newSQLite(t)
	policies, err := store.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		switch policies[i].Category {
		case StorageTechnical:
			policies[i].RetentionDays = 14
		case StorageAudit, StorageTraffic:
			policies[i].Enabled = false
		}
	}
	if err := store.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if got := store.MetricRetention("connections"); got != 14*24*time.Hour {
		t.Fatalf("technical retention = %v", got)
	}
	if got := store.MetricRetention("traffic"); got != 0 {
		t.Fatalf("disabled traffic retention = %v", got)
	}
	if err := store.AppendAudit(AuditEntry{TS: time.Now(), ID: "hidden"}); err != nil {
		t.Fatal(err)
	}
	if got, err := store.ListAudit(10); err != nil || len(got) != 0 {
		t.Fatalf("disabled audit persisted: %+v, %v", got, err)
	}
	if err := store.RecordMetric("traffic", MetricPoint{TS: time.Now().Unix(), Value: 10}); err != nil {
		t.Fatal(err)
	}
	if got, err := store.MetricRange("traffic", 0); err != nil || len(got) != 0 {
		t.Fatalf("disabled traffic persisted: %+v, %v", got, err)
	}
}

func TestSQLiteRejectsDisabledTechnicalHistory(t *testing.T) {
	store, _ := newSQLite(t)
	policies, _ := store.ListStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageTechnical {
			policies[i].Enabled = false
		}
	}
	if err := store.ReplaceStoragePolicies(policies); err == nil {
		t.Fatal("ReplaceStoragePolicies accepted disabled technical history")
	}
}

func TestSQLitePurgeIsIndependentFromPolicy(t *testing.T) {
	store, _ := newSQLite(t)
	now := time.Now().Unix()
	if err := store.RecordMetric("connections", MetricPoint{TS: now, Value: 1}); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordMetric("traffic", MetricPoint{TS: now, Value: 2}); err != nil {
		t.Fatal(err)
	}
	if err := store.PurgeHistory(StorageTraffic); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.MetricRange("traffic", 0); len(got) != 0 {
		t.Fatalf("traffic after purge = %+v", got)
	}
	if got, _ := store.MetricRange("connections", 0); len(got) != 1 {
		t.Fatalf("technical history affected by traffic purge: %+v", got)
	}
	if store.MetricRetention("traffic") == 0 {
		t.Fatal("purge unexpectedly disabled future traffic writes")
	}
}

func TestSQLiteImportsMemoryMirrorOnce(t *testing.T) {
	dir := t.TempDir()
	mirrorPath := filepath.Join(dir, "panel-state.json")
	memory, err := NewMemory(mirrorPath)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	if err := memory.PutSession(Session{IDHash: "from-memory", Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	if err := memory.SetSetting("migrated", "yes"); err != nil {
		t.Fatal(err)
	}
	if err := memory.Close(); err != nil {
		t.Fatal(err)
	}

	dbPath := filepath.Join(dir, "panel.db")
	store, err := NewSQLite(dbPath, mirrorPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.GetSession("from-memory"); err != nil || !ok {
		t.Fatalf("migrated session missing: ok=%v err=%v", ok, err)
	}
	if got, ok, err := store.GetSetting("migrated"); err != nil || !ok || got != "yes" {
		t.Fatalf("migrated setting = %q, %v, %v", got, ok, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	memory, err = NewMemory(mirrorPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := memory.PutSession(Session{IDHash: "late", Created: now, LastSeen: now}); err != nil {
		t.Fatal(err)
	}
	if err := memory.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewSQLite(dbPath, mirrorPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, ok, err := reopened.GetSession("late"); err != nil || ok {
		t.Fatalf("mirror imported twice: ok=%v err=%v", ok, err)
	}
}

func TestSQLiteRejectsCorruptDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	if err := os.WriteFile(path, []byte("not a sqlite database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSQLite(path, ""); err == nil {
		t.Fatal("NewSQLite accepted a corrupt database")
	}
}

func TestSQLitePreservesExistingDirectoryPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	store, err := NewSQLite(filepath.Join(dir, "panel.db"), "")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("existing directory permissions changed to %o", got)
	}
}

func TestSQLiteRejectsUnknownStoredPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel.db")
	store, err := NewSQLite(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO storage_policies(category, enabled, retention_days) VALUES ('future', 1, 7)`); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSQLite(path, ""); err == nil {
		t.Fatal("NewSQLite accepted an unknown stored policy")
	}
}
