package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
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

// newTelemttestHub builds a Hub against a telemttest.Server for the given
// scenario, with every interval fast enough for tests but no real sleeps
// beyond the poller's own timer — following hub_test.go's existing
// millisecond-interval convention. st may be nil (history tests pass a real
// store.Store; every other test doesn't care).
func newTelemttestHub(t *testing.T, scenario telemttest.Scenario, st store.Store) (*telemttest.Server, *Hub) {
	t.Helper()
	fake := telemttest.New(scenario)
	t.Cleanup(fake.Close)
	tc := telemt.New(fake.URL, "")
	h := New(Config{
		UsersInterval:     time.Hour,
		StatsInterval:     10 * time.Millisecond,
		RuntimeInterval:   10 * time.Millisecond,
		UpstreamsInterval: 10 * time.Millisecond,
		SecurityInterval:  10 * time.Millisecond,
		WebInterval:       10 * time.Millisecond,
		Grace:             time.Second,
	}, tc, st)
	t.Cleanup(h.Close)
	return fake, h
}

func subscribeAndAwait(t *testing.T, h *Hub, topic string) json.RawMessage {
	t.Helper()
	ch, _, cancel, err := h.Subscribe([]string{topic})
	if err != nil {
		t.Fatalf("Subscribe(%q): %v", topic, err)
	}
	defer cancel()
	ev := recvEvent(t, ch, 2*time.Second)
	if ev.Err != "" {
		t.Fatalf("topic %q: got source_error %q, want a snapshot", topic, ev.Err)
	}
	return ev.Data
}

// TestRuntimeTopicComposite covers deliverable A's "runtime" topic: the
// always-on Gates/Initialization flat group plus the four Gated[T] payloads,
// all present on telemttest's default (RuntimeEdge off) scenario —
// RecentEvents must be absent (omitempty) in that case.
func TestRuntimeTopicComposite(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{}, nil)
	data := subscribeAndAwait(t, h, "runtime")

	var snap runtimeSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode runtime snapshot: %v (data=%s)", err, data)
	}
	if snap.Gates == nil || snap.Initialization == nil {
		t.Errorf("runtime snapshot missing always-on fields: %+v", snap)
	}
	if snap.MePoolState == nil || snap.MeQuality == nil || snap.NatStun == nil || snap.MeSelfTest == nil {
		t.Errorf("runtime snapshot missing a Gated[T] field: %+v", snap)
	}
	// Minimal/UpstreamQuality (mini-task 2c): always attempted regardless
	// of runtime_edge, so both must be present (non-nil) even on the
	// default scenario — enabled true since MinimalRuntimeOff is false.
	if snap.Minimal == nil || !snap.Minimal.Enabled || snap.Minimal.Data == nil {
		t.Errorf("runtime snapshot minimal = %+v, want an enabled Gated payload", snap.Minimal)
	}
	if snap.UpstreamQuality == nil || !snap.UpstreamQuality.Enabled {
		t.Errorf("runtime snapshot upstream_quality = %+v, want enabled", snap.UpstreamQuality)
	}
	if snap.RecentEvents != nil {
		t.Errorf("runtime snapshot has recent_events with runtime_edge off, want omitted: %+v", snap.RecentEvents)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("decode runtime snapshot as map: %v", err)
	}
	if _, ok := raw["recent_events"]; ok {
		t.Error(`runtime snapshot JSON has a "recent_events" key with runtime_edge off, want it omitted entirely`)
	}
	// Unlike recent_events, minimal/upstream_quality are never omitted —
	// they're always attempted, so the keys are always present (null on
	// failure, per mini-task 2c's "failed sub-call -> field null" rule).
	for _, key := range []string{"minimal", "upstream_quality"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("runtime snapshot JSON missing key %q, want it always present", key)
		}
	}
}

