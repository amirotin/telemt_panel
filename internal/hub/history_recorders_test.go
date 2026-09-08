package hub

import (
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func recorderHub(t *testing.T) (*Hub, *store.Memory) {
	t.Helper()
	memory, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	return &Hub{st: memory}, memory
}

func latestMetric(t *testing.T, memory *store.Memory, name string) store.MetricPoint {
	t.Helper()
	points, err := memory.MetricRange(name, time.Now().Add(-time.Minute).Unix())
	if err != nil || len(points) == 0 {
		t.Fatalf("%s history = %+v, %v", name, points, err)
	}
	return points[len(points)-1]
}

func TestRecordUpstreamsHistoryKeepsRPCAndMediaSeparate(t *testing.T) {
	h, memory := recorderHub(t)
	rttRPC, rttMedia := 42.0, 87.0
	snapshot := upstreamsSnapshot{DCs: &telemt.DcStatusData{
		MiddleProxyEnabled: true,
		DCs: []telemt.DcStatus{
			{DC: 2, RequiredWriters: 3, AliveWriters: 3, CoveragePct: 100, RttMs: &rttRPC},
			{DC: -2, RequiredWriters: 3, AliveWriters: 2, CoveragePct: 66, RttMs: &rttMedia},
		},
	}}
	h.recordUpstreamsHistory(snapshot)
	if got := latestMetric(t, memory, "dc.2.rtt_ms").Value; got != 42 {
		t.Fatalf("RPC RTT = %v, want 42", got)
	}
	if got := latestMetric(t, memory, "dc.-2.rtt_ms").Value; got != 87 {
		t.Fatalf("Media RTT = %v, want 87", got)
	}
	if got := latestMetric(t, memory, "dc.coverage_pct").Value; got != 100*5.0/6.0 {
		t.Fatalf("weighted coverage = %v, want %v", got, 100*5.0/6.0)
	}
}

func TestRecordRuntimeHistoryDistinguishesFallbackAndUpstreamHealth(t *testing.T) {
	h, memory := recorderHub(t)
	latency := 55.0
	snapshot := runtimeSnapshot{
		Gates: &telemt.RuntimeGatesData{UseMiddleProxy: true, RouteMode: "direct", RerouteActive: true},
		UpstreamQuality: &telemt.RuntimeUpstreamQualityData{
			Enabled: true,
			Summary: &telemt.RuntimeUpstreamQualitySummaryData{HealthyTotal: 1, UnhealthyTotal: 1},
			Upstreams: []telemt.RuntimeUpstreamQualityUpstreamData{
				{UpstreamID: 7, Healthy: false, EffectiveLatencyMs: &latency},
			},
		},
	}
	h.recordRuntimeHistory(snapshot)
	if got := latestMetric(t, memory, metricRouteMode).Value; got != routeModeFallback {
		t.Fatalf("route mode = %v, want fallback", got)
	}
	if got := latestMetric(t, memory, "upstream.unhealthy_total").Value; got != 1 {
		t.Fatalf("unhealthy total = %v, want 1", got)
	}
	if got := latestMetric(t, memory, "upstream.7.healthy").Value; got != 0 {
		t.Fatalf("upstream health = %v, want 0", got)
	}
	if got := latestMetric(t, memory, "upstream.7.unhealthy").Value; got != 1 {
		t.Fatalf("upstream failure signal = %v, want 1", got)
	}
}

func TestRecordTelemtAvailability(t *testing.T) {
	h, memory := recorderHub(t)
	h.recordTelemtAvailability(false)
	if got := latestMetric(t, memory, metricTelemtAvailable).Value; got != 0 {
		t.Fatalf("availability = %v, want 0", got)
	}
	if got := latestMetric(t, memory, metricTelemtUnavailable).Value; got != 1 {
		t.Fatalf("unavailable signal = %v, want 1", got)
	}
}

func historyEvents(t *testing.T, memory *store.Memory) []store.HistoryEvent {
	t.Helper()
	events, err := memory.ListHistoryEvents(store.HistoryEventFilter{Category: store.StorageEvents})
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func TestHistoryTransitionsSkipBaselineAndRecordChanges(t *testing.T) {
	h, memory := recorderHub(t)

	h.recordTelemtAvailability(true)
	h.recordTelemtAvailability(false)
	h.recordTelemtAvailability(false)
	h.recordTelemtAvailability(true)

	runtime := func(useMiddle bool, route string, reroute, healthy bool) runtimeSnapshot {
		return runtimeSnapshot{
			Gates: &telemt.RuntimeGatesData{UseMiddleProxy: useMiddle, RouteMode: route, RerouteActive: reroute},
			UpstreamQuality: &telemt.RuntimeUpstreamQualityData{
				Enabled: true, Summary: &telemt.RuntimeUpstreamQualitySummaryData{},
				Upstreams: []telemt.RuntimeUpstreamQualityUpstreamData{{UpstreamID: 7, Healthy: healthy}},
			},
		}
	}
	h.recordRuntimeHistory(runtime(true, "middle", false, true))
	h.recordRuntimeHistory(runtime(true, "direct", true, false))
	h.recordRuntimeHistory(runtime(false, "direct", false, true))

	dcs := func(coverage float64) upstreamsSnapshot {
		return upstreamsSnapshot{DCs: &telemt.DcStatusData{
			MiddleProxyEnabled: true,
			DCs:                []telemt.DcStatus{{DC: -203, RequiredWriters: 3, AliveWriters: 2, CoveragePct: coverage}},
		}}
	}
	h.recordUpstreamsHistory(dcs(100))
	h.recordUpstreamsHistory(dcs(66.4))
	h.recordUpstreamsHistory(dcs(66.49)) // same normalized state, no duplicate

	events := historyEvents(t, memory)
	if len(events) != 7 {
		t.Fatalf("events = %+v, want 7 transitions", events)
	}
	wantKinds := map[string]int{
		eventTelemtChanged:   2,
		eventRouteChanged:    2,
		eventUpstreamChanged: 2,
		eventDCChanged:       1,
	}
	for _, event := range events {
		wantKinds[event.Kind]--
	}
	for kind, remaining := range wantKinds {
		if remaining != 0 {
			t.Fatalf("kind %s remaining = %d; events=%+v", kind, remaining, events)
		}
	}
	latest := events[0]
	if latest.Kind != eventDCChanged || latest.Entity != "dc:-203" || latest.State != "66" || latest.PreviousState != "100" || latest.Attributes["route"] != "media" {
		t.Fatalf("DC transition = %+v", latest)
	}
}

func TestHistoryTransitionsRespectEventsPolicy(t *testing.T) {
	h, memory := recorderHub(t)
	policies, err := memory.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		if policies[i].Category == store.StorageEvents {
			policies[i].Enabled = false
		}
	}
	if err := memory.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	h.recordTelemtAvailability(true)
	h.recordTelemtAvailability(false)
	if events := historyEvents(t, memory); len(events) != 0 {
		t.Fatalf("disabled events = %+v", events)
	}
}

func TestHistoryTransitionsResetOptionalSourceBaselines(t *testing.T) {
	h, memory := recorderHub(t)
	runtime := func(enabled, healthy bool) runtimeSnapshot {
		return runtimeSnapshot{
			UpstreamQuality: &telemt.RuntimeUpstreamQualityData{
				Enabled: enabled, Summary: &telemt.RuntimeUpstreamQualitySummaryData{},
				Upstreams: []telemt.RuntimeUpstreamQualityUpstreamData{{UpstreamID: 7, Healthy: healthy}},
			},
		}
	}
	h.recordRuntimeHistory(runtime(true, false))
	h.recordRuntimeHistory(runtime(false, false))
	h.recordRuntimeHistory(runtime(true, true))

	dcs := func(enabled bool, coverage float64) upstreamsSnapshot {
		return upstreamsSnapshot{DCs: &telemt.DcStatusData{
			MiddleProxyEnabled: enabled,
			DCs:                []telemt.DcStatus{{DC: 4, CoveragePct: coverage}},
		}}
	}
	h.recordUpstreamsHistory(dcs(true, 33))
	h.recordUpstreamsHistory(dcs(false, 33))
	h.recordUpstreamsHistory(dcs(true, 100))

	if events := historyEvents(t, memory); len(events) != 0 {
		t.Fatalf("re-enabled optional sources emitted fake recovery: %+v", events)
	}
}
