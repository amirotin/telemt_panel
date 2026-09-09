package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
	"github.com/amirotin/telemt_panel/internal/telemt/telemttest"
)

func TestPollTimeoutDefaultsToFifteenSeconds(t *testing.T) {
	if got := (Config{}).withDefaults().PollTimeout; got != 15*time.Second {
		t.Fatalf("PollTimeout = %v, want 15s", got)
	}
}

type pollDeadlineFixture struct {
	mu        sync.Mutex
	upstream  *telemttest.Server
	server    *httptest.Server
	blocked   map[string]<-chan struct{}
	started   chan string
	completed chan string
	paths     []string
	inFlight  int
	maxFlight int
}

func newPollDeadlineFixture(t *testing.T) (*pollDeadlineFixture, *telemt.Client) {
	return newPollDeadlineFixtureWithCache(t, true)
}

func newColdPollDeadlineFixture(t *testing.T) (*pollDeadlineFixture, *telemt.Client) {
	return newPollDeadlineFixtureWithCache(t, false)
}

func newPollDeadlineFixtureWithCache(t *testing.T, warmCapabilities bool) (*pollDeadlineFixture, *telemt.Client) {
	t.Helper()
	f := &pollDeadlineFixture{
		upstream:  telemttest.New(telemttest.Scenario{}),
		blocked:   make(map[string]<-chan struct{}),
		started:   make(chan string, 128),
		completed: make(chan string, 128),
	}
	t.Cleanup(f.upstream.Close)
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		release := f.blocked[r.URL.Path]
		f.paths = append(f.paths, r.URL.Path)
		f.inFlight++
		if f.inFlight > f.maxFlight {
			f.maxFlight = f.inFlight
		}
		f.mu.Unlock()
		f.started <- r.URL.Path
		defer func() {
			f.mu.Lock()
			f.inFlight--
			f.mu.Unlock()
		}()
		if release != nil {
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		f.upstream.Handler().ServeHTTP(w, r)
		f.completed <- r.URL.Path
	}))
	t.Cleanup(f.server.Close)
	client := telemt.New(f.server.URL, "")
	if warmCapabilities {
		if _, err := client.Capabilities(context.Background()); err != nil {
			t.Fatalf("warm capabilities: %v", err)
		}
		f.reset()
	}
	return f, client
}

func (f *pollDeadlineFixture) reset() {
	f.mu.Lock()
	f.paths = nil
	f.maxFlight = 0
	f.mu.Unlock()
	for {
		select {
		case <-f.started:
		default:
			goto completed
		}
	}

completed:
	for {
		select {
		case <-f.completed:
		default:
			return
		}
	}
}

func (f *pollDeadlineFixture) awaitCompleted(t *testing.T, paths ...string) {
	t.Helper()
	want := make(map[string]bool, len(paths))
	for _, path := range paths {
		want[path] = true
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for len(want) > 0 {
		select {
		case path := <-f.completed:
			delete(want, path)
		case <-timer.C:
			t.Fatalf("requests did not complete: %v", want)
		}
	}
}

func (f *pollDeadlineFixture) block(paths ...string) func() {
	release := make(chan struct{})
	f.mu.Lock()
	for _, path := range paths {
		f.blocked[path] = release
	}
	f.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { close(release) }) }
}

func (f *pollDeadlineFixture) awaitStarted(t *testing.T, paths ...string) {
	t.Helper()
	want := make(map[string]bool, len(paths))
	for _, path := range paths {
		want[path] = true
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for len(want) > 0 {
		select {
		case path := <-f.started:
			delete(want, path)
		case <-timer.C:
			t.Fatalf("requests did not start: %v", want)
		}
	}
}

func (f *pollDeadlineFixture) activity() ([]string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.paths...), f.maxFlight
}

func pollTopic(t *testing.T, ctx context.Context, h *Hub, topic string) <-chan bool {
	t.Helper()
	done := make(chan bool, 1)
	go func() { done <- h.pollWithContext(ctx, h.topics[topic]) }()
	return done
}

func awaitPoll(t *testing.T, done <-chan bool, within time.Duration) bool {
	t.Helper()
	timer := time.NewTimer(within)
	defer timer.Stop()
	select {
	case ok := <-done:
		return ok
	case <-timer.C:
		t.Fatalf("poll did not finish within %v", within)
		return false
	}
}

func topicData(t *testing.T, h *Hub, topic string) json.RawMessage {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	return append(json.RawMessage(nil), h.topics[topic].lastData...)
}