// TestRuntimeTopicMinimalRuntimeOff covers the minimal_runtime_enabled
// gate's effect on the "runtime" topic: Minimal reports a closed Gated
// wrapper (data omitted) and none of this turns into a source_error.
// UpstreamQuality and the ME payloads stay OPEN — the flag gates the four
// /v1/stats/* routes and nothing in /v1/runtime/*, whose builders take no
// ApiConfig at all (telemt 3.5.5 src/api/runtime_min.rs).
func TestRuntimeTopicMinimalRuntimeOff(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{MinimalRuntimeOff: true}, nil)
	data := subscribeAndAwait(t, h, "runtime")

	var snap runtimeSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode runtime snapshot: %v (data=%s)", err, data)
	}
	if snap.Minimal == nil || snap.Minimal.Enabled || snap.Minimal.Data != nil {
		t.Errorf("runtime snapshot minimal = %+v, want a closed gate (enabled false, data nil)", snap.Minimal)
	}
	if snap.UpstreamQuality == nil || !snap.UpstreamQuality.Enabled {
		t.Errorf("runtime snapshot upstream_quality = %+v, want enabled true", snap.UpstreamQuality)
	}
	if snap.NatStun == nil || !snap.NatStun.Enabled {
		t.Errorf("runtime snapshot nat_stun = %+v, want enabled true", snap.NatStun)
	}
}

// TestRuntimeTopicMePoolDown covers the gate that DOES close the
// /v1/runtime/* ME payloads — the pool being absent — and the reason token
// it uses, which is what the panel maps to a different hint than the flag.
func TestRuntimeTopicMePoolDown(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{RuntimeEdge: true, MePoolDown: true}, nil)
	data := subscribeAndAwait(t, h, "runtime")

	var snap runtimeSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode runtime snapshot: %v (data=%s)", err, data)
	}
	if snap.NatStun == nil || snap.NatStun.Enabled || snap.NatStun.Reason != "source_unavailable" {
		t.Errorf("runtime snapshot nat_stun = %+v, want closed with source_unavailable", snap.NatStun)
	}
	if snap.MePoolState == nil || snap.MePoolState.Enabled {
		t.Errorf("runtime snapshot me_pool_state = %+v, want a closed gate", snap.MePoolState)
	}
}

// TestRuntimeTopicRecentEventsWhenRuntimeEdge covers the runtime_edge-gated
// half of the "runtime" topic: RecentEvents appears once the capability is
// on.
func TestRuntimeTopicRecentEventsWhenRuntimeEdge(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{RuntimeEdge: true}, nil)
	data := subscribeAndAwait(t, h, "runtime")

	var snap runtimeSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode runtime snapshot: %v", err)
	}
	if snap.RecentEvents == nil || !snap.RecentEvents.Enabled {
		t.Errorf("runtime snapshot recent_events = %+v, want an enabled Gated payload", snap.RecentEvents)
	}
}

// TestUpstreamsTopicComposite covers deliverable A's "upstreams" topic:
// Upstreams + DCs + MeWriters, all present against telemttest's default
// (minimal_runtime_enabled on) scenario.
func TestUpstreamsTopicComposite(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{}, nil)
	data := subscribeAndAwait(t, h, "upstreams")

	var snap upstreamsSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode upstreams snapshot: %v (data=%s)", err, data)
	}
	if snap.Upstreams == nil || snap.DCs == nil || snap.MeWriters == nil {
		t.Errorf("upstreams snapshot missing a field: %+v", snap)
	}
}

// TestSecurityTopicComposite covers deliverable A's "security" topic:
// Posture + Whitelist + EffectiveLimits always present.
func TestSecurityTopicComposite(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{}, nil)
	data := subscribeAndAwait(t, h, "security")

	var snap securitySnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode security snapshot: %v (data=%s)", err, data)
	}
	if snap.Posture == nil || snap.Whitelist == nil || snap.EffectiveLimits == nil {
		t.Errorf("security snapshot missing a field: %+v", snap)
	}
}

// TestSecurityTopicHasNoTLSFingerprints pins the M4 ruling: the ~120 KB
// TLS fingerprints payload (TELEMT_LIVE_API_DATA.md §19) is NOT part of
// the polled "security" topic even when the runtime_edge capability is on
// — it is fetch-on-visit through GET /api/telemt/tls-fingerprints. The key
// must not reappear on the wire.
func TestSecurityTopicHasNoTLSFingerprints(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{RuntimeEdge: true}, nil)
	data := subscribeAndAwait(t, h, "security")

	if bytes.Contains(data, []byte(`"tls_fingerprints"`)) {
		t.Errorf("security snapshot still carries tls_fingerprints: %s", data)
	}
}

