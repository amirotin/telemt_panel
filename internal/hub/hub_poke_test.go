package hub

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// fakeClock is a thread-safe injectable clock for Hub.now: written from the
// test goroutine, read from the poller goroutine (runPoller's floor check
// in the <-t.wake case) — a plain time.Time field would race under -race.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock(start time.Time) *fakeClock {
	return &fakeClock{now: start}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// fakePokeTimer is a test double for Hub.scheduleTimer (same shape as
// store.Memory's own fakeTimer in memory_test.go): records how often it
// was armed and hands back the pending callback so a test can fire it
// deterministically instead of waiting on a real timer.
type fakePokeTimer struct {
	mu        sync.Mutex
	scheduled int
	pending   func()
}

func (f *fakePokeTimer) schedule(_ time.Duration, cb func()) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scheduled++
	f.pending = cb
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.pending = nil
	}
}

func (f *fakePokeTimer) fire() {
	f.mu.Lock()
	cb := f.pending
	f.pending = nil
	f.mu.Unlock()
	if cb != nil {
		cb()
	}
}

func (f *fakePokeTimer) scheduledCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.scheduled
}

// newPokeTestHub builds a Hub against fakeTelemt with every interval long
// enough (1h) that only Poke — never the normal interval timer — could be
// responsible for any fetch observed during a test.
func newPokeTestHub(t *testing.T) (*fakeTelemt, *Hub) {
	t.Helper()
	f, tc := newFakeTelemt(t)
	f.setUsers([]telemt.UserInfo{{Username: "alice"}})
	h := New(Config{UsersInterval: time.Hour, StatsInterval: time.Hour, Grace: time.Second}, tc, nil)
	t.Cleanup(h.Close)
	return f, h
}

// subscribeDrainInitial subscribes to topic, waits for the immediate
// on-start poll's broadcast, and drains its underlying requests from f — so
// a subsequent Poke's request count isn't inflated by the initial poll's
// own traffic.
func subscribeDrainInitial(t *testing.T, f *fakeTelemt, h *Hub, topic string) <-chan Event {
	t.Helper()
	ch, _, cancel, err := h.Subscribe([]string{topic})
	if err != nil {
		t.Fatalf("Subscribe(%q): %v", topic, err)
	}
	t.Cleanup(cancel)
	recvEvent(t, ch, 2*time.Second)
	f.drainUntilQuiet(t, 30*time.Millisecond, time.Second)
	return ch
}

// TestPoke_ChangedDataBroadcasts covers the core deliverable: Poke on a
// subscribed topic triggers exactly one extra fetch and, since the data
// actually changed, one more broadcast.
func TestPoke_ChangedDataBroadcasts(t *testing.T) {
	f, h := newPokeTestHub(t)
	ch := subscribeDrainInitial(t, f, h, "users")

	f.setUsers([]telemt.UserInfo{{Username: "bob"}})
	if err := h.Poke("users"); err != nil {
		t.Fatalf("Poke: %v", err)
	}

	ev := recvEvent(t, ch, time.Second)
	if got := decodeUsers(t, ev.Data); len(got) != 1 || got[0].Username != "bob" {
		t.Fatalf("event data = %s, want bob", ev.Data)
	}
	if n := f.countRequests("/v1/users", 100*time.Millisecond); n != 1 {
		t.Fatalf("requests to /v1/users after Poke = %d, want 1", n)
	}
}

// TestPoke_UnchangedDataNoBroadcast covers the other half: Poke still
// fetches (the poll happens through the normal recordFetchSuccess path),
// but diffKey finds nothing changed, so no event goes out.
func TestPoke_UnchangedDataNoBroadcast(t *testing.T) {
	f, h := newPokeTestHub(t)
	ch := subscribeDrainInitial(t, f, h, "users")

	// No change to the fake's data between the initial poll and this Poke.
	if err := h.Poke("users"); err != nil {
		t.Fatalf("Poke: %v", err)
	}

	// The fetch itself still has to happen (Poke doesn't know in advance
	// whether the data changed) — assert that, then assert no broadcast.
	f.awaitRequest(t, "/v1/users", time.Second)
	assertNoBroadcast(t, ch, 100*time.Millisecond)
}

// TestPoke_TwoRapidPokesCoalesce covers coalescing: two Poke calls placed
// back to back (before the poller goroutine can have processed the first
// one) must not result in two separate forced fetches — the second call's
// non-blocking send onto the already-full wake channel is dropped.
func TestPoke_TwoRapidPokesCoalesce(t *testing.T) {
	f, h := newPokeTestHub(t)
	ch := subscribeDrainInitial(t, f, h, "users")

	f.setUsers([]telemt.UserInfo{{Username: "bob"}})
	if err := h.Poke("users"); err != nil {
		t.Fatalf("Poke 1: %v", err)
	}
	if err := h.Poke("users"); err != nil {
		t.Fatalf("Poke 2: %v", err)
	}

	ev := recvEvent(t, ch, time.Second)
	if got := decodeUsers(t, ev.Data); len(got) != 1 || got[0].Username != "bob" {
		t.Fatalf("event data = %s, want bob", ev.Data)
	}
	// Give the poller a bounded window to prove it does NOT fetch a second
	// time — countRequests blocks for the window either way.
	if n := f.countRequests("/v1/users", 100*time.Millisecond); n != 1 {
		t.Fatalf("requests to /v1/users after two rapid pokes = %d, want 1 (coalesced)", n)
	}
}