func TestStatsPollPreservesReadyAndSummaryWhenHealthTimesOut(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	release := fixture.block("/v1/health")
	defer release()
	releaseSuccessful := fixture.block("/v1/stats/summary", "/v1/health/ready")
	defer releaseSuccessful()
	const budget = 100 * time.Millisecond
	h := New(Config{PollTimeout: budget}, client, nil)
	defer h.Close()
	guard, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	done := pollTopic(t, guard, h, "stats")
	// Prove overlap explicitly: fast sources may otherwise finish before the
	// blocked health request starts, regardless of the client's concurrency.
	fixture.awaitStarted(t, "/v1/health", "/v1/stats/summary", "/v1/health/ready")
	releaseSuccessful()
	if !awaitPoll(t, done, 5*budget) {
		t.Fatal("stats poll failed despite two successful primary sources")
	}
	var snap statsSnapshot
	if err := json.Unmarshal(topicData(t, h, "stats"), &snap); err != nil {
		t.Fatal(err)
	}
	if snap.Health != nil || snap.Summary == nil || snap.Ready == nil {
		t.Fatalf("stats snapshot = %+v, want nil health with summary and ready", snap)
	}
	_, maxFlight := fixture.activity()
	if maxFlight <= 1 || maxFlight > 3 {
		t.Fatalf("max in-flight = %d, want 2..3", maxFlight)
	}
}

func TestStatsPollAllPrimaryTimeoutRecordsOneSourceError(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	release := fixture.block("/v1/health", "/v1/stats/summary", "/v1/health/ready")
	defer release()
	const budget = 100 * time.Millisecond
	h := New(Config{PollTimeout: budget}, client, nil)
	defer h.Close()
	guard, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	done := pollTopic(t, guard, h, "stats")
	fixture.awaitStarted(t, "/v1/health", "/v1/stats/summary", "/v1/health/ready")
	if awaitPoll(t, done, 5*budget) {
		t.Fatal("stats poll succeeded with every primary source blocked")
	}
	h.mu.Lock()
	ring := append([]Event(nil), h.ring...)
	h.mu.Unlock()
	if len(ring) != 1 || ring[0].Topic != "stats" || ring[0].Err != sourceErrorCode {
		t.Fatalf("ring = %+v, want one stats source_error", ring)
	}
	_, maxFlight := fixture.activity()
	if maxFlight != 3 {
		t.Fatalf("max in-flight = %d, want 3", maxFlight)
	}
}

func TestRuntimePollNeverExceedsThreeSDKCalls(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	release := fixture.block(
		"/v1/runtime/gates", "/v1/runtime/upstream-quality", "/v1/runtime/initialization",
		"/v1/runtime/me-pool-state", "/v1/runtime/me-quality", "/v1/runtime/nat-stun",
		"/v1/runtime/me-selftest", "/v1/stats/minimal/all",
	)
	defer release()
	const budget = 100 * time.Millisecond
	h := New(Config{PollTimeout: budget}, client, nil)
	defer h.Close()
	guard, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	done := pollTopic(t, guard, h, "runtime")
	fixture.awaitStarted(t, "/v1/runtime/gates", "/v1/runtime/upstream-quality", "/v1/runtime/initialization")
	if awaitPoll(t, done, 5*budget) {
		t.Fatal("runtime poll succeeded with every attempted required source blocked")
	}
	_, maxFlight := fixture.activity()
	if maxFlight <= 1 || maxFlight > 3 {
		t.Fatalf("max in-flight = %d, want 2..3", maxFlight)
	}
}

func TestParentCancellationDoesNotRecordTelemtOutage(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	release := fixture.block("/v1/health", "/v1/stats/summary", "/v1/health/ready")
	defer release()
	h := New(Config{PollTimeout: time.Second}, client, nil)
	defer h.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := pollTopic(t, ctx, h, "stats")
	fixture.awaitStarted(t, "/v1/health", "/v1/stats/summary", "/v1/health/ready")
	cancel()
	if awaitPoll(t, done, 250*time.Millisecond) {
		t.Fatal("canceled stats poll succeeded")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.ring) != 0 {
		t.Fatalf("caller cancellation recorded availability history: %+v", h.ring)
	}
}

