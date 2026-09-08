package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

type countedTelemtFixture struct {
	mu     sync.Mutex
	counts map[string]int
	block  *requestBlock
	server *telemttest.Server
}

type requestBlock struct {
	path    string
	claimed bool
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func newCountedTelemtFixture(t *testing.T) (*countedTelemtFixture, *telemt.Client) {
	t.Helper()
	upstream := telemttest.New(telemttest.Scenario{})
	t.Cleanup(upstream.Close)
	fixture := &countedTelemtFixture{counts: make(map[string]int), server: upstream}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.mu.Lock()
		fixture.counts[r.URL.Path]++
		block := fixture.block
		if block != nil && block.path == r.URL.Path && !block.claimed {
			block.claimed = true
		} else {
			block = nil
		}
		fixture.mu.Unlock()
		if block != nil {
			close(block.entered)
			<-block.release
		}
		upstream.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	client := telemt.New(server.URL, "")
	if _, err := client.Capabilities(context.Background()); err != nil {
		t.Fatalf("warm capabilities: %v", err)
	}
	fixture.reset()
	return fixture, client
}

func (f *countedTelemtFixture) setScenario(scenario telemttest.Scenario) {
	f.server.SetScenario(scenario)
}

func (f *countedTelemtFixture) blockNext(path string) (<-chan struct{}, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	block := &requestBlock{path: path, entered: make(chan struct{}), release: make(chan struct{})}
	f.block = block
	return block.entered, func() { block.once.Do(func() { close(block.release) }) }
}

func (f *countedTelemtFixture) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.counts = make(map[string]int)
}

func (f *countedTelemtFixture) snapshot() map[string]int {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]int, len(f.counts))
	for path, count := range f.counts {
		out[path] = count
	}
	return out
}

func totalRequests(counts map[string]int) int {
	total := 0
	for _, count := range counts {
		total += count
	}
	return total
}

func TestPeriodicHistoryProfilesSourceCallsPerCompletedCycle(t *testing.T) {
	want := map[string]map[int]int{
		"users":     {0: 1, 1: 2, 3: 2},
		"stats":     {0: 3, 1: 4, 3: 4},
		"runtime":   {0: 2, 1: 8, 3: 8},
		"upstreams": {0: 1, 1: 3, 3: 3},
	}
	for topic, bySubscribers := range want {
		for subscribers, wantCalls := range bySubscribers {
			t.Run(topic+"/subscribers="+strconv.Itoa(subscribers), func(t *testing.T) {
				fixture, client := newCountedTelemtFixture(t)
				memory, err := store.NewMemory("")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { memory.Close() })
				h := New(Config{
					UsersInterval:       time.Hour,
					StatsInterval:       time.Hour,
					RuntimeInterval:     time.Hour,
					UpstreamsInterval:   time.Hour,
					StatsSysInfoRefresh: time.Hour,
					Grace:               time.Hour,
					SubscriberBuffer:    16,
				}, client, memory)
				t.Cleanup(h.Close)

				state := h.topics[topic]
				state.running = true
				state.stop = make(chan struct{})
				var cancels []func()
				for range subscribers {
					_, _, cancel, err := h.Subscribe([]string{topic})
					if err != nil {
						t.Fatal(err)
					}
					cancels = append(cancels, cancel)
				}
				defer func() {
					for _, cancel := range cancels {
						cancel()
					}
				}()
				if topic == "users" {
					h.ips.windowChecked = h.now().Unix()
				}

				if !h.pollPeriodic(state) {
					t.Fatal("completed cycle failed")
				}
				counts := fixture.snapshot()
				if got := totalRequests(counts); got != wantCalls {
					t.Errorf("source calls = %d, want %d; paths=%v", got, wantCalls, counts)
				}
			})
		}
	}
}

type historySummaryCounter struct {
	store.HistoryStore
	mu               sync.Mutex
	trafficSummaries int
	ipSummaries      int
	ipStateReads     int
}

func (s *historySummaryCounter) UserTrafficSummaries() (map[string]store.UserTrafficSummary, error) {
	s.mu.Lock()
	s.trafficSummaries++
	s.mu.Unlock()
	return s.HistoryStore.UserTrafficSummaries()
}

func (s *historySummaryCounter) UserIPSummaries(from, now int64) (map[string]int64, error) {
	s.mu.Lock()
	s.ipSummaries++
	s.mu.Unlock()
	return s.HistoryStore.UserIPSummaries(from, now)
}

