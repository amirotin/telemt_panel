package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestUserIPObservationsAndReset(t *testing.T) {
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	now := time.Unix(1800000000, 0)
	h := &Hub{st: m, now: func() time.Time { return now }}
	users := []telemt.UserInfo{{Username: "alice", ActiveIPList: []string{"192.0.2.1", "::ffff:192.0.2.1"}, RecentIPList: []string{"192.0.2.1", "2001:db8::1"}}}
	h.observeUserIPs(users, 0)
	p, err := m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now.Unix(), Limit: 50})
	if err != nil || p.Total != 2 || p.Items[0].Observations != 1 || p.Items[0].Source != 3 {
		t.Fatalf("union: %+v %v", p, err)
	}
	if active := h.UserIPLive("alice", "192.0.2.1"); active == nil || !*active {
		t.Fatal("missing live presence")
	}
	now = now.Add(31 * time.Second)
	if h.UserIPLive("alice", "192.0.2.1") != nil {
		t.Fatal("stale address still active")
	}
	if err := h.ResetUserIPHistory("alice"); err != nil {
		t.Fatal(err)
	}
	h.observeUserIPs(users, 0)
	p, _ = m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now.Unix(), Limit: 50})
	if p.Total != 0 {
		t.Fatal("pre-reset in-flight observation resurrected history")
	}
	h.observeUserIPs(users, 1)
	p, _ = m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now.Unix(), Limit: 50})
	if p.Total != 2 {
		t.Fatal("new observations not accepted after reset")
	}
}

func TestUserIPMissingSources(t *testing.T) {
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	now := time.Unix(1800000000, 0)
	h := &Hub{st: m, now: func() time.Time { return now }}
	h.observeUserIPs([]telemt.UserInfo{{Username: "alice", RecentIPList: []string{"2001:db8::1"}}}, 0)
	if h.UserIPLive("alice", "2001:db8::1") != nil {
		t.Fatal("missing active source must be unknown")
	}
	now = now.Add(10 * time.Second)
	h.observeUserIPs([]telemt.UserInfo{{Username: "alice", ActiveIPList: []string{}, RecentIPList: []string{}}}, 0)
	if v := h.UserIPLive("alice", "2001:db8::1"); v == nil || *v {
		t.Fatal("valid empty active list must be inactive")
	}
}

type retryIPStore struct {
	store.HistoryStore
	fail bool
}

func (s *retryIPStore) Info() store.Info { return store.Info{Durable: true} }
func (s *retryIPStore) ApplyUserIPBatch(b store.UserIPBatch) error {
	if err := s.HistoryStore.ApplyUserIPBatch(b); err != nil {
		return err
	}
	if s.fail {
		return errors.New("commit acknowledged late")
	}
	return nil
}

func TestUserIPRetryDoesNotDoubleCount(t *testing.T) {
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	s := &retryIPStore{HistoryStore: m, fail: true}
	now := time.Unix(1800000000, 0)
	h := &Hub{st: s, now: func() time.Time { return now }}
	u := []telemt.UserInfo{{Username: "alice", ActiveIPList: []string{"192.0.2.1"}, RecentIPList: []string{}}}
	h.observeUserIPs(u, 0)
	if h.ips.retry == nil {
		t.Fatal("failed batch not retained")
	}
	now = now.Add(10 * time.Second)
	s.fail = false
	h.observeUserIPs(u, 0)
	page, _ := m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now.Unix(), Limit: 50})
	if page.Items[0].Observations != 2 {
		t.Fatal("retry changed observation count", page.Items)
	}
	now = now.Add(10 * time.Second)
	h.observeUserIPs(u, 0)
	if len(h.ips.pending) != 1 {
		t.Fatal("SQLite-mode observation not buffered")
	}
	if err := h.ResetUserIPHistory("alice"); err != nil {
		t.Fatal(err)
	}
	h.flushUserIPs()
	page, _ = m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now.Unix(), Limit: 50})
	if page.Total != 0 {
		t.Fatal("pending batch resurrected reset history")
	}
}