func TestEarlierRequestDeadlineDoesNotRecordTelemtOutage(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	release := fixture.block("/v1/health", "/v1/stats/summary", "/v1/health/ready")
	defer release()
	h := New(Config{PollTimeout: time.Second}, client, nil)
	defer h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	done := pollTopic(t, ctx, h, "stats")
	fixture.awaitStarted(t, "/v1/health", "/v1/stats/summary", "/v1/health/ready")
	if awaitPoll(t, done, 750*time.Millisecond) {
		t.Fatal("request-deadline stats poll succeeded")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.ring) != 0 {
		t.Fatalf("request deadline recorded availability history: %+v", h.ring)
	}
}

func TestHubShutdownDoesNotRecordTelemtOutage(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	release := fixture.block("/v1/health", "/v1/stats/summary", "/v1/health/ready")
	defer release()
	h := New(Config{PollTimeout: time.Second}, client, nil)
	done := make(chan bool, 1)
	go func() { done <- h.poll(h.topics["stats"]) }()
	fixture.awaitStarted(t, "/v1/health", "/v1/stats/summary", "/v1/health/ready")
	h.Close()
	if awaitPoll(t, done, 250*time.Millisecond) {
		t.Fatal("shutdown stats poll succeeded")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.ring) != 0 {
		t.Fatalf("hub shutdown recorded availability history: %+v", h.ring)
	}
}

func TestUsersQuotaTimeoutKeepsSuccessfulUsers(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	release := fixture.block("/v1/stats/users/quota")
	defer release()
	const budget = 100 * time.Millisecond
	h := New(Config{PollTimeout: budget}, client, nil)
	defer h.Close()
	guard, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	done := pollTopic(t, guard, h, "users")
	fixture.awaitStarted(t, "/v1/users", "/v1/stats/users/quota")
	if !awaitPoll(t, done, 5*budget) {
		t.Fatal("users poll failed because optional quota timed out")
	}
	var snap usersSnapshot
	if err := json.Unmarshal(topicData(t, h, "users"), &snap); err != nil {
		t.Fatal(err)
	}
	if snap.Users == nil || snap.Quota != nil || snap.QuotaSupported {
		t.Fatalf("users snapshot = %+v, want users with unavailable quota", snap)
	}
}

func TestTrafficCollectorRemainsSequentialAndCoherent(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	memory, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer memory.Close()
	h := New(Config{PollTimeout: time.Nanosecond}, client, memory)
	defer h.Close()
	if !h.collectUserTraffic(context.Background()) {
		t.Fatal("coherent traffic collection failed")
	}
	paths, maxFlight := fixture.activity()
	want := []string{"/v1/system/info", "/v1/security/posture", "/v1/users", "/v1/system/info"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("traffic paths = %v, want %v", paths, want)
	}
	if maxFlight != 1 {
		t.Fatalf("traffic max in-flight = %d, want 1", maxFlight)
	}
}

func TestPollTimeoutStartsAfterWaitingForTopicGate(t *testing.T) {
	fixture, client := newPollDeadlineFixture(t)
	const budget = 50 * time.Millisecond
	h := New(Config{PollTimeout: budget}, client, nil)
	defer h.Close()
	topic := h.topics["stats"]
	if !acquireTopicGate(context.Background(), topic.pollGate) {
		t.Fatal("acquire test topic gate")
	}
	released := false
	defer func() {
		if !released {
			releaseTopicGate(topic.pollGate)
		}
	}()
	guard, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := pollTopic(t, guard, h, "stats")

	// Hold the gate longer than the configured fetch budget. The request-start
	// barriers below prove that the full budget is created only after release.
	hold, stopHold := context.WithTimeout(context.Background(), 3*budget)
	<-hold.Done()
	stopHold()
	releaseTopicGate(topic.pollGate)
	released = true
	fixture.awaitStarted(t, "/v1/health", "/v1/stats/summary", "/v1/health/ready")
	if !awaitPoll(t, done, 5*budget) {
		t.Fatal("stats poll spent its fetch budget while waiting for the topic gate")
	}
}

func TestHealthyStatsPollDoesNotWaitPastBudgetForColdCapabilityLeader(t *testing.T) {
	fixture, client := newColdPollDeadlineFixture(t)
	releaseLeader := fixture.block("/v1/stats/users/quota")
	defer releaseLeader()
	leaderDone := make(chan error, 1)
	go func() {
		_, err := client.Capabilities(context.Background())
		leaderDone <- err
	}()
	fixture.awaitStarted(t, "/v1/stats/users/quota")
	const budget = 100 * time.Millisecond
	h := New(Config{PollTimeout: budget}, client, nil)
	defer h.Close()
	guard, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := pollTopic(t, guard, h, "stats")
	fixture.awaitStarted(t, "/v1/health", "/v1/stats/summary", "/v1/health/ready")
	if !awaitPoll(t, done, 5*budget) {
		t.Fatal("healthy stats primaries were lost behind capability single-flight")
	}
	select {
	case err := <-leaderDone:
		t.Fatalf("cold-cache leader returned before release: %v", err)
	default:
	}
	var snap statsSnapshot
	if err := json.Unmarshal(topicData(t, h, "stats"), &snap); err != nil {
		t.Fatal(err)
	}
	if snap.Health == nil || snap.Summary == nil || snap.Ready == nil {
		t.Fatalf("stats snapshot = %+v, want all successful primaries", snap)
	}
	releaseLeader()
	if err := <-leaderDone; err != nil {
		t.Fatalf("cold-cache leader: %v", err)
	}
}

