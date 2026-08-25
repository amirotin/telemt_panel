package hub

import (
	"bytes"
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
	// quota and quotaEnabled script /v1/stats/users/quota: quotaEnabled
	// false serves a 404 (capability absent on this Telemt build), matching
	// fakeTelemt's default (a Telemt build predating the endpoint), the
	// same way the real route is unrouted on old builds.
	quota        map[string]telemt.QuotaEntry
	quotaEnabled bool

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
	case "/v1/stats/users/quota":
		f.mu.Lock()
		enabled, quota := f.quotaEnabled, f.quota
		f.mu.Unlock()
		if !enabled {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		type wireEntry struct {
			Username           string `json:"username"`
			DataQuotaBytes     uint64 `json:"data_quota_bytes"`
			UsedBytes          uint64 `json:"used_bytes"`
			LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
		}
		entries := make([]wireEntry, 0, len(quota))
		for username, q := range quota {
			entries = append(entries, wireEntry{
				Username: username, DataQuotaBytes: q.DataQuotaBytes,
				UsedBytes: q.UsedBytes, LastResetEpochSecs: q.LastResetEpochSecs,
			})
		}
		writeEnvelope(w, struct {
			Users []wireEntry `json:"users"`
		}{Users: entries})
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

func (f *fakeTelemt) setQuota(quota map[string]telemt.QuotaEntry) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.quotaEnabled = true
	f.quota = quota
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

// drainUntilQuiet discards requests until none arrives for a full quiet
// window, then returns. Unlike a fixed-duration drain, this is robust to
// race-detector slowdown: a still-running poller (interval far below quiet)
// would keep breaking the silence, so observed quiet proves it stopped.
// Fails the test if silence is not reached within max.
func (f *fakeTelemt) drainUntilQuiet(t *testing.T, quiet, max time.Duration) {
	t.Helper()
	hardDeadline := time.After(max)
	for {
		select {
		case <-f.requests:
		case <-time.After(quiet):
			return
		case <-hardDeadline:
			t.Fatalf("poller still active after %v", max)
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

// decodeUsers decodes the "users" topic's composite payload and returns
// just its user list, for tests that only care about that part.
func decodeUsers(t *testing.T, data json.RawMessage) []telemt.UserInfo {
	t.Helper()
	return decodeUsersSnapshot(t, data).Users
}

func decodeUsersSnapshot(t *testing.T, data json.RawMessage) usersSnapshot {
	t.Helper()
	var snap usersSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode users snapshot: %v (data=%s)", err, data)
	}
	return snap
}

// TestUsersTopicComposite covers the composite payload backlog item 2
// requires (spec 02-hub-sse.md): the "users" topic must carry quota usage
// and quota_supported alongside the raw user list, degrading gracefully
// (quota: null, quota_supported: false) when the capability is absent
// rather than failing the topic.
func TestUsersTopicComposite(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "alice"}})
	f.setQuota(map[string]telemt.QuotaEntry{"alice": {DataQuotaBytes: 1024, UsedBytes: 512, LastResetEpochSecs: 100}})

	h := New(Config{UsersInterval: 20 * time.Millisecond, StatsInterval: time.Hour}, tc, nil)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	ev := <-ch
	snap := decodeUsersSnapshot(t, ev.Data)
	if len(snap.Users) != 1 || snap.Users[0].Username != "alice" {
		t.Fatalf("users = %+v", snap.Users)
	}
	if !snap.QuotaSupported {
		t.Fatal("quota_supported = false, want true")
	}
	alice, ok := snap.Quota["alice"]
	if !ok || alice.UsedBytes != 512 || alice.DataQuotaBytes != 1024 {
		t.Fatalf("quota[alice] = %+v, ok=%v", alice, ok)
	}
}

// TestUsersTopicDegradesQuotaWhenCapabilityAbsent covers the same composite
// topic on a Telemt build that predates the quota endpoint (fakeTelemt's
// default: quotaEnabled is false, serving 404) — the topic must still
// publish the user list, with quota explicit-null and quota_supported
// false, not a source_error.
func TestUsersTopicDegradesQuotaWhenCapabilityAbsent(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "alice"}})

	h := New(Config{UsersInterval: 20 * time.Millisecond, StatsInterval: time.Hour}, tc, nil)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	ev := <-ch
	if ev.Err != "" {
		t.Fatalf("event = %+v, want a snapshot, not a source_error", ev)
	}
	snap := decodeUsersSnapshot(t, ev.Data)
	if len(snap.Users) != 1 || snap.Users[0].Username != "alice" {
		t.Fatalf("users = %+v", snap.Users)
	}
	if snap.QuotaSupported {
		t.Fatal("quota_supported = true, want false (capability absent)")
	}
	if snap.Quota != nil {
		t.Fatalf("quota = %+v, want nil", snap.Quota)
	}
	if !bytes.Contains(ev.Data, []byte(`"quota":null`)) {
		t.Fatalf("data = %s, want an explicit quota:null, not an omitted key", ev.Data)
	}
}