func (s *historySummaryCounter) UserIPCollectionState() (store.UserIPCollection, error) {
	s.mu.Lock()
	s.ipStateReads++
	s.mu.Unlock()
	return s.HistoryStore.UserIPCollectionState()
}

func TestBackgroundUsersSkipsProjectionSummaryReads(t *testing.T) {
	_, client := newCountedTelemtFixture(t)
	memory, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { memory.Close() })
	counted := &historySummaryCounter{HistoryStore: memory}
	h := New(Config{UsersInterval: time.Hour}, client, counted)
	t.Cleanup(h.Close)
	h.ips.windowChecked = h.now().Unix()

	if !h.pollPeriodic(h.topics["users"]) {
		t.Fatal("background users cycle failed")
	}
	counted.mu.Lock()
	defer counted.mu.Unlock()
	if counted.trafficSummaries != 0 || counted.ipSummaries != 0 || counted.ipStateReads != 1 {
		t.Fatalf("summary/collector-state reads: traffic=%d ip=%d state=%d, want 0/0/1", counted.trafficSummaries, counted.ipSummaries, counted.ipStateReads)
	}
	if gauges, ok := h.cachedUsersLiveGauges(); !ok || gauges.connections != 2 || gauges.activeUsers != 1 {
		t.Fatalf("live gauges = %+v, %v", gauges, ok)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.topics["users"].hasData || len(h.ring) != 0 || h.seq != 0 {
		t.Fatalf("history-only poll published UI state: hasData=%v ring=%d seq=%d", h.topics["users"].hasData, len(h.ring), h.seq)
	}
}

func awaitBarrier(t *testing.T, entered <-chan struct{}) {
	t.Helper()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for source barrier")
	}
}

func startTopicPoller(h *Hub, topic string) {
	h.mu.Lock()
	state := h.topics[topic]
	state.persistent = true
	state.running = true
	state.stop = make(chan struct{})
	h.wg.Add(1)
	h.mu.Unlock()
	go h.runPoller(state)
}

func TestSubscriberDuringMinimalPollReceivesOnlyFullProjection(t *testing.T) {
	for _, test := range []struct {
		topic      string
		blockPath  string
		assertFull func(*testing.T, json.RawMessage)
	}{
		{
			topic: "users", blockPath: "/v1/users",
			assertFull: func(t *testing.T, data json.RawMessage) {
				snap := decodeUsersSnapshot(t, data)
				if !snap.QuotaSupported || len(snap.Users) != 1 || snap.Users[0].IPHistory == nil || snap.Users[0].Traffic == nil {
					t.Fatalf("users hydration is not full: %+v", snap)
				}
			},
		},
		{
			topic: "runtime", blockPath: "/v1/runtime/gates",
			assertFull: func(t *testing.T, data json.RawMessage) {
				var snap runtimeSnapshot
				if err := json.Unmarshal(data, &snap); err != nil {
					t.Fatal(err)
				}
				if snap.Gates == nil || snap.Initialization == nil || snap.MePoolState == nil || snap.MeQuality == nil || snap.NatStun == nil || snap.MeSelfTest == nil || snap.Minimal == nil || snap.UpstreamQuality == nil {
					t.Fatalf("runtime hydration is not full: %+v", snap)
				}
			},
		},
		{
			topic: "upstreams", blockPath: "/v1/stats/dcs",
			assertFull: func(t *testing.T, data json.RawMessage) {
				var snap upstreamsSnapshot
				if err := json.Unmarshal(data, &snap); err != nil {
					t.Fatal(err)
				}
				if snap.Upstreams == nil || snap.DCs == nil || snap.MeWriters == nil {
					t.Fatalf("upstreams hydration is not full: %+v", snap)
				}
			},
		},
	} {
		t.Run(test.topic, func(t *testing.T) {
			fixture, client := newCountedTelemtFixture(t)
			memory, err := store.NewMemory("")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { memory.Close() })
			if _, err := memory.ApplyUserTrafficSnapshot(store.UserTrafficSnapshot{
				ObservedAt: 1_800_000_000, SourceStartedAt: 1_799_999_000, TelemetryEnabled: true,
				Users: []store.UserTrafficObservation{{Username: "alice", RawOctets: 100}},
			}); err != nil {
				t.Fatal(err)
			}
			h := New(Config{
				UsersInterval: time.Hour, StatsInterval: time.Hour, RuntimeInterval: time.Hour,
				UpstreamsInterval: time.Hour, TrafficInterval: time.Hour, Grace: time.Hour,
			}, client, memory)
			t.Cleanup(h.Close)
			h.ips.windowChecked = h.now().Unix()
			entered, release := fixture.blockNext(test.blockPath)
			h.topics[test.topic].lastForcedPollAt = h.now()
			startTopicPoller(h, test.topic)
			awaitBarrier(t, entered)

			ch, snapshots, cancel, err := h.Subscribe([]string{test.topic})
			if err != nil {
				t.Fatal(err)
			}
			defer cancel()
			if len(snapshots) != 0 {
				t.Fatalf("minimal poll exposed snapshots: %+v", snapshots)
			}
			release()
			event := recvEvent(t, ch, 2*time.Second)
			if event.Err != "" {
				t.Fatalf("first event is an error: %+v", event)
			}
			test.assertFull(t, event.Data)
		})
	}
}

