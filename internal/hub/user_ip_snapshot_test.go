package hub

import (
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"reflect"
	"testing"
	"time"
)

type heldFlushStore struct {
	store.HistoryStore
	started chan struct{}
	release chan struct{}
}

func (s *heldFlushStore) ApplyUserIPBatch(batch store.UserIPBatch) error {
	close(s.started)
	<-s.release
	return s.HistoryStore.ApplyUserIPBatch(batch)
}

func TestLiveGeographyCopyDoesNotWaitForFlush(t *testing.T) {
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	st := &heldFlushStore{HistoryStore: m, started: make(chan struct{}), release: make(chan struct{})}
	now := time.Unix(1800000000, 0)
	h := &Hub{st: st, now: func() time.Time { return now }}
	finished := make(chan struct{})
	go func() {
		h.observeUserIPs([]telemt.UserInfo{{Username: "alice", ActiveIPList: []string{"1.1.1.1"}, RecentIPList: []string{}}}, 0)
		close(finished)
	}()
	<-st.started
	result := make(chan UserIPLiveSnapshot, 1)
	go func() { result <- h.UserIPSnapshot(now.Unix()) }()
	select {
	case snapshot := <-result:
		close(st.release)
		<-finished
		if len(snapshot.Records) != 1 {
			t.Fatal("active observation not published before flush")
		}
	case <-time.After(150 * time.Millisecond):
		close(st.release)
		<-finished
		<-result
		t.Fatal("active snapshot blocked on the history flush")
	}
}

func TestLiveGeographyFlushPublishesStatusWithoutCopyingRecords(t *testing.T) {
	m, err := store.NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	st := &heldFlushStore{HistoryStore: m, started: make(chan struct{}), release: make(chan struct{})}
	now := time.Unix(1800000000, 0)
	h := &Hub{st: st, now: func() time.Time { return now }}
	finished := make(chan struct{})
	go func() {
		h.observeUserIPs([]telemt.UserInfo{{Username: "alice", ActiveIPList: []string{"1.1.1.1"}, RecentIPList: []string{}}}, 0)
		close(finished)
	}()
	<-st.started
	before := h.ips.snapshot.Load()
	close(st.release)
	<-finished
	after := h.ips.snapshot.Load()
	if before == nil || after == nil || len(before.Records) != 1 || len(after.Records) != 1 {
		t.Fatal("flush lost the published active observation")
	}
	if !before.Source.Pending || after.Source.Pending || before == after {
		t.Fatalf("flush status was not replaced independently: before=%+v after=%+v", before.Source, after.Source)
	}
	if &before.Records[0] != &after.Records[0] {
		t.Fatal("flush rebuilt the immutable active record snapshot")
	}
	h.flushUserIPs()
	final := h.ips.snapshot.Load()
	if final.Source.Pending || &final.Records[0] != &after.Records[0] {
		t.Fatal("final flush rebuilt records or changed their pending status")
	}
}

