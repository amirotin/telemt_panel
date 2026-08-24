package hub

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// fakeTelemt is a minimal, controllable stand-in for the Telemt API,
// letting tests drive the hub's poller deterministically: every request is
// recorded on a channel so tests can synchronize on "this many requests
// happened" instead of sleeping and hoping.
type fakeTelemt struct {
	mu      sync.Mutex
	users   []telemt.UserInfo
	health  telemt.HealthData
	summary telemt.SummaryData

	usersFailing   int32
	healthFailing  int32
	summaryFailing int32

	requests chan string
}

func newFakeTelemt(t *testing.T) (*fakeTelemt, *telemt.Client) {
	t.Helper()
	f := &fakeTelemt{requests: make(chan string, 4096)}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, telemt.New(srv.URL, "")
}

func (f *fakeTelemt) serve(w http.ResponseWriter, r *http.Request) {
	f.requests <- r.URL.Path

	switch r.URL.Path {
	case "/v1/users":
		if atomic.LoadInt32(&f.usersFailing) > 0 {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"ok":false,"error":{"code":"internal_error","message":"boom"}}`)
			return
		}
		f.mu.Lock()
		users := f.users
		f.mu.Unlock()
		writeEnvelope(w, users)
	case "/v1/health":
		if atomic.LoadInt32(&f.healthFailing) > 0 {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"ok":false,"error":{"code":"internal_error","message":"boom"}}`)
			return
		}
		f.mu.Lock()
		health := f.health
		f.mu.Unlock()
		writeEnvelope(w, health)
	case "/v1/stats/summary":
		if atomic.LoadInt32(&f.summaryFailing) > 0 {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"ok":false,"error":{"code":"internal_error","message":"boom"}}`)
			return
		}
		f.mu.Lock()
		summary := f.summary
		f.mu.Unlock()
		writeEnvelope(w, summary)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func writeEnvelope(w http.ResponseWriter, data any) {
	body, _ := json.Marshal(struct {
		OK       bool   `json:"ok"`
		Data     any    `json:"data"`
		Revision string `json:"revision"`
	}{OK: true, Data: data, Revision: "r"})
	w.Write(body)
}

func (f *fakeTelemt) setUsers(users []telemt.UserInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users = users
}

func (f *fakeTelemt) setUsersFailing(failing bool) {
	atomic.StoreInt32(&f.usersFailing, boolToInt32(failing))
}

func (f *fakeTelemt) setHealthFailing(failing bool) {
	atomic.StoreInt32(&f.healthFailing, boolToInt32(failing))
}

func (f *fakeTelemt) setSummaryFailing(failing bool) {
	atomic.StoreInt32(&f.summaryFailing, boolToInt32(failing))
}

func boolToInt32(b bool) int32 {
	if b {
		return 1
	}
	return 0
}

// awaitRequest waits up to timeout for the next request to path.
func (f *fakeTelemt) awaitRequest(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case p := <-f.requests:
			if p == path {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a request to %s", path)
		}
	}
}

// assertNoRequest fails the test if a request to path arrives within
// timeout.
func (f *fakeTelemt) assertNoRequest(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case p := <-f.requests:
			if p == path {
				t.Fatalf("unexpected request to %s", path)
			}
		case <-deadline:
			return
		}
	}
}

// drainFor discards requests for the given duration without asserting
// anything about them — used to let a poller run through a legitimate
// window (e.g. a grace period) before checking it has actually stopped.
func (f *fakeTelemt) drainFor(d time.Duration) {
	deadline := time.After(d)
	for {
		select {
		case <-f.requests:
		case <-deadline:
			return
		}
	}
}

// countRequests counts requests to path over window.
func (f *fakeTelemt) countRequests(path string, window time.Duration) int {
	deadline := time.After(window)
	n := 0
	for {
		select {
		case p := <-f.requests:
			if p == path {
				n++
			}
		case <-deadline:
			return n
		}
	}
}

func recvEvent(t *testing.T, ch <-chan Event, timeout time.Duration) Event {
	t.Helper()
	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("channel closed unexpectedly")
		}
		return ev
	case <-time.After(timeout):
		t.Fatal("timed out waiting for an event")
	}
	panic("unreachable")
}

func drainUntilClosed(t *testing.T, ch <-chan Event, timeout time.Duration) {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case _, open := <-ch:
			if !open {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for the channel to close")
		}
	}
}

func decodeUsers(t *testing.T, data json.RawMessage) []telemt.UserInfo {
	t.Helper()
	var users []telemt.UserInfo
	if err := json.Unmarshal(data, &users); err != nil {
		t.Fatalf("decode users: %v (data=%s)", err, data)
	}
	return users
}

func TestUnknownTopicRejected(t *testing.T) {
	_, tc := newFakeTelemt(t)
	h := New(Config{}, tc)
	t.Cleanup(h.Close)

	_, _, _, err := h.Subscribe([]string{"users", "bogus"})
	var unk *ErrUnknownTopic
	if err == nil {
		t.Fatal("Subscribe: want error for unknown topic")
	}
	if !asErrUnknownTopic(err, &unk) || unk.Topic != "bogus" {
		t.Fatalf("err = %v, want ErrUnknownTopic{bogus}", err)
	}

	if _, err := h.Snapshot(t.Context(), []string{"bogus"}); err == nil {
		t.Fatal("Snapshot: want error for unknown topic")
	}
}

// asErrUnknownTopic avoids importing errors just for errors.As in this one
// helper.
func asErrUnknownTopic(err error, target **ErrUnknownTopic) bool {
	if e, ok := err.(*ErrUnknownTopic); ok {
		*target = e
		return true
	}
	return false
}

func TestSubscribeReceivesSnapshotThenUpdateOnChange(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "alice"}})

	interval := 20 * time.Millisecond
	h := New(Config{UsersInterval: interval, StatsInterval: time.Hour, Grace: 200 * time.Millisecond}, tc)
	t.Cleanup(h.Close)

	ch, snapshots, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer cancel()

	// Fresh topic, first subscriber: nothing cached yet, but the first
	// poll fires immediately rather than waiting a full interval.
	if len(snapshots) != 0 {
		t.Fatalf("snapshots = %+v, want none yet", snapshots)
	}

	ev := recvEvent(t, ch, time.Second)
	if ev.Topic != "users" || ev.Err != "" {
		t.Fatalf("first event = %+v", ev)
	}
	if got := decodeUsers(t, ev.Data); len(got) != 1 || got[0].Username != "alice" {
		t.Fatalf("event data = %s", ev.Data)
	}

	// Several polls happen with unchanged data: no further events.
	select {
	case unexpected := <-ch:
		t.Fatalf("unexpected event on unchanged data: %+v", unexpected)
	case <-time.After(5 * interval):
	}

	// A real change produces exactly one more event.
	f.setUsers([]telemt.UserInfo{{Username: "bob"}})
	ev = recvEvent(t, ch, time.Second)
	if got := decodeUsers(t, ev.Data); len(got) != 1 || got[0].Username != "bob" {
		t.Fatalf("updated event data = %s", ev.Data)
	}
}

func TestTwoSubscribersOnePollPerInterval(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "alice"}})

	interval := 20 * time.Millisecond
	h := New(Config{UsersInterval: interval, StatsInterval: time.Hour, Grace: time.Second}, tc)
	t.Cleanup(h.Close)

	ch1, _, cancel1, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel1()
	first := recvEvent(t, ch1, time.Second)

	ch2, snapshots, cancel2, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel2()
	if len(snapshots) != 1 || snapshots[0].Seq != first.Seq {
		t.Fatalf("second subscriber snapshots = %+v, want cached event seq %d", snapshots, first.Seq)
	}

	// One poller for both subscribers: requests over a multi-interval
	// window stay near window/interval, never anywhere close to double.
	window := 6 * interval
	count := f.countRequests("/v1/users", window)
	maxExpected := int(window/interval) + 2
	if count == 0 || count > maxExpected {
		t.Fatalf("requests to /v1/users in %v = %d, want <= %d (single poller)", window, count, maxExpected)
	}

	// Both subscribers observe the same broadcast for a real change.
	f.setUsers([]telemt.UserInfo{{Username: "bob"}})
	ev1 := recvEvent(t, ch1, time.Second)
	ev2 := recvEvent(t, ch2, time.Second)
	if ev1.Seq != ev2.Seq {
		t.Fatalf("subscribers diverged: ev1.Seq=%d ev2.Seq=%d", ev1.Seq, ev2.Seq)
	}
}

func TestReplayAfterReconnect(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "v1"}})

	h := New(Config{UsersInterval: 15 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second}, tc)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	first := recvEvent(t, ch, time.Second)

	f.setUsers([]telemt.UserInfo{{Username: "v2"}})
	second := recvEvent(t, ch, time.Second)

	f.setUsers([]telemt.UserInfo{{Username: "v3"}})
	third := recvEvent(t, ch, time.Second)
	cancel()

	events, ok := h.ReplaySince(first.Seq, []string{"users"})
	if !ok {
		t.Fatal("ReplaySince: want ok=true")
	}
	if len(events) != 2 || events[0].Seq != second.Seq || events[1].Seq != third.Seq {
		t.Fatalf("replay = %+v, want seqs [%d %d]", events, second.Seq, third.Seq)
	}
}

func TestReplayTooOldReturnsFalse(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "v0"}})

	h := New(Config{UsersInterval: 5 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second, ReplayRingSize: 2}, tc)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	first := recvEvent(t, ch, time.Second)
	for i := 1; i <= 3; i++ {
		f.setUsers([]telemt.UserInfo{{Username: fmt.Sprintf("v%d", i)}})
		recvEvent(t, ch, time.Second)
	}

	// Ring size 2: the very first event has long since been evicted.
	if _, ok := h.ReplaySince(first.Seq, []string{"users"}); ok {
		t.Fatal("ReplaySince: want ok=false once the requested seq fell out of the ring")
	}
}

// TestReplayStaleFutureIDFallsBackToFalse covers finding 3: a warm hub
// (freshly restarted, seq reset to 0) receiving a Last-Event-ID from a
// client that connected to a previous, longer-lived process. since is then
// larger than the hub's current seq — every ring event satisfies
// ev.Seq <= since, so without an explicit check ReplaySince would return
// an empty-but-ok replay and the SSE handler would skip its full-snapshot
// fallback, leaving the client with no data at all.
func TestReplayStaleFutureIDFallsBackToFalse(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "v0"}})

	h := New(Config{UsersInterval: 5 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second}, tc)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	first := recvEvent(t, ch, time.Second)

	// A Last-Event-ID far beyond anything this hub has issued yet (e.g.
	// left over from before a restart).
	staleFuture := first.Seq + 1000
	events, ok := h.ReplaySince(staleFuture, []string{"users"})
	if ok {
		t.Fatalf("ReplaySince(%d): want ok=false for a since beyond the hub's current seq, got events=%+v", staleFuture, events)
	}
	if events != nil {
		t.Fatalf("ReplaySince(%d): want nil events alongside ok=false, got %+v", staleFuture, events)
	}
}

func TestSlowSubscriberClosedPollerStaysAlive(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "v0"}})

	h := New(Config{UsersInterval: 10 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second, SubscriberBuffer: 1}, tc)
	t.Cleanup(h.Close)

	slowCh, _, slowCancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer slowCancel()
	// Never read slowCh: it must overflow and get closed.

	healthyCh, _, healthyCancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer healthyCancel()

	for i := 1; i <= 5; i++ {
		f.setUsers([]telemt.UserInfo{{Username: fmt.Sprintf("v%d", i)}})
		recvEvent(t, healthyCh, time.Second) // proves the poller is still alive
	}

	drainUntilClosed(t, slowCh, time.Second)
}

func TestPollerStopsAfterGrace(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "v0"}})

	interval := 10 * time.Millisecond
	grace := 30 * time.Millisecond
	h := New(Config{UsersInterval: interval, StatsInterval: time.Hour, Grace: grace}, tc)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	recvEvent(t, ch, time.Second)
	cancel()

	// The poller legitimately keeps running through the grace window;
	// drain whatever it does without asserting on it.
	f.drainFor(grace + 5*interval)

	// Once grace has elapsed, it must have stopped for good.
	f.assertNoRequest(t, "/v1/users", 5*interval)
}

func TestSourceErrorOnUpstream500AndRecovery(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsersFailing(true)

	h := New(Config{UsersInterval: 10 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second}, tc)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	ev := recvEvent(t, ch, time.Second)
	if ev.Err != sourceErrorCode || ev.Topic != "users" {
		t.Fatalf("event = %+v, want source_error for users", ev)
	}

	f.setUsers([]telemt.UserInfo{{Username: "alice"}})
	f.setUsersFailing(false)

	// Backoff may take a few doublings to come back around; give it room.
	ev = recvEvent(t, ch, 2*time.Second)
	if ev.Err != "" {
		t.Fatalf("event after recovery = %+v, want a normal snapshot", ev)
	}
	if got := decodeUsers(t, ev.Data); len(got) != 1 || got[0].Username != "alice" {
		t.Fatalf("recovered data = %s", ev.Data)
	}
}

func TestStatsTopicNullsFailedSubCall(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.health = telemt.HealthData{Status: "ok"}
	f.setHealthFailing(true)
	f.summary = telemt.SummaryData{UptimeSeconds: 42}

	h := New(Config{UsersInterval: time.Hour, StatsInterval: 10 * time.Millisecond, Grace: time.Second}, tc)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"stats"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	ev := recvEvent(t, ch, time.Second)
	if ev.Err != "" {
		t.Fatalf("stats topic must not source_error on a partial sub-call failure: %+v", ev)
	}
	var snap statsSnapshot
	if err := json.Unmarshal(ev.Data, &snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if snap.Health != nil {
		t.Errorf("health = %+v, want nil (failed sub-call)", snap.Health)
	}
	if snap.Summary == nil || snap.Summary.UptimeSeconds != 42 {
		t.Errorf("summary = %+v, want uptime 42", snap.Summary)
	}
}

func TestStatsTopicSourceErrorsWhenBothSubCallsFail(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setHealthFailing(true)
	f.setSummaryFailing(true)

	interval := 10 * time.Millisecond
	h := New(Config{UsersInterval: time.Hour, StatsInterval: interval, Grace: time.Second}, tc)
	t.Cleanup(h.Close)

	start := time.Now()
	ch, _, cancel, err := h.Subscribe([]string{"stats"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	// A total outage (both sub-calls failing) must surface as source_error,
	// not silently publish {"health":null,"summary":null}.
	ev := recvEvent(t, ch, time.Second)
	if ev.Err != sourceErrorCode || ev.Topic != "stats" {
		t.Fatalf("event = %+v, want source_error for stats", ev)
	}

	// Backoff engaged: the next poll waits at least a full base interval
	// (doubled from the immediate first poll), not another immediate retry.
	ev2 := recvEvent(t, ch, time.Second)
	gap := time.Since(start)
	if ev2.Err != sourceErrorCode {
		t.Fatalf("second event = %+v, want another source_error (still failing)", ev2)
	}
	if gap < interval {
		t.Fatalf("second source_error arrived after %v since subscribe, want >= backoff interval %v (no backoff?)", gap, interval)
	}

	// Recovery still works once both sub-calls succeed again. One more
	// source_error may already be in flight from before this flip; drain
	// past it to the first real snapshot.
	f.health = telemt.HealthData{Status: "ok"}
	f.summary = telemt.SummaryData{UptimeSeconds: 7}
	f.setHealthFailing(false)
	f.setSummaryFailing(false)

	var recovered Event
	for i := 0; i < 10; i++ {
		recovered = recvEvent(t, ch, 2*time.Second)
		if recovered.Err == "" {
			break
		}
	}
	if recovered.Err != "" {
		t.Fatalf("no recovered snapshot after 10 events, last = %+v", recovered)
	}
	var snap statsSnapshot
	if err := json.Unmarshal(recovered.Data, &snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if snap.Health == nil || snap.Summary == nil || snap.Summary.UptimeSeconds != 7 {
		t.Fatalf("recovered snapshot = %+v", snap)
	}
}

func TestSnapshotValidatesAllTopicsBeforeFetching(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "alice"}})

	h := New(Config{}, tc)
	t.Cleanup(h.Close)

	_, err := h.Snapshot(t.Context(), []string{"users", "bogus"})
	var unk *ErrUnknownTopic
	if !asErrUnknownTopic(err, &unk) || unk.Topic != "bogus" {
		t.Fatalf("err = %v, want ErrUnknownTopic{bogus}", err)
	}

	// The invalid topic must reject before any upstream fetch happens —
	// not even for the other, valid topic in the same request.
	select {
	case p := <-f.requests:
		t.Fatalf("unexpected upstream request %s before topic validation failed", p)
	default:
	}
}

func TestSnapshotFetchesOnDemandForIdleTopic(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "alice"}})

	h := New(Config{}, tc)
	t.Cleanup(h.Close)

	out, err := h.Snapshot(t.Context(), []string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	if got := decodeUsers(t, out["users"]); len(got) != 1 || got[0].Username != "alice" {
		t.Fatalf("snapshot = %s", out["users"])
	}
}

func TestCloseStopsRunningPollersAndClosesSubscribers(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "v0"}})

	h := New(Config{UsersInterval: 10 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second}, tc)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	recvEvent(t, ch, time.Second)

	h.Close()

	drainUntilClosed(t, ch, time.Second)
	// One fetch may already have been in flight when Close ran; absorb it
	// before asserting the poller has truly stopped.
	f.drainFor(20 * time.Millisecond)
	f.assertNoRequest(t, "/v1/users", 5*10*time.Millisecond)
}
