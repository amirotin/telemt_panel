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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newMemory(t *testing.T) *Memory {
	t.Helper()
	m, err := NewMemory("")
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	return m
}

func TestMemoryUserTrafficBucketCap(t *testing.T) {
	m := newMemory(t)
	now := time.Now().Unix()
	for index := 0; index < userTrafficMemoryMaxBuckets+5; index++ {
		m.userTrafficBuckets[memoryUserTrafficBucketKey{
			username: fmt.Sprintf("user-%04d", index%2000),
			ts:       now - int64(index/2000)*900,
		}] = 1
	}
	pruneMemoryUserTrafficBuckets(m.userTrafficBuckets, now)
	if got := len(m.userTrafficBuckets); got != userTrafficMemoryMaxBuckets {
		t.Fatalf("bucket count = %d, want %d", got, userTrafficMemoryMaxBuckets)
	}
}

func TestSessionCRUD(t *testing.T) {
	m := newMemory(t)
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

	if _, ok, err := m.GetSession("missing"); err != nil || ok {
		t.Fatalf("GetSession(missing) = ok:%v err:%v, want ok:false err:nil", ok, err)
	}

	s := Session{IDHash: "a", Created: now, LastSeen: now, IP: "1.2.3.4", UserAgentLabel: "curl", AuthMethod: "password"}
	if err := m.PutSession(s); err != nil {
		t.Fatalf("PutSession: %v", err)
	}
	got, ok, err := m.GetSession("a")
	if err != nil || !ok {
		t.Fatalf("GetSession(a) = ok:%v err:%v, want ok:true err:nil", ok, err)
	}
	if got != s {
		t.Fatalf("GetSession(a) = %+v, want %+v", got, s)
	}

	// TouchSession on an existing session updates LastSeen.
	later := now.Add(time.Hour)
	if err := m.TouchSession("a", later); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	got, _, _ = m.GetSession("a")
	if !got.LastSeen.Equal(later) {
		t.Fatalf("LastSeen = %v, want %v", got.LastSeen, later)
	}

	// TouchSession on a missing session is not an error.
	if err := m.TouchSession("missing", later); err != nil {
		t.Fatalf("TouchSession(missing): %v", err)
	}

	// PutSession replaces an existing session with the same IDHash.
	s.IP = "5.6.7.8"
	if err := m.PutSession(s); err != nil {
		t.Fatalf("PutSession (replace): %v", err)
	}
	got, _, _ = m.GetSession("a")
	if got.IP != "5.6.7.8" {
		t.Fatalf("IP after replace = %q, want %q", got.IP, "5.6.7.8")
	}

	if err := m.DeleteSession("a"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, ok, _ := m.GetSession("a"); ok {
		t.Fatalf("GetSession(a) after delete: found, want not found")
	}

	// Deleting a missing session is not an error.
	if err := m.DeleteSession("a"); err != nil {
		t.Fatalf("DeleteSession(missing): %v", err)
	}
}

func TestListSessionsOrder(t *testing.T) {
	m := newMemory(t)
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i, hash := range []string{"oldest", "middle", "newest"} {
		s := Session{IDHash: hash, Created: base.Add(time.Duration(i) * time.Hour)}
		if err := m.PutSession(s); err != nil {
			t.Fatalf("PutSession(%s): %v", hash, err)
		}
	}

	got, err := m.ListSessions()
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	want := []string{"newest", "middle", "oldest"}
	if len(got) != len(want) {
		t.Fatalf("ListSessions len = %d, want %d", len(got), len(want))
	}
	for i, hash := range want {
		if got[i].IDHash != hash {
			t.Fatalf("ListSessions[%d].IDHash = %q, want %q", i, got[i].IDHash, hash)
		}
	}
}

func TestDeleteOtherSessions(t *testing.T) {
	m := newMemory(t)
	for _, hash := range []string{"keep", "a", "b", "c"} {
		if err := m.PutSession(Session{IDHash: hash, Created: time.Now()}); err != nil {
			t.Fatalf("PutSession(%s): %v", hash, err)
		}
	}

	if err := m.DeleteOtherSessions("keep"); err != nil {
		t.Fatalf("DeleteOtherSessions: %v", err)
	}

	got, err := m.ListSessions()
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(got) != 1 || got[0].IDHash != "keep" {
		t.Fatalf("ListSessions after DeleteOtherSessions = %+v, want only [keep]", got)
	}
}

func TestAuditCRUD(t *testing.T) {
	m := newMemory(t)
	ts := time.Now()
	entries := []AuditEntry{
		{TS: ts, Action: "login", Subject: "admin", Detail: "first"},
		{TS: ts.Add(time.Second), Action: "logout", Subject: "admin", Detail: "second"},
	}
	for _, e := range entries {
		if err := m.AppendAudit(e); err != nil {
			t.Fatalf("AppendAudit: %v", err)
		}
	}

	got, err := m.ListAudit(0)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(got) != 2 || got[0].Detail != "second" || got[1].Detail != "first" {
		t.Fatalf("ListAudit = %+v, want newest-first [second, first]", got)
	}

	got, err = m.ListAudit(1)
	if err != nil {
		t.Fatalf("ListAudit(1): %v", err)
	}
	if len(got) != 1 || got[0].Detail != "second" {
		t.Fatalf("ListAudit(1) = %+v, want [second]", got)
	}
}

func TestUpdateJournalCRUD(t *testing.T) {
	m := newMemory(t)
	ts := time.Now()
	if err := m.AppendUpdateJournal(UpdateJournalEntry{Target: "telemt", RunID: "r1", Phase: "download", TS: ts}); err != nil {
		t.Fatalf("AppendUpdateJournal: %v", err)
	}
	if err := m.AppendUpdateJournal(UpdateJournalEntry{Target: "telemt", RunID: "r1", Phase: "restart", TS: ts.Add(time.Second)}); err != nil {
		t.Fatalf("AppendUpdateJournal: %v", err)
	}
	// A different target must not interleave with "telemt"'s entries.
	if err := m.AppendUpdateJournal(UpdateJournalEntry{Target: "panel", RunID: "r2", Phase: "download", TS: ts}); err != nil {
		t.Fatalf("AppendUpdateJournal: %v", err)
	}

	got, err := m.ListUpdateJournal("telemt", 0)
	if err != nil {
		t.Fatalf("ListUpdateJournal: %v", err)
	}
	if len(got) != 2 || got[0].Phase != "restart" || got[1].Phase != "download" {
		t.Fatalf("ListUpdateJournal(telemt) = %+v, want newest-first [restart, download]", got)
	}

	got, err = m.ListUpdateJournal("panel", 0)
	if err != nil {
		t.Fatalf("ListUpdateJournal(panel): %v", err)
	}
	if len(got) != 1 || got[0].Phase != "download" {
		t.Fatalf("ListUpdateJournal(panel) = %+v, want [download]", got)
	}

	got, err = m.ListUpdateJournal("missing", 0)
	if err != nil || len(got) != 0 {
		t.Fatalf("ListUpdateJournal(missing) = %+v err:%v, want empty", got, err)
	}
}

func TestMetricsCRUD(t *testing.T) {
	m := newMemory(t)
	points := []MetricPoint{{TS: 100, Value: 1}, {TS: 200, Value: 2}, {TS: 300, Value: 3}}
	for _, p := range points {
		if err := m.RecordMetric("rx_bytes", p); err != nil {
			t.Fatalf("RecordMetric: %v", err)
		}
	}

	got, err := m.MetricRange("rx_bytes", 0)
	if err != nil {
		t.Fatalf("MetricRange: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("MetricRange len = %d, want 3", len(got))
	}
	for i, p := range points {
		if got[i] != p {
			t.Fatalf("MetricRange[%d] = %+v, want %+v", i, got[i], p)
		}
	}

	got, err = m.MetricRange("rx_bytes", 200)
	if err != nil {
		t.Fatalf("MetricRange(from 200): %v", err)
	}
	if len(got) != 2 || got[0].TS != 200 || got[1].TS != 300 {
		t.Fatalf("MetricRange(from 200) = %+v, want TS [200, 300]", got)
	}

	got, err = m.MetricRange("missing", 0)
	if err != nil || len(got) != 0 {
		t.Fatalf("MetricRange(missing) = %+v err:%v, want empty", got, err)
	}
}

func TestSubpageNonceCRUD(t *testing.T) {
	m := newMemory(t)
	nonce, err := m.GetSubpageNonce("alice")
	if err != nil || nonce != "" {
		t.Fatalf("GetSubpageNonce(unset) = %q err:%v, want \"\" nil", nonce, err)
	}

	if err := m.SetSubpageNonce("alice", "n1"); err != nil {
		t.Fatalf("SetSubpageNonce: %v", err)
	}
	nonce, err = m.GetSubpageNonce("alice")
	if err != nil || nonce != "n1" {
		t.Fatalf("GetSubpageNonce = %q err:%v, want \"n1\" nil", nonce, err)
	}

	// SetSubpageNonce overwrites the previous value.
	if err := m.SetSubpageNonce("alice", "n2"); err != nil {
		t.Fatalf("SetSubpageNonce (overwrite): %v", err)
	}
	nonce, _ = m.GetSubpageNonce("alice")
	if nonce != "n2" {
		t.Fatalf("GetSubpageNonce after overwrite = %q, want %q", nonce, "n2")
	}
}

func TestSettingCRUD(t *testing.T) {
	m := newMemory(t)
	v, ok, err := m.GetSetting("missing")
	if err != nil || ok || v != "" {
		t.Fatalf("GetSetting(missing) = %q ok:%v err:%v, want \"\" false nil", v, ok, err)
	}

	if err := m.SetSetting("theme", "dark"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	v, ok, err = m.GetSetting("theme")
	if err != nil || !ok || v != "dark" {
		t.Fatalf("GetSetting(theme) = %q ok:%v err:%v, want \"dark\" true nil", v, ok, err)
	}

	// SetSetting overwrites the previous value.
	if err := m.SetSetting("theme", "light"); err != nil {
		t.Fatalf("SetSetting (overwrite): %v", err)
	}
	v, _, _ = m.GetSetting("theme")
	if v != "light" {
		t.Fatalf("GetSetting after overwrite = %q, want %q", v, "light")
	}
}

// TestRingTruncation drives each bounded family past its cap and checks
// that it holds exactly cap entries afterward, and that those entries are
// the most-recently-inserted ones (oldest ones were dropped).
func TestRingTruncation(t *testing.T) {
	t.Run("audit", func(t *testing.T) {
		m := newMemory(t)
		total := auditCap + 10
		for i := 0; i < total; i++ {
			if err := m.AppendAudit(AuditEntry{Detail: fmt.Sprintf("%d", i)}); err != nil {
				t.Fatalf("AppendAudit(%d): %v", i, err)
			}
		}
		got, err := m.ListAudit(0)
		if err != nil {
			t.Fatalf("ListAudit: %v", err)
		}
		if len(got) != auditCap {
			t.Fatalf("len(ListAudit) = %d, want %d", len(got), auditCap)
		}
		// Newest first: index 0 is the last inserted (total-1), the ring
		// should have dropped the oldest 10 (i = 0..9).
		if got[0].Detail != fmt.Sprintf("%d", total-1) {
			t.Fatalf("newest entry Detail = %q, want %q", got[0].Detail, fmt.Sprintf("%d", total-1))
		}
		oldestSurvivor := got[len(got)-1].Detail
		if oldestSurvivor != fmt.Sprintf("%d", total-auditCap) {
			t.Fatalf("oldest surviving entry Detail = %q, want %q", oldestSurvivor, fmt.Sprintf("%d", total-auditCap))
		}
	})

	t.Run("update_journal", func(t *testing.T) {
		m := newMemory(t)
		total := journalCap + 10
		for i := 0; i < total; i++ {
			e := UpdateJournalEntry{Target: "telemt", Phase: fmt.Sprintf("%d", i)}
			if err := m.AppendUpdateJournal(e); err != nil {
				t.Fatalf("AppendUpdateJournal(%d): %v", i, err)
			}
		}
		got, err := m.ListUpdateJournal("telemt", 0)
		if err != nil {
			t.Fatalf("ListUpdateJournal: %v", err)
		}
		if len(got) != journalCap {
			t.Fatalf("len(ListUpdateJournal) = %d, want %d", len(got), journalCap)
		}
		if got[0].Phase != fmt.Sprintf("%d", total-1) {
			t.Fatalf("newest entry Phase = %q, want %q", got[0].Phase, fmt.Sprintf("%d", total-1))
		}
		oldestSurvivor := got[len(got)-1].Phase
		if oldestSurvivor != fmt.Sprintf("%d", total-journalCap) {
			t.Fatalf("oldest surviving entry Phase = %q, want %q", oldestSurvivor, fmt.Sprintf("%d", total-journalCap))
		}
	})

	t.Run("metrics", func(t *testing.T) {
		m := newMemory(t)
		total := MetricCap + 10
		for i := 0; i < total; i++ {
			if err := m.RecordMetric("rx_bytes", MetricPoint{TS: int64(i), Value: float64(i)}); err != nil {
				t.Fatalf("RecordMetric(%d): %v", i, err)
			}
		}
		got, err := m.MetricRange("rx_bytes", 0)
		if err != nil {
			t.Fatalf("MetricRange: %v", err)
		}
		if len(got) != MetricCap {
			t.Fatalf("len(MetricRange) = %d, want %d", len(got), MetricCap)
		}
		// Oldest first: index 0 is the oldest survivor (i = total-MetricCap).
		if got[0].TS != int64(total-MetricCap) {
			t.Fatalf("oldest surviving point TS = %d, want %d", got[0].TS, total-MetricCap)
		}
		if got[len(got)-1].TS != int64(total-1) {
			t.Fatalf("newest point TS = %d, want %d", got[len(got)-1].TS, total-1)
		}
	})

	// The cap is a POINT count, but what the dashboard depends on is the
	// TIME it buys: two consecutive 15-minute windows at the hub's default
	// 5s "stats" poll. Lowering MetricCap below that silently turns Сводка's
	// "−0,3 % за 15 мин" caption back into "no previous window".
	t.Run("metric cap spans two fifteen-minute windows", func(t *testing.T) {
		const defaultStatsPoll = 5 * time.Second
		if span := time.Duration(MetricCap) * defaultStatsPoll; span < 30*time.Minute {
			t.Fatalf("MetricCap = %d points = %s at a %s poll, want at least 30m", MetricCap, span, defaultStatsPoll)
		}
	})
}

func TestStateFileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")

	m1, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	s := Session{IDHash: "a", Created: time.Now().Truncate(time.Second), IP: "1.2.3.4"}
	if err := m1.PutSession(s); err != nil {
		t.Fatalf("PutSession: %v", err)
	}
	if err := m1.SetSubpageNonce("alice", "n1"); err != nil {
		t.Fatalf("SetSubpageNonce: %v", err)
	}
	if err := m1.SetSetting("theme", "dark"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	if err := m1.AppendUpdateJournal(UpdateJournalEntry{Target: "panel", RunID: "r1", Phase: "restarting", VersionFrom: "v1.0.0", VersionTo: "v2.0.0"}); err != nil {
		t.Fatalf("AppendUpdateJournal: %v", err)
	}
	// Metrics are explicitly excluded from the state file.
	if err := m1.RecordMetric("rx_bytes", MetricPoint{TS: 1, Value: 1}); err != nil {
		t.Fatalf("RecordMetric: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat state file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("state file perm = %o, want 0600", perm)
	}

	m2, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory (reopen): %v", err)
	}

	got, ok, err := m2.GetSession("a")
	if err != nil || !ok {
		t.Fatalf("GetSession(a) after reopen = ok:%v err:%v, want true nil", ok, err)
	}
	if got.IP != "1.2.3.4" {
		t.Fatalf("GetSession(a).IP after reopen = %q, want %q", got.IP, "1.2.3.4")
	}

	nonce, err := m2.GetSubpageNonce("alice")
	if err != nil || nonce != "n1" {
		t.Fatalf("GetSubpageNonce after reopen = %q err:%v, want \"n1\" nil", nonce, err)
	}

	setting, ok, err := m2.GetSetting("theme")
	if err != nil || !ok || setting != "dark" {
		t.Fatalf("GetSetting after reopen = %q ok:%v err:%v, want \"dark\" true nil", setting, ok, err)
	}

	journal, err := m2.ListUpdateJournal("panel", 0)
	if err != nil {
		t.Fatalf("ListUpdateJournal after reopen: %v", err)
	}
	if len(journal) != 1 || journal[0].RunID != "r1" || journal[0].Phase != "restarting" {
		t.Fatalf("ListUpdateJournal after reopen = %+v, want one restarting entry for r1", journal)
	}

	points, err := m2.MetricRange("rx_bytes", 0)
	if err != nil {
		t.Fatalf("MetricRange after reopen: %v", err)
	}
	if len(points) != 0 {
		t.Fatalf("MetricRange after reopen = %+v, want empty (metrics not persisted)", points)
	}
}

// TestStateFileJournalRingCapTruncationOnLoad checks that NewMemory defensively
// truncates a state-file journal that holds more than journalCap entries for a
// target — e.g. a file written by a future version with a larger cap, or
// hand-edited — rather than trusting the state file's own bound.
func TestStateFileJournalRingCapTruncationOnLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")

	total := journalCap + 10
	entries := make([]UpdateJournalEntry, total)
	for i := range entries {
		entries[i] = UpdateJournalEntry{Target: "telemt", Phase: fmt.Sprintf("%d", i)}
	}
	mf := stateFile{Journal: map[string][]UpdateJournalEntry{"telemt": entries}}
	data, err := json.Marshal(mf)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	got, err := m.ListUpdateJournal("telemt", 0)
	if err != nil {
		t.Fatalf("ListUpdateJournal: %v", err)
	}
	if len(got) != journalCap {
		t.Fatalf("len(ListUpdateJournal) = %d, want %d (oversized state-file journal must be truncated on load)", len(got), journalCap)
	}
	if got[0].Phase != fmt.Sprintf("%d", total-1) {
		t.Fatalf("newest entry Phase = %q, want %q", got[0].Phase, fmt.Sprintf("%d", total-1))
	}
	oldestSurvivor := got[len(got)-1].Phase
	if oldestSurvivor != fmt.Sprintf("%d", total-journalCap) {
		t.Fatalf("oldest surviving entry Phase = %q, want %q", oldestSurvivor, fmt.Sprintf("%d", total-journalCap))
	}
}

func TestStateFileDisabled(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatalf("NewMemory(\"\"): %v", err)
	}
	if err := m.PutSession(Session{IDHash: "a"}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}
	// No state-file path was given, so there's nothing further to assert here
	// beyond PutSession not erroring or panicking while trying to persist.
}

func TestStateFileMissingFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.json")

	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	sessions, err := m.ListSessions()
	if err != nil || len(sessions) != 0 {
		t.Fatalf("ListSessions on missing state file = %+v err:%v, want empty nil", sessions, err)
	}
}

