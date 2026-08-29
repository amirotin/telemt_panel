package hub

import (
	"testing"

	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func TestRefusalsTotalSumsFailuresAndBadConnections(t *testing.T) {
	s := &telemt.SummaryData{
		ConnectionsBadTotal:    10,
		HandshakeTimeoutsTotal: 7,
		HandshakeFailuresByClass: []telemt.ClassCount{
			{Class: "timeout", Total: 7},
			{Class: "unexpected_eof", Total: 3},
		},
	}
	// 10 bad + (7 + 3) failures. handshake_timeouts_total is NOT added on
	// top: its 7 are already the "timeout" class of the breakdown.
	if got := refusalsTotal(s); got != 20 {
		t.Errorf("refusalsTotal = %d, want 20", got)
	}
}

// A Telemt old enough to send no by-class breakdown still has to produce a
// figure — handshake_timeouts_total is the only failure counter it has.
func TestRefusalsTotalFallsBackToTimeoutsWithoutBreakdown(t *testing.T) {
	s := &telemt.SummaryData{ConnectionsBadTotal: 4, HandshakeTimeoutsTotal: 5}
	if got := refusalsTotal(s); got != 9 {
		t.Errorf("refusalsTotal = %d, want 9", got)
	}
	if got := refusalsTotal(nil); got != 0 {
		t.Errorf("refusalsTotal(nil) = %d, want 0", got)
	}
}

// The first sample is a baseline: a proxy up for weeks arrives with
// millions of lifetime refusals, none of which happened in the window the
// dashboard is about to render.
func TestRefusalsAccumulatorFirstSampleIsBaseline(t *testing.T) {
	var a refusalsAccumulator
	if got := a.observe(1_000_000, 3600); got != 0 {
		t.Errorf("first observe = %d, want 0", got)
	}
}

func TestRefusalsAccumulatorAccumulatesDeltas(t *testing.T) {
	var a refusalsAccumulator
	a.observe(100, 10)
	if got := a.observe(105, 15); got != 5 {
		t.Errorf("after +5 = %d, want 5", got)
	}
	if got := a.observe(105, 20); got != 5 {
		t.Errorf("unchanged counter = %d, want 5 (no growth)", got)
	}
	if got := a.observe(112, 25); got != 12 {
		t.Errorf("after +7 = %d, want 12", got)
	}
}

// A Telemt restart zeroes the counters and the uptime. Read raw, that is a
// large negative delta; the accumulator must instead fold the post-restart
// value in whole and never go backwards.
func TestRefusalsAccumulatorSurvivesRestart(t *testing.T) {
	var a refusalsAccumulator
	a.observe(100, 3600)
	a.observe(140, 3660) // total 40
	got := a.observe(3, 5)
	if got != 43 {
		t.Errorf("after restart = %d, want 43 (40 + the 3 since the restart)", got)
	}
	if next := a.observe(9, 65); next != 49 {
		t.Errorf("after restart + 6 = %d, want 49", next)
	}
}

// A counter that fell without the uptime falling is the same event seen
// through a coarser clock (or a stats reset) — treated as a reset, never as
// a negative delta.
func TestRefusalsAccumulatorTreatsCounterRegressionAsReset(t *testing.T) {
	var a refusalsAccumulator
	a.observe(100, 3600)
	a.observe(140, 3660)
	if got := a.observe(2, 3720); got != 42 {
		t.Errorf("counter regression = %d, want 42", got)
	}
}

// The ring is the window: store.Memory keeps a bounded number of points per
// metric, so a long-lived panel's "refusals" series is the newest slice of
// it and MetricRange's fromTS trims it further. Both together are what
// makes GET /api/history?metric=refusals&range=15m a 15-minute question.
func TestRefusalsSeriesIsBoundedByTheRingAndTheWindow(t *testing.T) {
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// 400 ticks, one per simulated second, more than the ring holds.
	const ticks = 400
	var a refusalsAccumulator
	for i := 0; i < ticks; i++ {
		total := a.observe(uint64(i), float64(i))
		if err := st.RecordMetric(metricRefusals, store.MetricPoint{TS: int64(i), Value: float64(total)}); err != nil {
			t.Fatalf("RecordMetric: %v", err)
		}
	}

	all, err := st.MetricRange(metricRefusals, 0)
	if err != nil {
		t.Fatalf("MetricRange: %v", err)
	}
	if len(all) == 0 || len(all) >= ticks {
		t.Fatalf("ring kept %d points, want a bounded slice of %d", len(all), ticks)
	}
	if last := all[len(all)-1]; last.TS != ticks-1 {
		t.Errorf("newest point ts = %d, want %d — the ring must evict the OLDEST", last.TS, ticks-1)
	}

	// The window delta the tile renders: newest − oldest across the range.
	windowed, err := st.MetricRange(metricRefusals, int64(ticks-60))
	if err != nil {
		t.Fatalf("MetricRange(window): %v", err)
	}
	if len(windowed) != 60 {
		t.Fatalf("windowed points = %d, want 60", len(windowed))
	}
	delta := windowed[len(windowed)-1].Value - windowed[0].Value
	if delta != 59 {
		t.Errorf("window delta = %v, want 59", delta)
	}
}
