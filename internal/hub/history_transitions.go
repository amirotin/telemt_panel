package hub

import (
	"log/slog"
	"math"
	"strconv"
	"sync"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

const (
	eventDCChanged       = "dc.coverage.changed"
	eventRouteChanged    = "route.mode.changed"
	eventUpstreamChanged = "upstream.health.changed"
	eventTelemtChanged   = "telemt.availability.changed"
)

// historyTransitionState holds the last successfully observed states. The
// first observation establishes a baseline and never creates a fake recovery
// event after panel startup.
type historyTransitionState struct {
	mu sync.Mutex

	availabilityKnown bool
	available         bool
	routeKnown        bool
	route             string
	dcCoverage        map[int16]int
	upstreamHealth    map[int]bool
}

func (h *Hub) resetUpstreamHealthBaseline() {
	t := &h.transitions
	t.mu.Lock()
	t.upstreamHealth = nil
	t.mu.Unlock()
}

func (h *Hub) resetDCCoverageBaseline() {
	t := &h.transitions
	t.mu.Lock()
	t.dcCoverage = nil
	t.mu.Unlock()
}

func (h *Hub) observeTelemtAvailability(available bool) {
	if h.st == nil {
		return
	}
	t := &h.transitions
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.availabilityKnown {
		t.availabilityKnown = true
		t.available = available
		return
	}
	if t.available == available {
		return
	}
	state, previous, severity := "unavailable", "available", "critical"
	if available {
		state, previous, severity = "available", "unavailable", "info"
	}
	if h.appendHistoryTransition(store.HistoryEvent{
		Category: store.StorageEvents, Kind: eventTelemtChanged, Entity: "telemt",
		State: state, PreviousState: previous, Severity: severity,
	}) {
		t.available = available
	}
}

func (h *Hub) observeRouteMode(gates *telemt.RuntimeGatesData) {
	if h.st == nil || gates == nil {
		return
	}
	route := routeModeName(gates)
	t := &h.transitions
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.routeKnown {
		t.routeKnown = true
		t.route = route
		return
	}
	if t.route == route {
		return
	}
	severity := "info"
	if route == "fallback" {
		severity = "warning"
	}
	if h.appendHistoryTransition(store.HistoryEvent{
		Category: store.StorageEvents, Kind: eventRouteChanged, Entity: "route",
		State: route, PreviousState: t.route, Severity: severity,
	}) {
		t.route = route
	}
}

func (h *Hub) observeUpstreamHealth(upstreams []telemt.RuntimeUpstreamQualityUpstreamData) {
	if h.st == nil {
		return
	}
	t := &h.transitions
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.upstreamHealth == nil {
		t.upstreamHealth = make(map[int]bool, len(upstreams))
		for _, upstream := range upstreams {
			t.upstreamHealth[upstream.UpstreamID] = upstream.Healthy
		}
		return
	}
	seen := make(map[int]bool, len(upstreams))
	for _, upstream := range upstreams {
		id := upstream.UpstreamID
		seen[id] = true
		previous, known := t.upstreamHealth[id]
		if !known {
			t.upstreamHealth[id] = upstream.Healthy
			continue
		}
		if previous == upstream.Healthy {
			continue
		}
		state, previousState, severity := "unhealthy", "healthy", "warning"
		if upstream.Healthy {
			state, previousState, severity = "healthy", "unhealthy", "info"
		}
		if h.appendHistoryTransition(store.HistoryEvent{
			Category: store.StorageEvents, Kind: eventUpstreamChanged,
			Entity: "upstream:" + strconv.Itoa(id), State: state,
			PreviousState: previousState, Severity: severity,
		}) {
			t.upstreamHealth[id] = upstream.Healthy
		}
	}
	for id := range t.upstreamHealth {
		if !seen[id] {
			delete(t.upstreamHealth, id)
		}
	}
}

func (h *Hub) observeDCCoverage(dcs []telemt.DcStatus) {
	if h.st == nil {
		return
	}
	t := &h.transitions
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.dcCoverage == nil {
		t.dcCoverage = make(map[int16]int, len(dcs))
		for _, dc := range dcs {
			t.dcCoverage[dc.DC] = normalizedCoverage(dc.CoveragePct)
		}
		return
	}
	seen := make(map[int16]bool, len(dcs))
	for _, dc := range dcs {
		seen[dc.DC] = true
		coverage := normalizedCoverage(dc.CoveragePct)
		previous, known := t.dcCoverage[dc.DC]
		if !known {
			t.dcCoverage[dc.DC] = coverage
			continue
		}
		if previous == coverage {
			continue
		}
		severity := "warning"
		if coverage == 100 {
			severity = "info"
		} else if coverage == 0 {
			severity = "critical"
		}
		route := "rpc"
		if dc.DC < 0 {
			route = "media"
		}
		if h.appendHistoryTransition(store.HistoryEvent{
			Category: store.StorageEvents, Kind: eventDCChanged,
			Entity: "dc:" + strconv.Itoa(int(dc.DC)), State: strconv.Itoa(coverage),
			PreviousState: strconv.Itoa(previous), Severity: severity,
			Attributes: map[string]string{"route": route},
		}) {
			t.dcCoverage[dc.DC] = coverage
		}
	}
	for id := range t.dcCoverage {
		if !seen[id] {
			delete(t.dcCoverage, id)
		}
	}
}

func (h *Hub) appendHistoryTransition(event store.HistoryEvent) bool {
	now := time.Now
	if h.now != nil {
		now = h.now
	}
	event.TS = now().UTC()
	if err := h.st.AppendHistoryEvent(event); err != nil {
		slog.Warn("hub: record history transition", "kind", event.Kind, "entity", event.Entity, "err", err)
		return false
	}
	return true
}

func routeModeName(gates *telemt.RuntimeGatesData) string {
	switch routeModeValue(gates) {
	case routeModeMiddle:
		return "me"
	case routeModeFallback:
		return "fallback"
	default:
		return "direct"
	}
}

func normalizedCoverage(value float64) int {
	value = math.Max(0, math.Min(100, value))
	bands := [...]int{0, 33, 66, 100}
	best := bands[0]
	distance := math.Abs(value - float64(best))
	for _, band := range bands[1:] {
		if candidate := math.Abs(value - float64(band)); candidate < distance {
			best, distance = band, candidate
		}
	}
	return best
}
