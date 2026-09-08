package hub

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

type historyCapture struct {
	store.HistoryStore
	metrics   []store.NamedMetricPoint
	failEvent bool
}

func (s *historyCapture) RecordMetrics(batch []store.NamedMetricPoint) error {
	s.metrics = append(s.metrics, batch...)
	return nil
}

func (s *historyCapture) AppendHistoryEvent(event store.HistoryEvent) error {
	if s.failEvent {
		return errors.New("history write failed")
	}
	return s.HistoryStore.AppendHistoryEvent(event)
}

func TestHistoryFallbackRequiresFreshUsersObservation(t *testing.T) {
	for _, scenario := range []string{"fresh", "failed", "expired", "unchanged refresh", "recovered"} {
		t.Run(scenario, func(t *testing.T) {
			_, memory := recorderHub(t)
			capture := &historyCapture{HistoryStore: memory}
			h := New(Config{UsersInterval: 10 * time.Second}, nil, capture)
			t.Cleanup(h.Close)
			now := time.Now()
			h.now = func() time.Time { return now }
			users := h.topics["users"]
			payload := json.RawMessage(`{"users":[{"username":"alice","current_connections":7}]}`)
			h.recordFetchSuccess(users, payload)
			switch scenario {
			case "failed", "recovered":
				h.recordFetchError(users, errors.New("users endpoint unavailable"))
				if scenario == "recovered" {
					h.recordFetchSuccess(users, payload)
				}
			case "expired", "unchanged refresh":
				now = now.Add(time.Minute)
				if scenario == "unchanged refresh" {
					h.recordFetchSuccess(users, payload)
				}
			}
			h.recordStatsHistory(json.RawMessage(`{}`))
			gauges := map[string]float64{}
			for _, metric := range capture.metrics {
				if metric.Name == metricConnections || metric.Name == metricActiveUsers {
					gauges[metric.Name] = metric.Point.Value
				}
			}
			if scenario == "failed" || scenario == "expired" {
				if len(gauges) != 0 {
					t.Fatalf("stale cache became a new observation: %v", gauges)
				}
			} else if len(gauges) != 2 || gauges[metricConnections] != 7 || gauges[metricActiveUsers] != 1 {
				t.Fatalf("fresh fallback gauges = %v", gauges)
			}
		})
	}
}

func TestHistoryRouteTransitionsAllModes(t *testing.T) {
	modes := map[string]telemt.RuntimeGatesData{
		"me":       {UseMiddleProxy: true, RouteMode: "middle_proxy"},
		"fallback": {UseMiddleProxy: true, RouteMode: "direct", RerouteActive: true},
		"direct":   {UseMiddleProxy: false, RouteMode: "direct"},
	}
	for from, initial := range modes {
		for to, next := range modes {
			if from == to {
				continue
			}
			t.Run(from+" to "+to, func(t *testing.T) {
				h, memory := recorderHub(t)
				h.observeRouteMode(&initial)
				h.observeRouteMode(nil)
				h.observeRouteMode(&initial)
				h.observeRouteMode(&next)
				h.observeRouteMode(&next)
				events := historyEvents(t, memory)
				severity := "info"
				if to == "fallback" {
					severity = "warning"
				}
				if len(events) != 1 || events[0].Kind != eventRouteChanged || events[0].PreviousState != from || events[0].State != to || events[0].Severity != severity {
					t.Fatalf("route transitions = %+v", events)
				}
			})
		}
	}
}

func TestHistoryFreshPrimaryGaugesDoNotDependOnUsersCache(t *testing.T) {
	_, memory := recorderHub(t)
	capture := &historyCapture{HistoryStore: memory}
	h := New(Config{}, nil, capture)
	t.Cleanup(h.Close)
	h.recordFetchError(h.topics["users"], errors.New("users endpoint unavailable"))
	h.recordStatsHistory(json.RawMessage(`{"connections_summary":{"enabled":true,"data":{"totals":{"current_connections":11,"active_users":2}}}}`))
	gauges := map[string]float64{}
	for _, metric := range capture.metrics {
		gauges[metric.Name] = metric.Point.Value
	}
	if gauges[metricConnections] != 11 || gauges[metricActiveUsers] != 2 {
		t.Fatalf("fresh primary gauges = %v", gauges)
	}
}

