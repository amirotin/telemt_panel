package hub

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
// Posture + Whitelist + EffectiveLimits always present; TLSFingerprints
// only with runtime_edge on.
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
	if snap.TLSFingerprints != nil {
		t.Errorf("security snapshot has tls_fingerprints with runtime_edge off: %+v", snap.TLSFingerprints)
	}
}

func TestSecurityTopicTLSFingerprintsWhenRuntimeEdge(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{RuntimeEdge: true}, nil)
	data := subscribeAndAwait(t, h, "security")

	var snap securitySnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("decode security snapshot: %v", err)
	}
	if snap.TLSFingerprints == nil || !snap.TLSFingerprints.Enabled {
		t.Errorf("security snapshot tls_fingerprints = %+v, want an enabled Gated payload", snap.TLSFingerprints)
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
	v, u, ok := r.get(ctx)
	if !ok || v != "1.2.3" || u != 42 {
		t.Fatalf("first get() = %q, %v, %v, want 1.2.3, 42, true", v, u, ok)
	}
	if hits != 1 {
		t.Fatalf("hits after first get() = %d, want 1", hits)
	}

	// Still within the refresh interval: cached value, no new request.
	fakeNow = fakeNow.Add(30 * time.Second)
	if _, _, ok := r.get(ctx); !ok {
		t.Fatal("second get() ok = false, want true (cached)")
	}
	if hits != 1 {
		t.Fatalf("hits after second get() (still fresh) = %d, want 1 (no re-fetch)", hits)
	}

	// Past the refresh interval: re-fetches.
	fakeNow = fakeNow.Add(time.Minute)
	if _, _, ok := r.get(ctx); !ok {
		t.Fatal("third get() ok = false, want true")
	}
	if hits != 2 {
		t.Fatalf("hits after third get() (stale) = %d, want 2 (re-fetched)", hits)
	}
}

// TestHistoryRecording covers deliverable B: after each successful "stats"
// poll, the hub records connections/active_users/traffic points into the
// store's RAM ring — traffic only once the "users" topic has been polled
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
		time.Sleep(5 * time.Millisecond)
	}

	for _, metric := range []string{metricConnections, metricActiveUsers} {
		points, err := st.MetricRange(metric, 0)
		if err != nil {
			t.Fatalf("MetricRange(%s): %v", metric, err)
		}
		if len(points) == 0 {
			t.Errorf("MetricRange(%s) is empty, want at least one point", metric)
		}
	}

	// traffic depends on the "users" topic's cache being populated, which
	// races the stats poller's first tick — poll until it shows up rather
	// than asserting on the very first stats event.
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
		time.Sleep(5 * time.Millisecond)
	}
}

// TestHistoryRecordingNilStoreIsNoop covers the nil-store degrade: a Hub
// built without a store (as most of this package's other tests are) must
// not panic when a stats poll succeeds.
func TestHistoryRecordingNilStoreIsNoop(t *testing.T) {
	_, h := newTelemttestHub(t, telemttest.Scenario{}, nil)
	subscribeAndAwait(t, h, "stats") // must not panic
}