// TestRuntimeTopicRecentEventsExplicitLimit pins deliverable C(a): the
// "runtime" topic asks for events with an explicit ?limit=50 rather than
// letting Telemt pick its own default.
func TestRuntimeTopicRecentEventsExplicitLimit(t *testing.T) {
	var mu sync.Mutex
	var eventsQueries []string
	fake := telemttest.New(telemttest.Scenario{RuntimeEdge: true})
	t.Cleanup(fake.Close)
	recorder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/runtime/events/recent" {
			mu.Lock()
			eventsQueries = append(eventsQueries, r.URL.RawQuery)
			mu.Unlock()
		}
		proxied, err := http.NewRequestWithContext(r.Context(), r.Method, fake.URL+r.URL.RequestURI(), nil)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		resp, err := http.DefaultClient.Do(proxied)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	}))
	t.Cleanup(recorder.Close)

	h := New(Config{
		UsersInterval:     time.Hour,
		StatsInterval:     time.Hour,
		RuntimeInterval:   10 * time.Millisecond,
		UpstreamsInterval: time.Hour,
		SecurityInterval:  time.Hour,
		Grace:             time.Second,
	}, telemt.New(recorder.URL, ""), nil)
	t.Cleanup(h.Close)

	subscribeAndAwait(t, h, "runtime")

	mu.Lock()
	defer mu.Unlock()
	if len(eventsQueries) == 0 {
		t.Fatal("runtime poll never called /v1/runtime/events/recent")
	}
	want := "limit=" + strconv.Itoa(recentEventsLimit)
	for _, q := range eventsQueries {
		if q != want {
			t.Errorf("events query = %q, want %q", q, want)
		}
	}
}

// TestStatsTopicExtended covers deliverable A's stats extension: Ready is
// always attempted, ConnectionsSummary only appears with runtime_edge on,
// and version/uptime are populated from SystemInfo.
func TestStatsTopicExtended(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{}, nil)
	data := subscribeAndAwait(t, h, "stats")

	var snap statsSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode stats snapshot: %v (data=%s)", err, data)
	}
	if snap.Ready == nil {
		t.Error("stats snapshot missing ready")
	}
	if snap.ConnectionsSummary != nil {
		t.Errorf("stats snapshot has connections_summary with runtime_edge off: %+v", snap.ConnectionsSummary)
	}
	if snap.Version == "" {
		t.Error("stats snapshot missing version from SystemInfo")
	}
}

func TestStatsTopicConnectionsSummaryWhenRuntimeEdge(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{RuntimeEdge: true}, nil)
	data := subscribeAndAwait(t, h, "stats")

	var snap statsSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode stats snapshot: %v", err)
	}
	if snap.ConnectionsSummary == nil || !snap.ConnectionsSummary.Enabled {
		t.Errorf("stats snapshot connections_summary = %+v, want an enabled Gated payload", snap.ConnectionsSummary)
	}
}

// unreachableTelemtClient builds a *telemt.Client pointed at a closed
// listener — every call fails as a transport error, the same shape an
// unreachable Telemt produces in production (TestAPIOnlyDegradation's
// pattern in internal/httpapi).
func unreachableTelemtClient(t *testing.T) *telemt.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // closed immediately: connections to it now fail outright
	return telemt.New(url, "")
}

// TestNewTopicsSourceErrorWhenTelemtUnreachable covers the "full failure"
// half of deliverable A's per-topic degrade rule: when every sub-call in a
// composite topic fails, the topic reports source_error rather than
// publishing an all-null snapshot — for all three new composite topics.
func TestNewTopicsSourceErrorWhenTelemtUnreachable(t *testing.T) {
	tc := unreachableTelemtClient(t)
	h := New(Config{
		UsersInterval:     time.Hour,
		StatsInterval:     10 * time.Millisecond,
		RuntimeInterval:   10 * time.Millisecond,
		UpstreamsInterval: 10 * time.Millisecond,
		SecurityInterval:  10 * time.Millisecond,
		Grace:             time.Second,
	}, tc, nil)
	t.Cleanup(h.Close)

	for _, topic := range []string{"runtime", "upstreams", "security", "stats"} {
		ch, _, cancel, err := h.Subscribe([]string{topic})
		if err != nil {
			t.Fatalf("Subscribe(%q): %v", topic, err)
		}
		ev := recvEvent(t, ch, 2*time.Second)
		if ev.Err != sourceErrorCode {
			t.Errorf("topic %q: Err = %q, want %q", topic, ev.Err, sourceErrorCode)
		}
		cancel()
	}
}