func TestThreeSubscribersShareOneBarrieredFullCycle(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	h := New(Config{UsersInterval: time.Hour, Grace: time.Hour}, client, nil)
	t.Cleanup(h.Close)
	entered, release := fixture.blockNext("/v1/users")

	channels := make([]<-chan Event, 0, 3)
	cancels := make([]func(), 0, 3)
	for range 3 {
		ch, _, cancel, err := h.Subscribe([]string{"users"})
		if err != nil {
			t.Fatal(err)
		}
		channels = append(channels, ch)
		cancels = append(cancels, cancel)
	}
	defer func() {
		for _, cancel := range cancels {
			cancel()
		}
	}()
	awaitBarrier(t, entered)
	release()
	for _, ch := range channels {
		if event := recvEvent(t, ch, 2*time.Second); event.Err != "" || len(event.Data) == 0 {
			t.Fatalf("subscriber event = %+v", event)
		}
	}
	counts := fixture.snapshot()
	if counts["/v1/users"] != 1 || counts["/v1/stats/users/quota"] != 1 {
		t.Fatalf("three subscribers spawned duplicate fetches: %v", counts)
	}
}

func TestPersistentUsersRehydratesAfterSubscriberFreeMinimalCycle(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	memory, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { memory.Close() })
	h := New(Config{UsersInterval: time.Hour, Grace: time.Hour}, client, memory)
	t.Cleanup(h.Close)
	h.topics["users"].persistent = true
	h.ips.windowChecked = h.now().Unix()

	first, _, cancelFirst, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	if event := recvEvent(t, first, 2*time.Second); event.Err != "" {
		t.Fatalf("initial full event = %+v", event)
	}
	cancelFirst()

	fixture.reset()
	if !h.pollPeriodic(h.topics["users"]) {
		t.Fatal("subscriber-free cycle failed")
	}
	if counts := fixture.snapshot(); counts["/v1/users"] != 1 || counts["/v1/stats/users/quota"] != 0 {
		t.Fatalf("next subscriber-free persistent cycle was not minimal: %v", counts)
	}
	if _, _, err := client.CreateUser(context.Background(), telemt.CreateUserRequest{Username: "bob"}); err != nil {
		t.Fatal(err)
	}
	fixture.reset()

	second, snapshots, cancelSecond, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancelSecond()
	if len(snapshots) != 1 || len(decodeUsers(t, snapshots[0].Data)) != 1 {
		t.Fatalf("last-good full cache missing on reconnect: %+v", snapshots)
	}
	hydrated := recvEvent(t, second, 2*time.Second)
	if users := decodeUsers(t, hydrated.Data); len(users) != 2 {
		t.Fatalf("reconnect hydration users = %+v, want alice and bob", users)
	}
	if counts := fixture.snapshot(); counts["/v1/users"] != 1 || counts["/v1/stats/users/quota"] != 1 {
		t.Fatalf("last-good cache prevented one full hydration: %v", counts)
	}
}