func TestHistoryMissingOptionalSourcesDoNotCreateObservations(t *testing.T) {
	h, memory := recorderHub(t)
	capture := &historyCapture{HistoryStore: memory}
	h.st = capture
	h.observeRouteMode(&telemt.RuntimeGatesData{UseMiddleProxy: true, RouteMode: "middle_proxy"})
	h.observeUpstreamHealth([]telemt.RuntimeUpstreamQualityUpstreamData{{UpstreamID: 7, Healthy: false}})
	h.observeDCCoverage([]telemt.DcStatus{{DC: -203, CoveragePct: 0}})
	for _, raw := range []json.RawMessage{json.RawMessage(`{}`), json.RawMessage(`null`), json.RawMessage(`{`)} {
		h.recordRuntimeHistory(raw)
		h.recordUpstreamsHistory(raw)
	}
	if len(capture.metrics) != 0 || len(historyEvents(t, memory)) != 0 {
		t.Fatal("missing sources created observations or recovery events")
	}
	// Unknown intervals keep the previous known state, not a healthy baseline.
	h.observeRouteMode(&telemt.RuntimeGatesData{UseMiddleProxy: true, RouteMode: "middle_proxy"})
	h.observeUpstreamHealth([]telemt.RuntimeUpstreamQualityUpstreamData{{UpstreamID: 7, Healthy: true}})
	h.observeDCCoverage([]telemt.DcStatus{{DC: -203, CoveragePct: 100}})
	if events := historyEvents(t, memory); len(events) != 2 {
		t.Fatalf("observed recoveries = %+v, want two", events)
	}
}

func TestHistoryAvailabilityIgnoresCanceledObservation(t *testing.T) {
	for _, reason := range []string{"panel shutdown", "request deadline", "source failure"} {
		t.Run(reason, func(t *testing.T) {
			_, memory := recorderHub(t)
			h := New(Config{}, nil, memory)
			t.Cleanup(h.Close)
			h.observeTelemtAvailability(true)
			ctx := h.ctx
			if reason == "request deadline" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer cancel()
			}
			stats := h.topics["stats"]
			stats.fetch = func(ctx context.Context) (json.RawMessage, error) {
				if reason == "panel shutdown" {
					h.cancel()
				}
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				return nil, errors.New("Telemt connection refused")
			}
			if h.pollWithContext(ctx, stats) {
				t.Fatal("failed observation succeeded")
			}
			events := historyEvents(t, memory)
			points, err := memory.MetricRange(metricTelemtUnavailable, 0)
			if err != nil {
				t.Fatal(err)
			}
			if reason == "source failure" {
				if len(events) != 1 || events[0].State != "unavailable" || len(points) != 1 || points[0].Value != 1 {
					t.Fatalf("real outage missing: events=%+v points=%+v", events, points)
				}
			} else if len(events) != 0 || len(points) != 0 {
				t.Fatalf("canceled observation became an outage: events=%+v points=%+v", events, points)
			}
		})
	}
}

func TestHistoryTransitionsRetryFailedWrite(t *testing.T) {
	for _, kind := range []string{"availability", "route", "upstream", "dc"} {
		t.Run(kind, func(t *testing.T) {
			h, memory := recorderHub(t)
			capture := &historyCapture{HistoryStore: memory}
			h.st = capture
			observe := func(changed bool) {
				switch kind {
				case "availability":
					h.observeTelemtAvailability(!changed)
				case "route":
					gates := telemt.RuntimeGatesData{UseMiddleProxy: true, RouteMode: "middle_proxy"}
					if changed {
						gates.RouteMode, gates.RerouteActive = "direct", true
					}
					h.observeRouteMode(&gates)
				case "upstream":
					h.observeUpstreamHealth([]telemt.RuntimeUpstreamQualityUpstreamData{{UpstreamID: 7, Healthy: !changed}})
				case "dc":
					coverage := 100.0
					if changed {
						coverage = 0
					}
					h.observeDCCoverage([]telemt.DcStatus{{DC: -203, CoveragePct: coverage}})
				}
			}
			observe(false)
			capture.failEvent = true
			observe(true)
			if events := historyEvents(t, memory); len(events) != 0 {
				t.Fatalf("failed write recorded events: %+v", events)
			}
			capture.failEvent = false
			observe(true)
			observe(true)
			if events := historyEvents(t, memory); len(events) != 1 {
				t.Fatalf("retry must record exactly one event: %+v", events)
			}
		})
	}
}