// TestPoke_FloorRespected covers the poke floor (Config.PokeFloor,
// default/here-configured 500ms): a second forced poll requested before
// the floor elapses is dropped entirely (not queued for later), and one
// requested after the floor elapses goes through. Uses the injectable
// Hub.now instead of a real wait.
func TestPoke_FloorRespected(t *testing.T) {
	f, h := newPokeTestHub(t)
	clock := newFakeClock(time.Unix(1_700_000_000, 0))
	h.now = clock.Now
	ch := subscribeDrainInitial(t, f, h, "users")

	// First poke: topicState.lastForcedPollAt is still its zero value, so
	// the floor check (h.now().Sub(zero) < floor) is false — it always
	// goes through regardless of the clock.
	f.setUsers([]telemt.UserInfo{{Username: "bob"}})
	if err := h.Poke("users"); err != nil {
		t.Fatalf("Poke 1: %v", err)
	}
	ev := recvEvent(t, ch, time.Second)
	if got := decodeUsers(t, ev.Data); got[0].Username != "bob" {
		t.Fatalf("event 1 data = %s, want bob", ev.Data)
	}
	f.drainUntilQuiet(t, 30*time.Millisecond, time.Second)

	// Second poke, same instant (clock not advanced) and different data:
	// within the 500ms floor of the first forced poll — dropped.
	f.setUsers([]telemt.UserInfo{{Username: "carol"}})
	if err := h.Poke("users"); err != nil {
		t.Fatalf("Poke 2: %v", err)
	}
	assertNoBroadcast(t, ch, 100*time.Millisecond)
	if n := f.countRequests("/v1/users", 50*time.Millisecond); n != 0 {
		t.Fatalf("requests to /v1/users for a within-floor poke = %d, want 0", n)
	}

	// Advance past the floor: the same still-pending data change (carol)
	// is now picked up by a poke.
	clock.Advance(501 * time.Millisecond)
	if err := h.Poke("users"); err != nil {
		t.Fatalf("Poke 3: %v", err)
	}
	ev = recvEvent(t, ch, time.Second)
	if got := decodeUsers(t, ev.Data); got[0].Username != "carol" {
		t.Fatalf("event after floor elapsed = %s, want carol", ev.Data)
	}
}

// TestPoke_UnsubscribedTopicDoesOneShotFetch covers the documented choice
// for a topic with no live poller (see Poke's doc comment): a one-shot
// synchronous fetch updates the cache, so a subsequent Snapshot (i.e. GET
// /api/snapshot) sees fresh data without needing a subscriber to show up
// first.
func TestPoke_UnsubscribedTopicDoesOneShotFetch(t *testing.T) {
	f, h := newPokeTestHub(t)
	f.setUsers([]telemt.UserInfo{{Username: "dave"}})

	if err := h.Poke("users"); err != nil {
		t.Fatalf("Poke: %v", err)
	}
	f.awaitRequest(t, "/v1/users", time.Second)

	snap, err := h.Snapshot(context.Background(), []string{"users"})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if got := decodeUsers(t, snap["users"]); len(got) != 1 || got[0].Username != "dave" {
		t.Fatalf("snapshot after Poke = %s, want dave", snap["users"])
	}
}

// TestPoke_UpdateTopicNoop covers the event-driven "update" topic: no
// poller and no polled cache exist for it, so Poke must no-op rather than
// panic on a nil t.fetch/t.wake.
func TestPoke_UpdateTopicNoop(t *testing.T) {
	_, h := newPokeTestHub(t)
	if err := h.Poke("update"); err != nil {
		t.Fatalf("Poke(update) = %v, want nil (no-op)", err)
	}
}

// TestPoke_UnknownTopicReturnsError covers the one real error case.
func TestPoke_UnknownTopicReturnsError(t *testing.T) {
	_, h := newPokeTestHub(t)
	err := h.Poke("bogus")
	var unknown *ErrUnknownTopic
	if !errors.As(err, &unknown) {
		t.Fatalf("Poke(bogus) = %v (%T), want *ErrUnknownTopic", err, err)
	}
}

// TestPokeAfter_FiresPokeOnSchedule covers PokeAfter: it must schedule
// through h.scheduleTimer rather than blocking the caller, and the
// scheduled callback, once fired, behaves exactly like a direct Poke call.
func TestPokeAfter_FiresPokeOnSchedule(t *testing.T) {
	f, h := newPokeTestHub(t)
	ch := subscribeDrainInitial(t, f, h, "users")

	timer := &fakePokeTimer{}
	h.scheduleTimer = timer.schedule

	f.setUsers([]telemt.UserInfo{{Username: "erin"}})
	h.PokeAfter("users", 150*time.Millisecond)

	if timer.scheduledCount() != 1 {
		t.Fatalf("scheduleTimer calls = %d, want 1", timer.scheduledCount())
	}
	// PokeAfter must not have polled yet — only once the fake timer fires.
	assertNoBroadcast(t, ch, 50*time.Millisecond)

	timer.fire()
	ev := recvEvent(t, ch, time.Second)
	if got := decodeUsers(t, ev.Data); got[0].Username != "erin" {
		t.Fatalf("event after firing the delayed poke = %s, want erin", ev.Data)
	}
}