func TestUnchangedFullHydrationRefreshesCachedProjection(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	fixture.setScenario(telemttest.Scenario{GeneratedAtEpochSecs: 1_000})
	memory, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { memory.Close() })
	h := New(Config{RuntimeInterval: time.Hour, Grace: time.Hour}, client, memory)
	t.Cleanup(h.Close)
	h.topics["runtime"].persistent = true

	first, _, cancelFirst, err := h.Subscribe([]string{"runtime"})
	if err != nil {
		t.Fatal(err)
	}
	initial := recvEvent(t, first, 2*time.Second)
	var initialSnapshot runtimeSnapshot
	if err := json.Unmarshal(initial.Data, &initialSnapshot); err != nil {
		t.Fatal(err)
	}
	if initialSnapshot.MePoolState == nil || initialSnapshot.MePoolState.GeneratedAtEpochSecs != 1_000 {
		t.Fatalf("initial generated_at = %+v", initialSnapshot.MePoolState)
	}
	cancelFirst()

	fixture.setScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2_000})
	if !h.pollPeriodic(h.topics["runtime"]) {
		t.Fatal("subscriber-free runtime history tick failed")
	}
	fixture.reset()
	second, stale, cancelSecond, err := h.Subscribe([]string{"runtime"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancelSecond()
	if len(stale) != 1 {
		t.Fatalf("cached reconnect snapshots = %+v", stale)
	}
	var staleSnapshot runtimeSnapshot
	if err := json.Unmarshal(stale[0].Data, &staleSnapshot); err != nil {
		t.Fatal(err)
	}
	if staleSnapshot.MePoolState == nil || staleSnapshot.MePoolState.GeneratedAtEpochSecs != 1_000 {
		t.Fatalf("pre-hydration cache = %+v", staleSnapshot.MePoolState)
	}

	snapshots, err := h.Snapshot(context.Background(), []string{"runtime"})
	if err != nil {
		t.Fatal(err)
	}
	var refreshed runtimeSnapshot
	if err := json.Unmarshal(snapshots["runtime"], &refreshed); err != nil {
		t.Fatal(err)
	}
	if refreshed.MePoolState == nil || refreshed.MePoolState.GeneratedAtEpochSecs != 2_000 {
		t.Fatalf("normalized-equal hydration left stale projection: %+v", refreshed.MePoolState)
	}
	hydrated := recvEvent(t, second, 2*time.Second)
	var hydratedSnapshot runtimeSnapshot
	if err := json.Unmarshal(hydrated.Data, &hydratedSnapshot); err != nil {
		t.Fatal(err)
	}
	if hydratedSnapshot.MePoolState == nil || hydratedSnapshot.MePoolState.GeneratedAtEpochSecs != 2_000 {
		t.Fatalf("subscriber did not receive fresh normalized-equal hydration: %+v", hydratedSnapshot.MePoolState)
	}
	if hydrated.Seq <= initial.Seq {
		t.Fatalf("hydration sequence = %d, want > initial %d", hydrated.Seq, initial.Seq)
	}
}

func TestPokeQueuedDuringHydrationRunsAfterFullCompletion(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	h := New(Config{UsersInterval: time.Hour, Grace: time.Hour}, client, nil)
	t.Cleanup(h.Close)
	h.topics["users"].persistent = true
	first, _, cancelFirst, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	if event := recvEvent(t, first, 2*time.Second); event.Err != "" {
		t.Fatalf("initial event = %+v", event)
	}
	cancelFirst()

	entered, release := fixture.blockNext("/v1/stats/users/quota")
	second, snapshots, cancelSecond, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancelSecond()
	if len(snapshots) != 1 {
		t.Fatalf("reconnect snapshots = %+v", snapshots)
	}
	awaitBarrier(t, entered)
	if _, _, err := client.CreateUser(context.Background(), telemt.CreateUserRequest{Username: "bob"}); err != nil {
		t.Fatal(err)
	}
	if err := h.Poke("users"); err != nil {
		t.Fatal(err)
	}
	release()

	hydrated := recvEvent(t, second, 2*time.Second)
	if users := decodeUsers(t, hydrated.Data); len(users) != 1 {
		t.Fatalf("hydration event = %+v, want pre-mutation full projection", users)
	}
	poked := recvEvent(t, second, 2*time.Second)
	if users := decodeUsers(t, poked.Data); len(users) != 2 {
		t.Fatalf("queued Poke was consumed by hydration completion: %+v", users)
	}
	counts := fixture.snapshot()
	if counts["/v1/users"] != 4 || counts["/v1/stats/users/quota"] != 3 {
		// /v1/users includes the fake mutation plus the initial full fetch,
		// hydration, and queued Poke; quota is fetched by the three full polls.
		t.Fatalf("source counts = %v, want four users and three quota calls", counts)
	}
}

func TestSnapshotCancellationWhileWaitingForTopicGateReturnsPromptly(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	memory, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { memory.Close() })
	h := New(Config{UsersInterval: time.Hour}, client, memory)
	t.Cleanup(h.Close)
	h.ips.windowChecked = h.now().Unix()
	entered, release := fixture.blockNext("/v1/users")
	cycleDone := make(chan struct{})
	go func() {
		h.pollPeriodic(h.topics["users"])
		close(cycleDone)
	}()
	awaitBarrier(t, entered)

	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	snapshotDone := make(chan struct{})
	go func() {
		close(started)
		_, _ = h.Snapshot(ctx, []string{"users"})
		close(snapshotDone)
	}()
	<-started
	cancel()
	select {
	case <-snapshotDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Snapshot did not honor cancellation while waiting for the topic gate")
	}
	release()
	select {
	case <-cycleDone:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked minimal cycle did not finish")
	}
}