func TestUserIPOnlyPeriodicUsersFetchCounts(t *testing.T) {
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/users":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": []telemt.UserInfo{{Username: "alice", ActiveIPList: []string{"192.0.2.1"}, RecentIPList: []string{"192.0.2.1"}}}})
		case "/v1/limits/effective":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": map[string]any{"user_ip_policy": map[string]any{"window_secs": 75}}})
		default:
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"unavailable","message":"quota unavailable"}}`))
		}
	}))
	defer fake.Close()
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	h := New(Config{}, telemt.New(fake.URL, ""), m)
	defer h.Close()
	now := time.Unix(1800000000, 0)
	h.now = func() time.Time { return now }
	if !h.pollPeriodic(h.topics["users"]) {
		t.Fatal("users poll failed")
	}
	status := h.UserIPSourceStatus()
	if status.RecentWindow == nil || *status.RecentWindow != 75 {
		t.Fatalf("window: %+v", status)
	}
	h.ips.mu.Lock()
	before := struct {
		generation, through, flushed uint64
		pending                      int
		retry, gap, failed           bool
	}{
		generation: h.ips.generation,
		through:    uint64(h.ips.through),
		flushed:    uint64(h.ips.flushed),
		pending:    len(h.ips.pending),
		retry:      h.ips.retry != nil,
		gap:        h.ips.gap,
		failed:     h.ips.failed,
	}
	h.ips.mu.Unlock()
	now = now.Add(10 * time.Second)
	for i := 0; i < 2; i++ {
		if !h.poll(h.topics["users"]) {
			t.Fatal("manual users poll failed")
		}
	}
	if _, err := h.Snapshot(context.Background(), []string{"users"}); err != nil {
		t.Fatal(err)
	}
	if err := h.Poke("users"); err != nil {
		t.Fatal(err)
	}
	h.ips.mu.Lock()
	after := struct {
		generation, through, flushed uint64
		pending                      int
		retry, gap, failed           bool
	}{
		generation: h.ips.generation,
		through:    uint64(h.ips.through),
		flushed:    uint64(h.ips.flushed),
		pending:    len(h.ips.pending),
		retry:      h.ips.retry != nil,
		gap:        h.ips.gap,
		failed:     h.ips.failed,
	}
	h.ips.mu.Unlock()
	if after != before {
		t.Fatalf("manual hydration changed periodic IP state: before=%+v after=%+v", before, after)
	}
	page, _ := m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now.Unix(), Limit: 50})
	if page.Total != 1 || page.Items[0].Observations != 1 {
		t.Fatalf("manual poll counted or quota error lost IP: %+v", page)
	}
	if !h.pollPeriodic(h.topics["users"]) {
		t.Fatal("second periodic poll failed")
	}
	page, _ = m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: now.Unix(), Limit: 50})
	if page.Items[0].Observations != 2 {
		t.Fatal("second scheduled observation missing")
	}
}

func TestUserIPCleanupDuringSourceOutage(t *testing.T) {
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	now := time.Unix(1800000000, 0)
	old := now.Unix() - 86410
	if err := m.ApplyUserIPBatch(store.UserIPBatch{ID: "old", Through: old, Records: []store.UserIPRecord{{Username: "alice", IP: "192.0.2.1", Family: 4, First: old, Last: old, Observations: 1, Source: 2}}}); err != nil {
		t.Fatal(err)
	}
	h := New(Config{}, nil, m)
	defer h.Close()
	h.now = func() time.Time { return now }
	h.topics["users"].fetch = func(context.Context) (any, error) { return nil, errors.New("users unavailable") }
	if h.pollPeriodic(h.topics["users"]) {
		t.Fatal("unexpected source success")
	}
	page, _ := m.UserIPHistory(store.UserIPQuery{Username: "alice", Now: old, Limit: 50})
	if page.Total != 0 {
		t.Fatal("source outage prevented expiration")
	}
}

func TestUserIPCollectorBounds(t *testing.T) {
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	s := &retryIPStore{HistoryStore: m, fail: true}
	now := time.Unix(1800000000, 0)
	h := &Hub{st: s, now: func() time.Time { return now }}
	users := make([]telemt.UserInfo, store.UserIPBatchLimit+1)
	for i := range users {
		users[i] = telemt.UserInfo{Username: fmt.Sprint(i), ActiveIPList: []string{"192.0.2.1"}, RecentIPList: []string{}}
	}
	h.observeUserIPs(users, 0)
	if h.ips.retry == nil || len(h.ips.retry.Records) > store.UserIPBatchLimit || !h.ips.limited {
		t.Fatal("unbounded first batch")
	}
	now = now.Add(10 * time.Second)
	h.observeUserIPs(users, 0)
	if len(h.ips.pending)+len(h.ips.retry.Records) > store.UserIPBatchLimit {
		t.Fatal("pending plus retry exceeded cap")
	}
	if len(h.ips.live) > store.UserIPMemoryLimit {
		t.Fatal("unbounded live overlay")
	}
}

func TestUserIPActiveCountFreshness(t *testing.T) {
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	now := time.Unix(1800000000, 0)
	h := &Hub{st: m, now: func() time.Time { return now }}
	if h.UserIPActiveCount("alice") != nil {
		t.Fatal("unknown user has an active count")
	}
	if h.UserIPSourceStatus().AgeSeconds != nil {
		t.Fatal("missing source must not have an age")
	}
	h.observeUserIPs([]telemt.UserInfo{{Username: "alice", ActiveIPList: []string{"192.0.2.1", "::ffff:192.0.2.1", "2001:db8::1"}, RecentIPList: []string{}}}, 0)
	if n := h.UserIPActiveCount("alice"); n == nil || *n != 2 {
		t.Fatal("count must cover distinct live addresses")
	}
	now = now.Add(31 * time.Second)
	if age := h.UserIPSourceStatus().AgeSeconds; age == nil || *age != 31 {
		t.Fatal("source age must use the server clock")
	}
	if h.UserIPActiveCount("alice") != nil {
		t.Fatal("stale count must be unknown")
	}
}
