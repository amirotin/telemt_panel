//go:build !lite

package store

import (
	"fmt"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

func TestUserIPSQLite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	s, err := NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	runUserIPContract(t, s)
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = NewSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	page, err := s.UserIPHistory(UserIPQuery{Username: "alice", Now: 1800000100, Limit: 50})
	if err != nil || page.Total != 256 {
		t.Fatalf("reopen: %+v %v", page, err)
	}
}

func TestUserIPSQLiteExpirationAndNew(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runUserIPExpirationAndNew(t, s)
}

func TestUserIPSQLiteExpiryOnExport(t *testing.T) {
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	runUserIPExpiryOnExport(t, s)
}

func TestUserIPSQLitePortable(t *testing.T) {
	s, _ := NewSQLite(filepath.Join(t.TempDir(), "one.db"))
	defer s.Close()
	b := UserIPBatch{ID: "export", Through: 1800000000, Records: []UserIPRecord{{Username: "alice", IP: "2001:db8::1", Family: 6, First: 1800000000, Last: 1800000000, Observations: 1, Source: 2}}}
	if err := s.ApplyUserIPBatch(b); err != nil {
		t.Fatal(err)
	}
	data, err := s.ExportData()
	if err != nil {
		t.Fatal(err)
	}
	dest, _ := NewSQLite(filepath.Join(t.TempDir(), "two.db"))
	defer dest.Close()
	if err := dest.ImportData(data); err != nil {
		t.Fatal(err)
	}
	page, err := dest.UserIPHistory(UserIPQuery{Username: "alice", Now: b.Through, Limit: 50})
	if err != nil || page.Total != 1 || page.Items[0].IP != "2001:db8::1" {
		t.Fatalf("round trip: %+v %v", page, err)
	}
}

// This bounded load test logs measurements rather than asserting host speed.
func TestUserIPSQLiteScale(t *testing.T) {
	if testing.Short() {
		t.Skip("scale measurements")
	}
	s, err := NewSQLite(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().Unix()
	var flushTimes []time.Duration
	for part := 0; part < 5; part++ {
		b := UserIPBatch{ID: fmt.Sprint(part), Through: now + int64(part), Records: make([]UserIPRecord, 0, 20000)}
		for i := 0; i < 20000; i++ {
			index := part*20000 + i
			b.Records = append(b.Records, UserIPRecord{Username: fmt.Sprintf("user%04d", index/50), IP: fmt.Sprintf("2001:db8::%x", index%50+1), Family: 6, First: now, Last: now, Observations: 1, Source: 2})
		}
		start := time.Now()
		if err := s.ApplyUserIPBatch(b); err != nil {
			t.Fatal(err)
		}
		flushTimes = append(flushTimes, time.Since(start))
	}
	var times []time.Duration
	for i := 0; i < 30; i++ {
		start := time.Now()
		page, err := s.UserIPHistory(UserIPQuery{Username: fmt.Sprintf("user%04d", i*60), Now: now + 4, Limit: 20})
		if err != nil || page.Total != 50 {
			t.Fatalf("query: %+v %v", page, err)
		}
		times = append(times, time.Since(start))
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	start := time.Now()
	summary, err := s.UserIPSummaries(now-86400, now+4)
	if err != nil || len(summary) != 2000 {
		t.Fatal("grouped summary", len(summary), err)
	}
	t.Logf("100000 addresses / 2000 users: 20k batch flushes=%v, query p95=%s, grouped summary=%s, database bytes=%d", flushTimes, times[28], time.Since(start), s.Info().SizeHint)
	// Global cap evicts the oldest deterministic row and marks limited history.
	if err := s.ApplyUserIPBatch(UserIPBatch{ID: "cap", Through: now + 5, Records: []UserIPRecord{{Username: "new", IP: "192.0.2.1", Family: 4, First: now + 5, Last: now + 5, Observations: 1, Source: 1}}}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM user_ip_history").Scan(&count); err != nil || count != UserIPSQLiteLimit {
		t.Fatal("global cap", count, err)
	}
	c, _ := s.UserIPCollectionState()
	if !c.Limited {
		t.Fatal("global cap not reported")
	}
}