func TestStateFileCorruptFileFailsClosed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, err := NewMemory(path); err == nil {
		t.Fatal("NewMemory accepted a corrupt persistent state file")
	}
}

func TestStateFileRejectsInvalidStoragePoliciesWithoutMutation(t *testing.T) {
	incomplete := DefaultStoragePolicies()
	incomplete = append(incomplete[:6:6], incomplete[7:]...)
	invalid := DefaultStoragePolicies()
	invalid[0].RetentionDays = 0
	for _, test := range []struct {
		name     string
		policies []StoragePolicy
	}{
		{name: "incomplete development set", policies: incomplete},
		{name: "invalid current set", policies: invalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "panel-state.json")
			raw, err := json.MarshalIndent(stateFile{Policies: test.policies}, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err = NewMemory(path)
			if err == nil || !strings.Contains(err.Error(), "state file contains invalid storage policies") {
				t.Fatalf("NewMemory error = %v, want explicit invalid-policy error", err)
			}
			after, readErr := os.ReadFile(path)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if !bytes.Equal(after, raw) {
				t.Fatal("invalid policy rejection rewrote the state file")
			}
		})
	}
}

func TestStateFileAbsentOrEmptyStoragePoliciesUseDefaults(t *testing.T) {
	for _, raw := range []string{`{}`, `{"storage_policies":[]}`} {
		t.Run(raw, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "panel-state.json")
			if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			state, err := NewMemory(path)
			if err != nil {
				t.Fatal(err)
			}
			defer state.Close()
			got, err := state.ListStoragePolicies()
			if err != nil {
				t.Fatal(err)
			}
			if want := DefaultStoragePolicies(); !reflect.DeepEqual(got, want) {
				t.Fatalf("default policies = %+v, want %+v", got, want)
			}
		})
	}
}

func TestStateFileCompleteCustomStoragePoliciesRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	want := DefaultStoragePolicies()
	for i := range want {
		want[i].RetentionDays = 11 + i
		if want[i].Category != StorageUserIPHistory {
			want[i].Enabled = i%2 == 0
		}
	}
	raw, err := json.Marshal(stateFile{Policies: want})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := state.SetSetting("policy-roundtrip", "preserved"); err != nil {
		state.Close()
		t.Fatal(err)
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	got, err := reopened.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round-tripped policies = %+v, want %+v", got, want)
	}
}

func TestStateMutationsRollbackWhenPersistenceFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	state, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := state.PutSession(Session{IDHash: "failed", Created: time.Now(), LastSeen: time.Now()}); err == nil {
		t.Fatal("PutSession hid a state-file write failure")
	}
	if session, ok, err := state.GetSession("failed"); err != nil || ok {
		t.Fatalf("failed session mutation survived: %+v, ok=%v err=%v", session, ok, err)
	}
	if err := state.SetSetting("theme", "dark"); err == nil {
		t.Fatal("SetSetting hid a state-file write failure")
	}
	if _, ok, err := state.GetSetting("theme"); err != nil || ok {
		t.Fatalf("failed setting mutation survived: ok=%v err=%v", ok, err)
	}
	if err := state.AppendAudit(AuditEntry{ID: "failed"}); err == nil {
		t.Fatal("AppendAudit hid a state-file write failure")
	}
	if entries, err := state.ListAudit(0); err != nil || len(entries) != 0 {
		t.Fatalf("failed audit mutation survived: %+v, %v", entries, err)
	}
	policies, err := state.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		if policies[i].Category == StorageTraffic {
			policies[i].Enabled = false
		}
	}
	if err := state.ReplaceStoragePolicies(policies); err == nil {
		t.Fatal("ReplaceStoragePolicies hid a state-file write failure")
	}
	current, err := state.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for _, policy := range current {
		if policy.Category == StorageTraffic && !policy.Enabled {
			t.Fatal("failed policy mutation survived")
		}
	}
}

