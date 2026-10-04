package hub

import (
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
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
