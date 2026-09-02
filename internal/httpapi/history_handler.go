package httpapi

import (
	"net/http"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

// historyRanges maps openapi GetHistory's `range` enum to a lookback
// window. A longer requested range simply returns whatever shorter history
// the active store and category policy retain. GET /api/history never fails
// on an empty or partial result; `retention_secs` describes the policy.
var historyRanges = map[string]time.Duration{
	"15m": 15 * time.Minute,
	"30m": 30 * time.Minute,
	"1h":  time.Hour,
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
}

// historyKnownMetrics is the set of store series names the hub actually
// records (hub.go's recordStatsHistory) — matching the metric names in
// openapi's GetHistory enum minus "health", which nothing currently writes.
// A metric outside this set is 400 bad_request, per the brief; "health" is
// accepted (it's a real declared metric, just an always-empty one until a
// future milestone records it) so it degrades to empty points instead.
var historyKnownMetrics = map[string]bool{
	"connections":  true,
	"active_users": true,
	"traffic":      true,
	"refusals":     true,
	"attempts":     true,
	"health":       true,
}

// historyPointView mirrors one entry of HistorySeries.points.
type historyPointView struct {
	TS int64   `json:"ts"`
	V  float64 `json:"v"`
}

// historySeriesView mirrors api/openapi.yaml HistorySeries.
type historySeriesView struct {
	Metric string `json:"metric"`
	Range  string `json:"range"`
	// RetentionSecs is the selected metric category's retention. Zero means
	// that persistent history for the category is disabled.
	RetentionSecs int64              `json:"retention_secs"`
	Points        []historyPointView `json:"points"`
}

// handleGetHistory implements GET /api/history?metric=&range=: a read of
// the active store. Never errors on empty history — an unrecorded,
// disabled or not-yet-populated metric comes back with points: [].
func (s *Server) handleGetHistory(w http.ResponseWriter, r *http.Request) {
	metric := r.URL.Query().Get("metric")
	if !historyKnownMetrics[metric] {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "unknown metric")
		return
	}
	rangeParam := r.URL.Query().Get("range")
	window, ok := historyRanges[rangeParam]
	if !ok {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "unknown range")
		return
	}

	fromTS := time.Now().Add(-window).Unix()
	points, err := s.st.MetricRange(metric, fromTS)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read history")
		return
	}

	retentionSecs := int64(s.st.MetricRetention(metric) / time.Second)

	writeJSON(w, http.StatusOK, historySeriesView{
		Metric:        metric,
		Range:         rangeParam,
		RetentionSecs: retentionSecs,
		Points:        toHistoryPoints(points),
	})
}

func toHistoryPoints(points []store.MetricPoint) []historyPointView {
	out := make([]historyPointView, len(points))
	for i, p := range points {
		out[i] = historyPointView{TS: p.TS, V: p.Value}
	}
	return out
}