func TestSnapshotDoesNotTreatHistoryTickAsFreshUI(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	memory, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { memory.Close() })
	h := New(Config{UsersInterval: time.Hour}, client, memory)
	t.Cleanup(h.Close)
	users := h.topics["users"]
	users.running = true
	users.stop = make(chan struct{})
	h.ips.windowChecked = h.now().Unix()
	if !h.pollWithContext(context.Background(), users) {
		t.Fatal("initial full poll failed")
	}
	if !h.pollPeriodic(users) {
		t.Fatal("history-only tick failed")
	}
	if _, _, err := client.CreateUser(context.Background(), telemt.CreateUserRequest{Username: "bob"}); err != nil {
		t.Fatal(err)
	}
	fixture.reset()

	snapshots, err := h.Snapshot(context.Background(), []string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	if users := decodeUsers(t, snapshots["users"]); len(users) != 2 {
		t.Fatalf("Snapshot returned stale full UI after history tick: %+v", users)
	}
	if counts := fixture.snapshot(); counts["/v1/users"] != 1 || counts["/v1/stats/users/quota"] != 1 {
		t.Fatalf("Snapshot did not perform one full hydration: %v", counts)
	}
}

func TestQueuedHistoryPollInvalidatesNewerFullProjection(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	fixture.setScenario(telemttest.Scenario{GeneratedAtEpochSecs: 1_000})
	h := New(Config{RuntimeInterval: time.Hour}, client, nil)
	t.Cleanup(h.Close)
	runtimeTopic := h.topics["runtime"]
	if !h.pollWithContext(context.Background(), runtimeTopic) {
		t.Fatal("initial full runtime poll failed")
	}
	runtimeTopic.running = true
	runtimeTopic.stop = make(chan struct{})
	fixture.setScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2_000})
	entered, release := fixture.blockNext("/v1/stats/minimal/all")
	fullDone := make(chan struct{})
	go func() {
		h.pollWithContext(context.Background(), runtimeTopic)
		close(fullDone)
	}()
	awaitBarrier(t, entered)
	historyDone := make(chan struct{})
	go func() {
		h.pollPeriodic(runtimeTopic)
		close(historyDone)
	}()
	fixture.setScenario(telemttest.Scenario{GeneratedAtEpochSecs: 3_000})
	release()
	for _, done := range []<-chan struct{}{fullDone, historyDone} {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("serialized poll did not finish")
		}
	}
	fixture.reset()

	snapshots, err := h.Snapshot(context.Background(), []string{"runtime"})
	if err != nil {
		t.Fatal(err)
	}
	var refreshed runtimeSnapshot
	if err := json.Unmarshal(snapshots["runtime"], &refreshed); err != nil {
		t.Fatal(err)
	}
	if refreshed.MePoolState == nil || refreshed.MePoolState.GeneratedAtEpochSecs != 3_000 {
		t.Fatalf("queued history poll left newer full cache falsely fresh: %+v", refreshed.MePoolState)
	}
	if counts := fixture.snapshot(); totalRequests(counts) != 8 {
		t.Fatalf("Snapshot full refresh source counts = %v, want one 8-call runtime projection", counts)
	}
}

func TestSnapshotRecheckSkipsDuplicateFullFetch(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	h := New(Config{UsersInterval: time.Hour}, client, nil)
	t.Cleanup(h.Close)
	users := h.topics["users"]
	previousVersion := users.fullVersion
	if !h.pollWithContext(context.Background(), users) {
		t.Fatal("winning full fetch failed")
	}
	fixture.reset()
	if !h.pollWithProfile(context.Background(), users, pollFull, recheckSnapshot, previousVersion) {
		t.Fatal("waiting Snapshot recheck failed")
	}
	if counts := fixture.snapshot(); len(counts) != 0 {
		t.Fatalf("Snapshot recheck duplicated a completed full fetch: %v", counts)
	}
}

