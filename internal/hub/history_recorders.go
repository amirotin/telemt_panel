package hub

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

const (
	routeModeDirect   = 0
	routeModeMiddle   = 1
	routeModeFallback = 2
)

func (h *Hub) recordTelemtAvailability(available bool) {
	if h.st == nil {
		return
	}
	value := float64(0)
	if available {
		value = 1
	}
	ts := time.Now().Unix()
	if err := h.st.RecordMetrics([]store.NamedMetricPoint{
		{Name: metricTelemtAvailable, Point: store.MetricPoint{TS: ts, Value: value}},
		{Name: metricTelemtUnavailable, Point: store.MetricPoint{TS: ts, Value: 1 - value}},
	}); err != nil {
		slog.Warn("hub: record availability history", "err", err)
	}
	h.observeTelemtAvailability(available)
}

func (h *Hub) recordRuntimeHistory(snap runtimeSnapshot) {
	if h.st == nil {
		return
	}
	ts := time.Now().Unix()
	batch := make([]store.NamedMetricPoint, 0, 4)
	add := func(name string, value float64) {
		batch = append(batch, store.NamedMetricPoint{Name: name, Point: store.MetricPoint{TS: ts, Value: value}})
	}
	if snap.Gates != nil {
		add(metricRouteMode, routeModeValue(snap.Gates))
		h.observeRouteMode(snap.Gates)
	}
	quality := snap.UpstreamQuality
	if quality == nil || !quality.Enabled || quality.Summary == nil {
		if quality != nil && !quality.Enabled {
			h.resetUpstreamHealthBaseline()
		}
		if err := h.st.RecordMetrics(batch); err != nil {
			slog.Warn("hub: record route history", "err", err)
		}
		return
	}
	add("upstream.healthy_total", float64(quality.Summary.HealthyTotal))
	add("upstream.unhealthy_total", float64(quality.Summary.UnhealthyTotal))
	for _, upstream := range quality.Upstreams {
		prefix := fmt.Sprintf("upstream.%d.", upstream.UpstreamID)
		healthy := float64(0)
		if upstream.Healthy {
			healthy = 1
		}
		add(prefix+"healthy", healthy)
		add(prefix+"unhealthy", 1-healthy)
		if upstream.EffectiveLatencyMs != nil {
			add(prefix+"latency_ms", *upstream.EffectiveLatencyMs)
		}
	}
	h.observeUpstreamHealth(quality.Upstreams)
	if err := h.st.RecordMetrics(batch); err != nil {
		slog.Warn("hub: record runtime history", "count", len(batch), "err", err)
	}
}

func routeModeValue(gates *telemt.RuntimeGatesData) float64 {
	if gates.RerouteActive || (gates.UseMiddleProxy && strings.EqualFold(gates.RouteMode, "direct")) {
		return routeModeFallback
	}
	if gates.UseMiddleProxy {
		return routeModeMiddle
	}
	return routeModeDirect
}

func (h *Hub) recordUpstreamsHistory(snap upstreamsSnapshot) {
	if h.st == nil {
		return
	}
	if snap.DCs == nil {
		return
	}
	if !snap.DCs.MiddleProxyEnabled {
		h.resetDCCoverageBaseline()
		return
	}
	ts := time.Now().Unix()
	batch := make([]store.NamedMetricPoint, 0, len(snap.DCs.DCs)*2+1)
	add := func(name string, value float64) {
		batch = append(batch, store.NamedMetricPoint{Name: name, Point: store.MetricPoint{TS: ts, Value: value}})
	}
	var alive, required int
	for _, dc := range snap.DCs.DCs {
		prefix := fmt.Sprintf("dc.%d.", dc.DC)
		add(prefix+"coverage_pct", dc.CoveragePct)
		if dc.RttMs != nil {
			add(prefix+"rtt_ms", *dc.RttMs)
		}
		alive += dc.AliveWriters
		required += dc.RequiredWriters
	}
	h.observeDCCoverage(snap.DCs.DCs)
	if required > 0 {
		coverage := 100 * float64(alive) / float64(required)
		if coverage > 100 {
			coverage = 100
		}
		add("dc.coverage_pct", coverage)
	}
	if err := h.st.RecordMetrics(batch); err != nil {
		slog.Warn("hub: record DC history", "count", len(batch), "err", err)
	}
}