// TestStatsSysInfoRefresherCaches covers the rate-limit half of the
// version/uptime refresh: a second get within the refresh interval must not
// re-fetch GET /v1/system/info.
func TestStatsSysInfoRefresherCaches(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"ok":true,"data":{"version":"1.2.3","target_arch":"x86_64","target_os":"linux","uptime_seconds":42},"revision":"r"}`))
	}))
	t.Cleanup(srv.Close)
	tc := telemt.New(srv.URL, "")

	fakeNow := time.Unix(1_700_000_000, 0)
	r := &statsSysInfoRefresher{tc: tc, interval: time.Minute, now: func() time.Time { return fakeNow }}

	ctx := context.Background()
	view, ok := r.get(ctx)
	if !ok || view.version != "1.2.3" || view.uptime != 42 {
		t.Fatalf("first get() = %q, %v, %v, want 1.2.3, 42, true", view.version, view.uptime, ok)
	}
	if hits != 1 {
		t.Fatalf("hits after first get() = %d, want 1", hits)
	}

	// Still within the refresh interval: cached value, no new request.
	fakeNow = fakeNow.Add(30 * time.Second)
	if _, ok := r.get(ctx); !ok {
		t.Fatal("second get() ok = false, want true (cached)")
	}
	if hits != 1 {
		t.Fatalf("hits after second get() (still fresh) = %d, want 1 (no re-fetch)", hits)
	}

	// Past the refresh interval: re-fetches.
	fakeNow = fakeNow.Add(time.Minute)
	if _, ok := r.get(ctx); !ok {
		t.Fatal("third get() ok = false, want true")
	}
	if hits != 2 {
		t.Fatalf("hits after third get() (stale) = %d, want 2 (re-fetched)", hits)
	}
}

// TestHistoryRecording covers deliverable B: after each successful "stats"
// poll, the hub records connections/active_users/refusals/traffic points
// into the store's RAM ring — traffic only once the "users" topic has been polled
// at least once (its TotalOctets sum is the source), the other two on every
// stats poll.
func TestHistoryRecording(t *testing.T) {
	fake := telemttest.New(telemttest.Scenario{})
	t.Cleanup(fake.Close)
	tc := telemt.New(fake.URL, "")
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	h := New(Config{
		UsersInterval: 10 * time.Millisecond,
		StatsInterval: 10 * time.Millisecond,
		Grace:         time.Second,
	}, tc, st)
	t.Cleanup(h.Close)

	// historyRecordedHook fires synchronously, once per stats poll, right
	// after recordStatsHistory runs (hub.go) — a deterministic signal this
	// test waits on instead of sleep-polling the store. Buffered so the
	// poller goroutine never blocks on a slow test reader; set before the
	// first Subscribe below starts the poller, so there is no race on the
	// field itself (safe write-then-goroutine-start, no concurrent access
	// until then).
	recorded := make(chan struct{}, 64)
	h.historyRecordedHook = func() {
		select {
		case recorded <- struct{}{}:
		default:
		}
	}
	awaitRecordedTick := func(t *testing.T) {
		t.Helper()
		select {
		case <-recorded:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for a history recording tick")
		}
	}

	// Subscribe both topics: "users" must have been polled at least once
	// for the traffic metric to have a source (recordStatsHistory's
	// documented degrade).
	_, _, cancelUsers, err := h.Subscribe([]string{"users"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancelUsers()
	ch, _, cancelStats, err := h.Subscribe([]string{"stats"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancelStats()
	// Drain a couple of stats events so at least one poll ran after the
	// users topic had data cached.
	recvEvent(t, ch, 2*time.Second)

	deadline := time.Now().Add(2 * time.Second)
	for {
		points, err := st.MetricRange(metricConnections, 0)
		if err != nil {
			t.Fatalf("MetricRange(connections): %v", err)
		}
		if len(points) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for a connections history point")
		}
		awaitRecordedTick(t)
	}

	for _, metric := range []string{metricConnections, metricActiveUsers, metricRefusals} {
		points, err := st.MetricRange(metric, 0)
		if err != nil {
			t.Fatalf("MetricRange(%s): %v", metric, err)
		}
		if len(points) == 0 {
			t.Errorf("MetricRange(%s) is empty, want at least one point", metric)
		}
	}

	// traffic depends on the "users" topic's cache being populated, which
	// races the stats poller's first tick — wait for recording ticks
	// (each one hook-signaled, no sleeps) until it shows up rather than
	// assuming the first tick already has it.
	deadline = time.Now().Add(2 * time.Second)
	for {
		points, err := st.MetricRange(metricTraffic, 0)
		if err != nil {
			t.Fatalf("MetricRange(traffic): %v", err)
		}
		if len(points) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for a traffic history point")
		}
		awaitRecordedTick(t)
	}
}

// TestHistoryRecordingNilStoreIsNoop covers the nil-store degrade: a Hub
// built without a store (as most of this package's other tests are) must
// not panic when a stats poll succeeds.
func TestHistoryRecordingNilStoreIsNoop(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{}, nil)
	subscribeAndAwait(t, h, "stats") // must not panic
}

// topicsPollInterval mirrors newTelemttestHub's fixed poll interval for
// runtime/upstreams/security/stats — used below to size the "several polls
// happened with no broadcast" quiet window the same way hub_test.go's own
// TestSubscribeReceivesSnapshotThenUpdateOnChange does.
const topicsPollInterval = 10 * time.Millisecond

// assertNoBroadcast fails the test if an event arrives on ch within
// quietFor — the established pattern for "several polls happen with
// unchanged data: no further events" (hub_test.go's
// TestSubscribeReceivesSnapshotThenUpdateOnChange), not a sleep: it's a
// bounded wait on the real channel the poller broadcasts through.
func assertNoBroadcast(t *testing.T, ch <-chan Event, quietFor time.Duration) {
	t.Helper()
	select {
	case unexpected := <-ch:
		t.Fatalf("unexpected broadcast: %+v", unexpected)
	case <-time.After(quietFor):
	}
}

// recvEventUntil waits on ch until match returns true for a received
// event, or timeout elapses. Composite topics (runtime/upstreams/security)
// fetch their several sub-payloads via separate sequential HTTP round
// trips within one poll; a scenario change from a concurrent test
// goroutine can legitimately land mid-poll, producing one "torn" composite
// that mixes old and new sub-payloads — that snapshot genuinely differs
// from the cached one, so the hub is correct to broadcast it, but it is
// not yet the fully-settled state a "real change" test wants to assert on.
// This tolerates that intermediate broadcast instead of assuming the very
// next event already reflects the final state.
func recvEventUntil(t *testing.T, ch <-chan Event, timeout time.Duration, match func(Event) bool) Event {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatal("channel closed unexpectedly")
			}
			if match(ev) {
				return ev
			}
		case <-deadline:
			t.Fatal("timed out waiting for a matching event")
		}
	}
}

// TestRuntimeTopicVolatileTimestampAloneDoesNotBroadcast covers finding 1
// of fix round 1: Telemt re-stamps every generated_at_epoch_secs field with
// a fresh wall-clock value on (most) responses, independent of whether the
// underlying data changed (confirmed against the Rust source — see
// diffKey's doc comment in hub.go). Bumping only that field between polls
// must not broadcast a second event; a real field change afterwards must.
func TestRuntimeTopicVolatileTimestampAloneDoesNotBroadcast(t *testing.T) {
	fake, h := newTelemttestHub(t, telemttest.Scenario{GeneratedAtEpochSecs: 1000}, nil)
	ch, _, cancel, err := h.Subscribe([]string{"runtime"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	first := recvEvent(t, ch, 2*time.Second)
	if first.Err != "" {
		t.Fatalf("first event = %+v", first)
	}

	// Same underlying data, a different generated_at_epoch_secs on every
	// Gated[T] field the runtime topic carries (MePoolState/MeQuality/
	// NatStun/MeSelfTest): several polls happen, no further events.
	fake.SetScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2000})
	assertNoBroadcast(t, ch, 10*topicsPollInterval)

	// A real change (MePoolDown closes MePoolState/MeQuality/NatStun/
	// MeSelfTest's gates, dropping their Data) eventually produces an event
	// reflecting the fully-settled new state. Not RuntimeEdge here: the
	// SDK's Capabilities probe is cached for minutes (capabilities.go), so
	// flipping the fake's scenario wouldn't be reflected in fetchRuntime's
	// cached caps.RuntimeEdge check within this test's lifetime —
	// MePoolDown changes the payload directly, with no capability-cache
	// layer between. Not MinimalRuntimeOff either: that flag gates the
	// /v1/stats/* routes, which this topic does not carry. recvEventUntil
	// (not a plain recvEvent) because fetchRuntime's six sequential
	// sub-calls mean the very next broadcast can be a torn intermediate
	// composite straddling old and new state, not yet fully settled.
	fake.SetScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2000, MePoolDown: true})
	second := recvEventUntil(t, ch, 2*time.Second, func(ev Event) bool {
		var snap runtimeSnapshot
		if err := json.Unmarshal(ev.Data, &snap); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return snap.MePoolState != nil && !snap.MePoolState.Enabled
	})
	if second.Seq <= first.Seq {
		t.Fatalf("second.Seq = %d, want > first.Seq = %d", second.Seq, first.Seq)
	}
}

// TestUpstreamsTopicVolatileTimestampAloneDoesNotBroadcast is
// TestRuntimeTopicVolatileTimestampAloneDoesNotBroadcast for the
// "upstreams" topic (UpstreamsData/DcStatusData/MeWritersData's top-level
// generated_at_epoch_secs fields), using MinimalRuntimeOff as the real
// content change.
func TestUpstreamsTopicVolatileTimestampAloneDoesNotBroadcast(t *testing.T) {
	fake, h := newTelemttestHub(t, telemttest.Scenario{GeneratedAtEpochSecs: 1000}, nil)
	ch, _, cancel, err := h.Subscribe([]string{"upstreams"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	first := recvEvent(t, ch, 2*time.Second)
	if first.Err != "" {
		t.Fatalf("first event = %+v", first)
	}

	fake.SetScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2000})
	assertNoBroadcast(t, ch, 10*topicsPollInterval)

	// recvEventUntil (not a plain recvEvent): fetchUpstreams' three
	// sequential sub-calls (Upstreams/DCs/MeWriters) mean the very next
	// broadcast can be a torn intermediate composite, not yet settled.
	fake.SetScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2000, MinimalRuntimeOff: true})
	second := recvEventUntil(t, ch, 2*time.Second, func(ev Event) bool {
		var snap upstreamsSnapshot
		if err := json.Unmarshal(ev.Data, &snap); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return snap.Upstreams != nil && !snap.Upstreams.Enabled
	})
	if second.Seq <= first.Seq {
		t.Fatalf("second.Seq = %d, want > first.Seq = %d", second.Seq, first.Seq)
	}
}

// TestSecurityTopicVolatileTimestampAloneDoesNotBroadcast is the security
// topic's version: SecurityWhitelistData's top-level generated_at_epoch_secs
// is the volatile field, and toggling ReadOnly (which SecurityPostureData's
// APIReadOnly reflects directly — telemttest's handlePosture) is the real
// content change.
func TestSecurityTopicVolatileTimestampAloneDoesNotBroadcast(t *testing.T) {
	fake, h := newTelemttestHub(t, telemttest.Scenario{GeneratedAtEpochSecs: 1000}, nil)
	ch, _, cancel, err := h.Subscribe([]string{"security"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	first := recvEvent(t, ch, 2*time.Second)
	if first.Err != "" {
		t.Fatalf("first event = %+v", first)
	}

	fake.SetScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2000})
	assertNoBroadcast(t, ch, 10*topicsPollInterval)

	// recvEventUntil (not a plain recvEvent): fetchSecurity's sequential
	// sub-calls (Posture/Whitelist/EffectiveLimits) mean the very next
	// broadcast can be a torn intermediate composite, not yet settled.
	fake.SetScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2000, ReadOnly: true})
	second := recvEventUntil(t, ch, 2*time.Second, func(ev Event) bool {
		var snap securitySnapshot
		if err := json.Unmarshal(ev.Data, &snap); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return snap.Posture != nil && snap.Posture.APIReadOnly
	})
	if second.Seq <= first.Seq {
		t.Fatalf("second.Seq = %d, want > first.Seq = %d", second.Seq, first.Seq)
	}
}

// TestStatsTopicVolatileTimestampAloneDoesNotBroadcast is the stats topic's
// version. RuntimeEdge is on from the start so connections_summary (a
// Gated[T], carrying the volatile field) is actually present in the
// payload; ReadOnly is the real content change (HealthData.ReadOnly).
func TestStatsTopicVolatileTimestampAloneDoesNotBroadcast(t *testing.T) {
	fake, h := newTelemttestHub(t, telemttest.Scenario{GeneratedAtEpochSecs: 1000, RuntimeEdge: true}, nil)
	ch, _, cancel, err := h.Subscribe([]string{"stats"})
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()

	first := recvEvent(t, ch, 2*time.Second)
	if first.Err != "" {
		t.Fatalf("first event = %+v", first)
	}
	var firstSnap statsSnapshot
	if err := json.Unmarshal(first.Data, &firstSnap); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	if firstSnap.ConnectionsSummary == nil {
		t.Fatal("first event missing connections_summary with runtime_edge on — test setup invalid")
	}

	fake.SetScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2000, RuntimeEdge: true})
	assertNoBroadcast(t, ch, 10*topicsPollInterval)

	// recvEventUntil (not a plain recvEvent): fetchStats' sequential
	// sub-calls (Health/Summary/Ready/ConnectionsSummary) mean the very
	// next broadcast can be a torn intermediate composite, not yet
	// settled — same reasoning as the other three topics' tests above,
	// even though ReadOnly here only actually varies the Health sub-call.
	fake.SetScenario(telemttest.Scenario{GeneratedAtEpochSecs: 2000, RuntimeEdge: true, ReadOnly: true})
	second := recvEventUntil(t, ch, 2*time.Second, func(ev Event) bool {
		var snap statsSnapshot
		if err := json.Unmarshal(ev.Data, &snap); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return snap.Health != nil && snap.Health.ReadOnly
	})
	if second.Seq <= first.Seq {
		t.Fatalf("second.Seq = %d, want > first.Seq = %d", second.Seq, first.Seq)
	}
}

// TestDiffKeyStripsVolatileTimestampAtAnyDepth is a focused unit test on
// diffKey itself (hub.go), independent of the poller — proves the
// normalization is generic (works on a nested generated_at_epoch_secs the
// same as a top-level one) and leaves every other field, including other
// int fields that just happen to be zero already, untouched.
func TestDiffKeyStripsVolatileTimestampAtAnyDepth(t *testing.T) {
	a := json.RawMessage(`{"generated_at_epoch_secs":1000,"nested":{"generated_at_epoch_secs":1000,"value":42},"list":[{"generated_at_epoch_secs":1000}]}`)
	b := json.RawMessage(`{"generated_at_epoch_secs":2000,"nested":{"generated_at_epoch_secs":2000,"value":42},"list":[{"generated_at_epoch_secs":2000}]}`)

	if !bytes.Equal(diffKey("runtime", a), diffKey("runtime", b)) {
		t.Fatalf("diffKey(a)=%s, diffKey(b)=%s — want equal after stripping every generated_at_epoch_secs", diffKey("runtime", a), diffKey("runtime", b))
	}

	// A real change (nested.value) still produces a different key.
	c := json.RawMessage(`{"generated_at_epoch_secs":1000,"nested":{"generated_at_epoch_secs":1000,"value":43},"list":[{"generated_at_epoch_secs":1000}]}`)
	if bytes.Equal(diffKey("runtime", a), diffKey("runtime", c)) {
		t.Fatal("diffKey(a) == diffKey(c) after a real field changed, want different keys")
	}
}

// --- the "web" topic (M4 task 8b) ---------------------------------------

// TestWebTopicWrapsTheStatusInAGate covers the "web" topic's whole reason
// for existing: Telemt's own status route is NOT gated, and the hub puts it
// behind the same Gated[T] envelope the edge topics use so the browser has
// one way — not two — to render "closed, and here is why".
func TestWebTopicWrapsTheStatusInAGate(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{}, nil)
	data := subscribeAndAwait(t, h, "web")

	var snap webSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode web snapshot: %v (data=%s)", err, data)
	}
	if snap.Status == nil {
		t.Fatal("web snapshot has no status")
	}
	if !snap.Status.Enabled || snap.Status.Data == nil {
		t.Fatalf("status = %+v, want an open gate carrying the payload", snap.Status)
	}
	if snap.Status.Data.Runtime == nil || snap.Status.Data.Runtime.Manager == nil {
		t.Fatal("the runtime planes did not survive the round trip through the hub")
	}
	// permits is a tuple array on the wire; the hub re-marshals the topic,
	// so a broken codec would show up here as an object or a null.
	if !bytes.Contains(data, []byte(`["http_connections",{`)) {
		t.Errorf("permits lost their tuple shape on the way out:\n%s", data)
	}
}

// A WEB runtime that is not running is a GATE, not an error: the topic must
// still publish, with enabled:false and Telemt's own reason token.
func TestWebTopicClosedGateWhenWebIsOff(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{WebOff: true}, nil)
	data := subscribeAndAwait(t, h, "web")

	var snap webSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode web snapshot: %v (data=%s)", err, data)
	}
	if snap.Status.Enabled {
		t.Error("gate open while WEB is off")
	}
	if snap.Status.Reason != "no_web_listener" {
		t.Errorf("reason = %q, want Telemt's own no_web_listener", snap.Status.Reason)
	}
	// The payload is kept even behind a closed gate: lifecycle, listeners
	// and effective_config_enabled are what explain WHY it is closed.
	if snap.Status.Data == nil || snap.Status.Data.Lifecycle != telemt.WebLifecycleNoWebListener {
		t.Errorf("data = %+v, want the closed-runtime payload", snap.Status.Data)
	}
}

// A build that predates the WEB routes answers a bare 404. That is
// `unsupported`, not `disabled` (rule R5) — and never a source_error.
func TestWebTopicUnsupportedOnAnOldBuild(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{OldBuild: true}, nil)
	data := subscribeAndAwait(t, h, "web")

	var snap webSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode web snapshot: %v (data=%s)", err, data)
	}
	if snap.Status.Enabled || snap.Status.Data != nil {
		t.Errorf("status = %+v, want a closed gate with no payload", snap.Status)
	}
	if snap.Status.Reason != webGateReasonUnsupported {
		t.Errorf("reason = %q, want %q", snap.Status.Reason, webGateReasonUnsupported)
	}
}

// An unreachable Telemt is still a source_error — the gate branches above
// must not swallow a real failure.
func TestWebTopicSourceErrorWhenUnreachable(t *testing.T) {
	h := New(Config{WebInterval: 10 * time.Millisecond, Grace: time.Second}, telemt.New("http://127.0.0.1:1", ""), nil)
	t.Cleanup(h.Close)
	ch, _, cancel, err := h.Subscribe([]string{"web"})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer cancel()
	if ev := recvEvent(t, ch, 2*time.Second); ev.Err != "telemt_unreachable" {
		t.Errorf("Err = %q, want telemt_unreachable", ev.Err)
	}
}

// TestWebDiffKeyIgnoresTheClockDerivedAges is the push-on-change half:
// lifecycle_age_ms and the learning plane's age_ms are re-read from the
// clock on every request, so two byte-identical WEB snapshots that differ
// only in those two numbers must compare EQUAL — otherwise an idle WEB
// runtime would broadcast a "change" on every poll.
func TestWebDiffKeyIgnoresTheClockDerivedAges(t *testing.T) {
	a := json.RawMessage(`{"status":{"enabled":true,"data":{"lifecycle":"running","lifecycle_age_ms":1000,` +
		`"runtime":{"learning":{"age_ms":1000,"entries":0}}}}}`)
	b := json.RawMessage(`{"status":{"enabled":true,"data":{"lifecycle":"running","lifecycle_age_ms":99000,` +
		`"runtime":{"learning":{"age_ms":99000,"entries":0}}}}}`)
	c := json.RawMessage(`{"status":{"enabled":true,"data":{"lifecycle":"running","lifecycle_age_ms":1000,` +
		`"runtime":{"learning":{"age_ms":1000,"entries":1}}}}}`)

	if !bytes.Equal(diffKey("web", a), diffKey("web", b)) {
		t.Errorf("diffKey differs on ages alone:\n%s\n%s", diffKey("web", a), diffKey("web", b))
	}
	if bytes.Equal(diffKey("web", a), diffKey("web", c)) {
		t.Error("diffKey ignored a real field change")
	}
	// …and the extra keys are scoped to this topic: another topic's own
	// age_ms must keep its diffing power.
	if bytes.Equal(diffKey("runtime", a), diffKey("runtime", b)) {
		t.Error("the web-only volatile keys leaked into another topic")
	}
}