func TestLiveGeographyCopiesAreSortedAndCallerOwned(t *testing.T) {
	m, err := store.NewMemoryHistory()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	now := time.Unix(1800000000, 0)
	h := &Hub{st: m, now: func() time.Time { return now }}
	h.observeUserIPs([]telemt.UserInfo{
		{Username: "bob", ActiveIPList: []string{"2001:db8::1", "2.2.2.2"}, RecentIPList: []string{}},
		{Username: "alice", ActiveIPList: []string{"8.8.8.8", "2.2.2.2", "1.1.1.1"}, RecentIPList: []string{}},
	}, 0)
	want := []string{"alice/1.1.1.1", "alice/2.2.2.2", "alice/8.8.8.8", "bob/2.2.2.2", "bob/2001:db8::1"}
	keys := func(records []store.UserIPRecord) []string {
		out := make([]string, len(records))
		for i, record := range records {
			out[i] = record.Username + "/" + record.IP
		}
		return out
	}
	// Publication must sort independently of Go's map iteration order.
	for i := 0; i < 20; i++ {
		h.ips.mu.Lock()
		published := h.copyUserIPSnapshotLocked(now.Unix())
		h.ips.mu.Unlock()
		if got := keys(published.Records); !reflect.DeepEqual(got, want) {
			t.Fatalf("published records = %v; want %v", got, want)
		}
	}
	first := h.UserIPSnapshot(now.Unix())
	if got := keys(first.Records); !reflect.DeepEqual(got, want) {
		t.Fatalf("copied records = %v; want %v", got, want)
	}
	first.Records[0].Username = "changed"
	first.Records[1] = store.UserIPRecord{}
	*first.Source.AgeSeconds = 999
	second := h.UserIPSnapshot(now.Unix())
	if got := keys(second.Records); !reflect.DeepEqual(got, want) || *second.Source.AgeSeconds != 0 {
		t.Fatalf("caller changed the published snapshot: records=%v source=%+v", got, second.Source)
	}
	if &first.Records[0] == &second.Records[0] {
		t.Fatal("snapshot callers share mutable records")
	}
}

func TestLiveGeographyActiveOnly(t *testing.T) {
	m, _ := store.NewMemoryHistory()
	defer m.Close()
	now := time.Unix(1800000000, 0)
	h := &Hub{st: m, now: func() time.Time { return now }}
	if s := h.UserIPSnapshot(now.Unix()); s.Source.State != "unavailable" || s.Source.LastSuccess != 0 {
		t.Fatal("initial source is not unknown")
	}
	h.observeUserIPs([]telemt.UserInfo{{Username: "alice", ActiveIPList: []string{"1.1.1.1", "::ffff:1.1.1.1", "bad"}, RecentIPList: []string{"2.2.2.2"}}}, 0)
	s := h.UserIPSnapshot(now.Unix())
	if len(s.Records) != 1 || s.Records[0].IP != "1.1.1.1" || !s.Partial || s.InvalidUsers != 1 {
		t.Fatalf("mixed active=%+v", s)
	}
	now = now.Add(10 * time.Second)
	h.observeUserIPs([]telemt.UserInfo{{Username: "alice", ActiveIPList: []string{"1.1.1.1"}, RecentIPList: nil}}, 0)
	s = h.UserIPSnapshot(now.Unix())
	if s.Partial || s.Source.State != "collecting" {
		t.Fatal("historical gap contaminated active snapshot")
	}
	for _, at := range []int64{now.Unix() + 31, now.Unix() - 1} {
		if h.UserIPSnapshot(at).Source.State != "stale" {
			t.Fatal("stale source not reported")
		}
	}
	h.ips.failed = true
	h.publishUserIPSnapshotLocked()
	if h.UserIPSnapshot(now.Unix()).Source.State != "stale" {
		t.Fatal("failure lost last snapshot")
	}
	h.ips.failed = false
	h.publishUserIPSnapshotLocked()
	now = now.Add(10 * time.Second)
	h.observeUserIPs([]telemt.UserInfo{{Username: "alice", RecentIPList: []string{"2.2.2.2"}}}, 0)
	if h.UserIPSnapshot(now.Unix()).Source.State != "unavailable" {
		t.Fatal("null active treated as empty")
	}
	now = now.Add(10 * time.Second)
	h.observeUserIPs([]telemt.UserInfo{{Username: "alice", ActiveIPList: []string{}, RecentIPList: []string{}}}, 0)
	if s := h.UserIPSnapshot(now.Unix()); s.Source.State != "collecting" || len(s.Records) != 0 || s.Partial {
		t.Fatalf("empty active=%+v", s)
	}
	epoch := h.UserIPResetEpoch()
	if err := h.ResetUserIPHistory(""); err != nil {
		t.Fatal(err)
	}
	if h.UserIPResetEpoch() == epoch || h.UserIPSnapshot(now.Unix()).Source.State != "unavailable" {
		t.Fatal("reset did not revoke active snapshot")
	}
}
