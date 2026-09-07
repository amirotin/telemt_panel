package hub

import (
	"sync"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// refusalsTotal is the "a client asked and did not get through" figure of
// GET /v1/stats/summary: every failed handshake plus every connection
// Telemt classified as bad. Both are cumulative counters since the proxy
// started.
//
// handshake_timeouts_total is used ONLY as the fallback for a Telemt build
// old enough not to send handshake_failures_by_class: on a current build a
// timed-out handshake is one of the classes inside that breakdown, so
// adding both would count it twice.
func refusalsTotal(s *telemt.SummaryData) uint64 {
	if s == nil {
		return 0
	}
	total := s.ConnectionsBadTotal
	if len(s.HandshakeFailuresByClass) == 0 {
		return total + s.HandshakeTimeoutsTotal
	}
	for _, c := range s.HandshakeFailuresByClass {
		total += c.Total
	}
	return total
}

// counterAccumulator turns one of Telemt's cumulative counters into the
// monotonic series the history ring stores, so that a dashboard tile can
// read it the same way it reads traffic: newest − oldest over the window.
// Two series use it — "refusals" and "attempts" — and Сводка's «Качество
// подключений» divides one window delta by the other, which only works if
// both are counted the same way.
//
// Two things it has to survive, neither of which a raw counter does:
//
//   - The panel outliving several Telemt runs. A restart zeroes Telemt's
//     counters, which on a raw series looks like a huge NEGATIVE delta and
//     erases the window. An uptime that went backwards is the restart
//     signal (a counter that went backwards on its own is treated the same
//     way — the only other thing that can produce one is a reset), and the
//     post-restart value is then folded in whole, as refusals that really
//     did happen since.
//
//   - The panel starting against a proxy that has been up for weeks. The
//     first sample is a BASELINE contributing nothing: its millions of
//     lifetime refusals did not happen in the last fifteen minutes, and
//     recording them would make the first window read as a catastrophe.
type counterAccumulator struct {
	mu         sync.Mutex
	seen       bool
	prevRaw    uint64
	prevUptime float64
	total      uint64
}

// observe folds one stats sample into the running total and returns the
// new total — the value recorded as this tick's history point.
func (a *counterAccumulator) observe(raw uint64, uptimeSeconds float64) uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case !a.seen:
		// Baseline — see the doc comment.
	case uptimeSeconds < a.prevUptime || raw < a.prevRaw:
		a.total += raw
	default:
		a.total += raw - a.prevRaw
	}
	a.seen = true
	a.prevRaw = raw
	a.prevUptime = uptimeSeconds
	return a.total
}