func TestCanceledStatsPartialDoesNotCommitObservation(t *testing.T) {
	for _, cancelKind := range []string{"parent", "hub shutdown"} {
		t.Run(cancelKind, func(t *testing.T) {
			fixture, client := newPollDeadlineFixture(t)
			memory, err := store.NewMemory("")
			if err != nil {
				t.Fatal(err)
			}
			defer memory.Close()
			capture := &historyCapture{HistoryStore: memory}
			h := New(Config{PollTimeout: time.Second}, client, capture)
			closed := false
			defer func() {
				if !closed {
					h.Close()
				}
			}()
			var historyCalls atomic.Int32
			h.historyRecordedHook = func() { historyCalls.Add(1) }
			if !h.pollWithContext(context.Background(), h.topics["stats"]) {
				t.Fatal("initial stats poll failed")
			}
			fixture.reset()

			h.mu.Lock()
			topic := h.topics["stats"]
			beforeData := append(json.RawMessage(nil), topic.lastData...)
			beforeSeq := h.seq
			beforeRing := len(h.ring)
			beforeVersion := topic.fullVersion
			beforeObservedAt := topic.lastObservedAt
			beforeFresh := topic.fullFresh
			h.mu.Unlock()
			beforeMetrics := len(capture.metrics)
			beforeHistoryCalls := historyCalls.Load()
			beforeEvents := len(historyEvents(t, memory))

			releaseHealth := fixture.block("/v1/health")
			defer releaseHealth()
			var done <-chan bool
			var cancel context.CancelFunc
			if cancelKind == "parent" {
				var ctx context.Context
				ctx, cancel = context.WithCancel(context.Background())
				defer cancel()
				done = pollTopic(t, ctx, h, "stats")
			} else {
				result := make(chan bool, 1)
				go func() { result <- h.poll(h.topics["stats"]) }()
				done = result
			}
			fixture.awaitStarted(t, "/v1/health", "/v1/stats/summary", "/v1/health/ready")
			fixture.awaitCompleted(t, "/v1/stats/summary", "/v1/health/ready")
			if cancelKind == "parent" {
				cancel()
			} else {
				h.Close()
				closed = true
			}
			if awaitPoll(t, done, 500*time.Millisecond) {
				t.Error("canceled partial poll reported success")
			}

			h.mu.Lock()
			afterData := append(json.RawMessage(nil), topic.lastData...)
			afterSeq := h.seq
			afterRing := len(h.ring)
			afterVersion := topic.fullVersion
			afterObservedAt := topic.lastObservedAt
			afterFresh := topic.fullFresh
			h.mu.Unlock()
			if !bytes.Equal(afterData, beforeData) || afterSeq != beforeSeq || afterRing != beforeRing {
				t.Errorf("canceled poll changed payload/replay state: data_equal=%v seq=%d/%d ring=%d/%d",
					bytes.Equal(afterData, beforeData), afterSeq, beforeSeq, afterRing, beforeRing)
			}
			if afterVersion != beforeVersion || !afterObservedAt.Equal(beforeObservedAt) || afterFresh != beforeFresh {
				t.Errorf("canceled poll changed freshness: version=%d/%d observed=%v/%v fresh=%v/%v",
					afterVersion, beforeVersion, afterObservedAt, beforeObservedAt, afterFresh, beforeFresh)
			}
			if len(capture.metrics) != beforeMetrics || historyCalls.Load() != beforeHistoryCalls || len(historyEvents(t, memory)) != beforeEvents {
				t.Errorf("canceled poll recorded history: metrics=%d/%d hooks=%d/%d events=%d/%d",
					len(capture.metrics), beforeMetrics, historyCalls.Load(), beforeHistoryCalls, len(historyEvents(t, memory)), beforeEvents)
			}
		})
	}
}
