package store

import (
	"fmt"
	"os"
	"path/filepath"
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
		total := metricCap + 10
		for i := 0; i < total; i++ {
			if err := m.RecordMetric("rx_bytes", MetricPoint{TS: int64(i), Value: float64(i)}); err != nil {
				t.Fatalf("RecordMetric(%d): %v", i, err)
			}
		}
		got, err := m.MetricRange("rx_bytes", 0)
		if err != nil {
			t.Fatalf("MetricRange: %v", err)
		}
		if len(got) != metricCap {
			t.Fatalf("len(MetricRange) = %d, want %d", len(got), metricCap)
		}
		// Oldest first: index 0 is the oldest survivor (i = total-metricCap).
		if got[0].TS != int64(total-metricCap) {
			t.Fatalf("oldest surviving point TS = %d, want %d", got[0].TS, total-metricCap)
		}
		if got[len(got)-1].TS != int64(total-1) {
			t.Fatalf("newest point TS = %d, want %d", got[len(got)-1].TS, total-1)
		}
	})
}

func TestMirrorRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mirror.json")

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
	// Metrics are explicitly excluded from the mirror.
	if err := m1.RecordMetric("rx_bytes", MetricPoint{TS: 1, Value: 1}); err != nil {
		t.Fatalf("RecordMetric: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat mirror file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mirror file perm = %o, want 0600", perm)
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

	points, err := m2.MetricRange("rx_bytes", 0)
	if err != nil {
		t.Fatalf("MetricRange after reopen: %v", err)
	}
	if len(points) != 0 {
		t.Fatalf("MetricRange after reopen = %+v, want empty (metrics not mirrored)", points)
	}
}

func TestMirrorDisabled(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatalf("NewMemory(\"\"): %v", err)
	}
	if err := m.PutSession(Session{IDHash: "a"}); err != nil {
		t.Fatalf("PutSession: %v", err)
	}
	// No mirror path was given, so there's nothing further to assert here
	// beyond PutSession not erroring or panicking while trying to persist.
}

func TestMirrorMissingFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "does-not-exist.json")

	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	sessions, err := m.ListSessions()
	if err != nil || len(sessions) != 0 {
		t.Fatalf("ListSessions on missing mirror = %+v err:%v, want empty nil", sessions, err)
	}
}

func TestMirrorCorruptFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mirror.json")
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	m, err := NewMemory(path)
	if err != nil {
		t.Fatalf("NewMemory: %v", err)
	}
	sessions, err := m.ListSessions()
	if err != nil || len(sessions) != 0 {
		t.Fatalf("ListSessions on corrupt mirror = %+v err:%v, want empty nil", sessions, err)
	}
}

func TestClose(t *testing.T) {
	m := newMemory(t)
	if err := m.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