func TestStateFilePersistsCredentialsButNotWebAuthnChallenges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	m, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	handle := make([]byte, webAuthnUserHandleBytes)
	for i := range handle {
		handle[i] = byte(i + 1)
	}
	if _, err := m.GetOrCreateWebAuthnUserHandle(handle); err != nil {
		t.Fatal(err)
	}
	id := base64.RawURLEncoding.EncodeToString([]byte("state-credential"))
	created := time.Now().UTC().Truncate(time.Second)
	if err := m.AddWebAuthnCredential(WebAuthnCredential{ID: id, Name: "Phone", CredentialData: []byte(`{"id":"phone"}`), Created: created}); err != nil {
		t.Fatal(err)
	}
	flowHash := fmt.Sprintf("%x", sha256.Sum256([]byte("state-flow")))
	if err := m.PutWebAuthnChallenge(WebAuthnChallenge{FlowHash: flowHash, Kind: "login", SessionData: []byte(`{"challenge":"one"}`), Origin: "https://panel.example", RPID: "panel.example", Expires: created.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	gotHandle, err := reopened.GetOrCreateWebAuthnUserHandle(make([]byte, webAuthnUserHandleBytes))
	if err != nil || string(gotHandle) != string(handle) {
		t.Fatalf("state-file handle = %x, %v", gotHandle, err)
	}
	credentials, err := reopened.ListWebAuthnCredentials()
	if err != nil || len(credentials) != 1 || credentials[0].ID != id || credentials[0].Name != "Phone" {
		t.Fatalf("state-file credentials = %+v, %v", credentials, err)
	}
	challenge, err := reopened.ConsumeWebAuthnChallenge(flowHash, "login", created)
	if !errors.Is(err, ErrWebAuthnChallenge) || challenge.FlowHash != "" {
		t.Fatalf("process-local challenge survived restart = %+v, %v", challenge, err)
	}
}

func TestStateFilePersistsBoundedAudit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "panel-state.json")
	state, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < auditCap+1; i++ {
		if err := state.AppendAudit(AuditEntry{ID: fmt.Sprintf("audit-%d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := reopened.ListAudit(0)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != auditCap || entries[0].ID != fmt.Sprintf("audit-%d", auditCap) || entries[len(entries)-1].ID != "audit-1" {
		t.Fatalf("persisted audit ring = first %q last %q len %d", entries[0].ID, entries[len(entries)-1].ID, len(entries))
	}
	if err := reopened.PurgeAudit(); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	afterPurge, err := NewMemory(path)
	if err != nil {
		t.Fatal(err)
	}
	defer afterPurge.Close()
	if entries, err := afterPurge.ListAudit(0); err != nil || len(entries) != 0 {
		t.Fatalf("persisted audit after purge = %+v, %v", entries, err)
	}
}

// fakeTimer is a test double for Memory.scheduleTimer: it records how many
// times it was armed and hands back the pending callback so tests can fire
// it deterministically instead of waiting on a real timer.
type fakeTimer struct {
	scheduled int
	pending   func()
}

func (f *fakeTimer) schedule(_ time.Duration, cb func()) func() {
	f.scheduled++
	f.pending = cb
	return func() { f.pending = nil }
}

func (f *fakeTimer) fire() {
	cb := f.pending
	f.pending = nil
	if cb != nil {
		cb()
	}
}

// readStateLastSeen reads path off disk and returns idHash's LastSeen, for
// asserting exactly when a touch became visible in the state file.
func readStateLastSeen(t *testing.T, path, idHash string) time.Time {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var mf stateFile
	if err := json.Unmarshal(data, &mf); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	s, ok := mf.Sessions[idHash]
	if !ok {
		t.Fatalf("session %q not in state file", idHash)
	}
	return s.LastSeen
}

// TestTouchDebounce drives a touch storm through an injected fake timer and
// checks that it coalesces into exactly one scheduled flush, that the
// state file is untouched until that flush fires, and that firing it writes the
// latest state.
func TestTouchDebounce(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")
	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}

	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := m.PutSession(Session{IDHash: "a", Created: base, LastSeen: base}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}
	if got := readStateLastSeen(t, path, "a"); !got.Equal(base) {
		t.Fatalf("initial state-file LastSeen = %v, want %v", got, base)
	}

	ft := &fakeTimer{}
	m.scheduleTimer = ft.schedule

	// Touch storm: several touches inside one debounce window must
	// coalesce into a single scheduled flush and must not write yet.
	for i := 1; i <= 5; i++ {
		at := base.Add(time.Duration(i) * time.Second)
		if err := m.TouchSession("a", at); err != nil {
			t.Fatalf("TouchSession(%d): %v", i, err)
		}
	}
	if ft.scheduled != 1 {
		t.Fatalf("scheduleTimer called %d times, want 1 (storm should coalesce)", ft.scheduled)
	}
	if got := readStateLastSeen(t, path, "a"); !got.Equal(base) {
		t.Fatalf("state-file LastSeen before flush = %v, want unchanged %v", got, base)
	}

	// Firing the debounce timer flushes the latest state once.
	ft.fire()
	wantLatest := base.Add(5 * time.Second)
	if got := readStateLastSeen(t, path, "a"); !got.Equal(wantLatest) {
		t.Fatalf("state-file LastSeen after flush = %v, want %v", got, wantLatest)
	}

	// A touch after the window flushed arms a new window.
	if err := m.TouchSession("a", base.Add(6*time.Second)); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	if ft.scheduled != 2 {
		t.Fatalf("scheduleTimer called %d times after new touch, want 2", ft.scheduled)
	}
}

// TestTouchDebounceImmediateFamiliesUnaffected checks that other mutation
// families still write through synchronously while a touch flush is
// pending, rather than waiting on the debounce window.
func TestTouchDebounceImmediateFamiliesUnaffected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")
	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	if err := m.PutSession(Session{IDHash: "a", Created: time.Now()}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	ft := &fakeTimer{}
	m.scheduleTimer = ft.schedule

	if err := m.TouchSession("a", time.Now()); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	if ft.scheduled != 1 {
		t.Fatalf("scheduleTimer called %d times, want 1", ft.scheduled)
	}

	if err := m.SetSetting("k", "v"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var mf stateFile
	if err := json.Unmarshal(data, &mf); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if mf.Settings["k"] != "v" {
		t.Fatalf("Settings[k] = %q, want %q (SetSetting must write through immediately)", mf.Settings["k"], "v")
	}
	// The pending touch flush must be untouched by the immediate write.
	if ft.scheduled != 1 {
		t.Fatalf("scheduleTimer called %d times after SetSetting, want still 1", ft.scheduled)
	}
}

// TestAppendUpdateJournalWritesThroughImmediately checks that, unlike
// TouchSession, AppendUpdateJournal is not subject to the touch debounce:
// it must be visible in the state file as soon as it returns, even while a
// touch flush is pending (update runs are rare — no flash-wear concern, so
// there is no reason to defer them).
func TestAppendUpdateJournalWritesThroughImmediately(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")
	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	if err := m.PutSession(Session{IDHash: "a", Created: time.Now()}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	ft := &fakeTimer{}
	m.scheduleTimer = ft.schedule
	if err := m.TouchSession("a", time.Now()); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	if ft.scheduled != 1 {
		t.Fatalf("scheduleTimer called %d times, want 1", ft.scheduled)
	}

	if err := m.AppendUpdateJournal(UpdateJournalEntry{Target: "panel", RunID: "r1", Phase: "restarting"}); err != nil {
		t.Fatalf("AppendUpdateJournal: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var mf stateFile
	if err := json.Unmarshal(data, &mf); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(mf.Journal["panel"]) != 1 || mf.Journal["panel"][0].RunID != "r1" {
		t.Fatalf("state-file Journal[panel] = %+v, want one entry for r1 (AppendUpdateJournal must write through immediately)", mf.Journal["panel"])
	}
	// The pending touch flush must be untouched by the immediate write.
	if ft.scheduled != 1 {
		t.Fatalf("scheduleTimer called %d times after AppendUpdateJournal, want still 1", ft.scheduled)
	}
}

// TestTouchDebounceFlushedOnClose checks that a pending touch flush is
// written synchronously by Close, without waiting for the timer to fire.
func TestTouchDebounceFlushedOnClose(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")
	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := m.PutSession(Session{IDHash: "a", Created: base, LastSeen: base}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	ft := &fakeTimer{}
	m.scheduleTimer = ft.schedule

	touched := base.Add(time.Minute)
	if err := m.TouchSession("a", touched); err != nil {
		t.Fatalf("TouchSession: %v", err)
	}
	if got := readStateLastSeen(t, path, "a"); !got.Equal(base) {
		t.Fatalf("state-file LastSeen before Close = %v, want unchanged %v", got, base)
	}

	if err := m.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := readStateLastSeen(t, path, "a"); !got.Equal(touched) {
		t.Fatalf("state-file LastSeen after Close = %v, want %v", got, touched)
	}
	if ft.pending != nil {
		t.Fatalf("Close left a pending timer callback armed, want stopped")
	}
}

// TestTouchDebounceConcurrentRace exercises the real (non-fake)
// scheduleTimer — a genuine time.AfterFunc goroutine — racing against
// concurrent TouchSession callers and a Close, under -race. It uses a ~1ms
// debounce so the real timer fires naturally within the test's own bounded
// wait rather than via an arbitrary sleep. It asserts Close's
// flush-on-close guarantee holds even mid-storm: the session is present in
// the state file once everything has quiesced.
func TestTouchDebounceConcurrentRace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "panel-state.json")
	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	m.stateDebounce = time.Millisecond // real scheduleTimer (time.AfterFunc), just fast

	if err := m.PutSession(Session{IDHash: "a", Created: time.Now()}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}

	const goroutines = 8
	var started atomic.Int32
	startedAll := make(chan struct{})
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			touchedOnce := false
			for {
				select {
				case <-stop:
					return
				default:
				}
				if err := m.TouchSession("a", time.Now()); err != nil {
					t.Errorf("TouchSession: %v", err)
				}
				if !touchedOnce {
					touchedOnce = true
					if started.Add(1) == goroutines {
						close(startedAll)
					}
				}
			}
		}()
	}

	// Bounded wait (channel, not a sleep): proceed once every goroutine has
	// landed at least one touch, so Close below genuinely races real
	// TouchSession callers and the real debounce timer instead of an empty
	// storm.
	<-startedAll
	if err := m.Close(); err != nil {
		t.Fatalf("Close (mid-storm): %v", err)
	}

	close(stop)
	wg.Wait()

	// A second Close quiesces any timer a post-first-Close touch may have
	// re-armed, so no timer goroutine outlives the test.
	if err := m.Close(); err != nil {
		t.Fatalf("Close (final): %v", err)
	}

	if got := readStateLastSeen(t, path, "a"); got.IsZero() {
		t.Fatalf("state-file LastSeen after storm+Close = zero, want the flush-on-close guarantee to hold")
	}
}

func TestClose(t *testing.T) {
	m := newMemory(t)
	if err := m.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