func TestSnapshotSatisfyingQueuedSubscriberHydrationRunsOneFullCycle(t *testing.T) {
	fixture, client := newCountedTelemtFixture(t)
	h := New(Config{UsersInterval: time.Hour, Grace: time.Hour}, client, nil)
	t.Cleanup(h.Close)
	h.topics["users"].persistent = true

	initial, _, cancelInitial, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	if event := recvEvent(t, initial, 2*time.Second); event.Err != "" {
		t.Fatalf("initial event = %+v", event)
	}
	cancelInitial()
	fixture.reset()

	entered, release := fixture.blockNext("/v1/users")
	snapshotDone := make(chan error, 1)
	go func() {
		_, err := h.Snapshot(context.Background(), []string{"users"})
		snapshotDone <- err
	}()
	awaitBarrier(t, entered)

	subscriber, stale, cancelSubscriber, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancelSubscriber()
	if len(stale) != 1 {
		t.Fatalf("cached subscriber snapshots = %+v", stale)
	}

	// The subscriber wake initially fills the buffered channel. This send
	// completes only after runPoller consumes that wake and waits on the gate
	// held by Snapshot.
	firstWakeConsumed := make(chan struct{})
	go func() {
		select {
		case h.topics["users"].wake <- struct{}{}:
		case <-h.ctx.Done():
		}
		close(firstWakeConsumed)
	}()
	awaitBarrier(t, firstWakeConsumed)

	// The second marker remains buffered until the first wake operation has
	// completed. Filling its newly freed slot therefore provides a barrier for
	// the gated hydration recheck, without relying on sleeps or request QPS.
	wakeProcessed := make(chan struct{})
	go func() {
		select {
		case h.topics["users"].wake <- struct{}{}:
		case <-h.ctx.Done():
		}
		close(wakeProcessed)
	}()
	release()
	if err := <-snapshotDone; err != nil {
		t.Fatal(err)
	}
	if event := recvEvent(t, subscriber, 2*time.Second); event.Err != "" {
		t.Fatalf("hydration event = %+v", event)
	}
	awaitBarrier(t, wakeProcessed)

	if counts := fixture.snapshot(); counts["/v1/users"] != 1 || counts["/v1/stats/users/quota"] != 1 {
		t.Fatalf("satisfied hydration duplicated full source work: %v", counts)
	}
}

func TestHistoryFailureKeepsFullCacheAndInvalidatesUsersGauge(t *testing.T) {
	_, client := newCountedTelemtFixture(t)
	memory, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { memory.Close() })
	h := New(Config{UsersInterval: time.Hour}, client, memory)
	t.Cleanup(h.Close)
	users := h.topics["users"]
	if !h.pollWithContext(context.Background(), users) {
		t.Fatal("full users poll failed")
	}
	h.mu.Lock()
	data := append(json.RawMessage(nil), users.lastData...)
	key := append(json.RawMessage(nil), users.lastKey...)
	event := users.lastEvent
	seq := h.seq
	h.mu.Unlock()
	originalHistoryFetch := users.historyFetch
	users.historyFetch = func(context.Context) (any, error) {
		return nil, errors.New("users unavailable")
	}
	if h.pollPeriodic(users) {
		t.Fatal("history source failure succeeded")
	}
	h.mu.Lock()
	if !bytes.Equal(users.lastData, data) || !bytes.Equal(users.lastKey, key) || users.lastEvent.Seq != event.Seq || h.seq != seq || len(h.ring) != 1 {
		t.Fatalf("history failure changed UI cache/event state: topic=%+v seq=%d ring=%d", users, h.seq, len(h.ring))
	}
	h.mu.Unlock()
	if _, ok := h.cachedUsersLiveGauges(); ok {
		t.Fatal("failed users observation left gauges fresh")
	}
	users.historyFetch = originalHistoryFetch
	if !h.pollPeriodic(users) {
		t.Fatal("history recovery failed")
	}
	if gauges, ok := h.cachedUsersLiveGauges(); !ok || gauges.connections != 2 || gauges.activeUsers != 1 {
		t.Fatalf("recovered gauges = %+v, %v", gauges, ok)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.seq != seq || len(h.ring) != 1 {
		t.Fatalf("history recovery published UI state: seq=%d ring=%d", h.seq, len(h.ring))
	}
}