func TestUnknownTopicRejected(t *testing.T) {
	_, tc := newFakeTelemt(t)
	h := New(Config{}, tc, nil)
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
	h := New(Config{UsersInterval: interval, StatsInterval: time.Hour, Grace: 200 * time.Millisecond}, tc, nil)
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
	h := New(Config{UsersInterval: interval, StatsInterval: time.Hour, Grace: time.Second}, tc, nil)
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

	h := New(Config{UsersInterval: 15 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second}, tc, nil)
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

	h := New(Config{UsersInterval: 5 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second, ReplayRingSize: 2}, tc, nil)
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

	h := New(Config{UsersInterval: 5 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second}, tc, nil)
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

	h := New(Config{UsersInterval: 10 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second, SubscriberBuffer: 1}, tc, nil)
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
	h := New(Config{UsersInterval: interval, StatsInterval: time.Hour, Grace: grace}, tc, nil)
	t.Cleanup(h.Close)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	recvEvent(t, ch, time.Second)
	cancel()

	// The poller legitimately keeps running through the grace window; wait
	// for real silence instead of a fixed wall-clock drain so the test
	// stays deterministic under race-detector slowdown (quiet is 30x the
	// poll interval — a live poller cannot stay silent that long even at
	// 20x slowdown).
	f.drainUntilQuiet(t, 30*interval, 5*time.Second)

	// Once quiet, it must have stopped for good.
	f.assertNoRequest(t, "/v1/users", 30*interval)
}

func TestSourceErrorOnUpstream500AndRecovery(t *testing.T) {
	f, tc := newFakeTelemt(t)
	f.setUsersFailing(true)

	h := New(Config{UsersInterval: 10 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second}, tc, nil)
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

	h := New(Config{UsersInterval: time.Hour, StatsInterval: 10 * time.Millisecond, Grace: time.Second}, tc, nil)
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
	h := New(Config{UsersInterval: time.Hour, StatsInterval: interval, Grace: time.Second}, tc, nil)
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

	h := New(Config{}, tc, nil)
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

	h := New(Config{}, tc, nil)
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

	h := New(Config{UsersInterval: 10 * time.Millisecond, StatsInterval: time.Hour, Grace: time.Second}, tc, nil)

	ch, _, cancel, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	recvEvent(t, ch, time.Second)

	h.Close()

	drainUntilClosed(t, ch, time.Second)
	// One fetch may already have been in flight when Close ran; absorb any
	// stragglers by waiting for real silence (30x the poll interval), which
	// stays deterministic under race-detector slowdown, then assert.
	f.drainUntilQuiet(t, 300*time.Millisecond, 5*time.Second)
	f.assertNoRequest(t, "/v1/users", 300*time.Millisecond)
}