func TestHistoryCollectorDiskContract(t *testing.T) {
	if store.Variant == "lite" {
		t.Skip("SQLite is intentionally omitted from the lite build")
	}
	path := filepath.Join(t.TempDir(), "history.db")
	st, err := store.Open(store.OpenOptions{Driver: "sqlite", Path: path})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	h := New(Config{}, nil, st)
	t.Cleanup(h.Close)
	marshal := func(value any) json.RawMessage {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	h.recordFetchSuccess(h.topics["users"], json.RawMessage(`{"users":[{"username":"alice","current_connections":7}]}`))
	h.recordStatsHistory(json.RawMessage(`{"summary":{"connections_total":10,"uptime_seconds":100}}`))
	if err := st.RecordMetric(metricTraffic, store.MetricPoint{TS: time.Now().Unix(), Value: 1024}); err != nil {
		t.Fatal(err)
	}
	h.recordTelemtAvailability(true)
	h.recordTelemtAvailability(false)
	latency := 55.0
	runtime := runtimeSnapshot{
		Gates: &telemt.RuntimeGatesData{UseMiddleProxy: true, RouteMode: "middle_proxy"},
		UpstreamQuality: &telemt.RuntimeUpstreamQualityData{
			Enabled: true, Summary: &telemt.RuntimeUpstreamQualitySummaryData{HealthyTotal: 1},
			Upstreams: []telemt.RuntimeUpstreamQualityUpstreamData{{UpstreamID: 7, Healthy: true, EffectiveLatencyMs: &latency}},
		},
	}
	h.recordRuntimeHistory(marshal(runtime))
	runtime.Gates.RouteMode, runtime.Gates.RerouteActive = "direct", true
	runtime.UpstreamQuality.Upstreams[0].Healthy = false
	runtime.UpstreamQuality.Summary.HealthyTotal, runtime.UpstreamQuality.Summary.UnhealthyTotal = 0, 1
	h.recordRuntimeHistory(marshal(runtime))
	dcs := upstreamsSnapshot{DCs: &telemt.DcStatusData{MiddleProxyEnabled: true, DCs: []telemt.DcStatus{
		{DC: 203, CoveragePct: 100, RequiredWriters: 3, AliveWriters: 3, RttMs: &latency},
		{DC: -203, CoveragePct: 100, RequiredWriters: 3, AliveWriters: 3, RttMs: &latency},
	}}}
	h.recordUpstreamsHistory(marshal(dcs))
	dcs.DCs.DCs[1].CoveragePct, dcs.DCs.DCs[1].AliveWriters = 66, 2
	h.recordUpstreamsHistory(marshal(dcs))

	// A second connection sees committed transitions before the metric flush.
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	var events, metrics int
	if err := db.QueryRow("SELECT count(*) FROM history_events").Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT count(*) FROM metric_points").Scan(&metrics); err != nil {
		t.Fatal(err)
	}
	if events != 4 || metrics != 0 {
		t.Fatalf("before flush: events=%d, metrics=%d; want 4, 0", events, metrics)
	}
	for _, name := range []string{metricRouteMode, metricTelemtAvailable, metricTelemtUnavailable, "dc.coverage_pct", "upstream.7.healthy", "upstream.7.unhealthy"} {
		points, err := st.MetricRange(name, 0)
		if err != nil || len(points) == 0 || points[0].Tier != store.MetricTierRaw {
			t.Fatalf("live-only state %s = %+v, %v", name, points, err)
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query("SELECT DISTINCT name FROM metric_points ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{metricConnections, metricActiveUsers, metricTraffic, metricAttempts, metricRefusals,
		"dc.203.coverage_pct", "dc.-203.coverage_pct", "dc.203.rtt_ms", "dc.-203.rtt_ms", "upstream.7.latency_ms"}
	sort.Strings(want)
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("disk series = %v, want %v", names, want)
	}
}
