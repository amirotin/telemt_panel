package httpapi

import (
	"net/http"
	"strconv"
	"strings"
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

// historyKnownMetrics is the fixed set of store series names the hub records.
// Entity series are validated separately by isKnownHistoryMetric.
// A metric outside this set is 400 bad_request, per the brief; "health" is
// accepted (it's a real declared metric, just an always-empty one until a
// future milestone records it) so it degrades to empty points instead.
var historyKnownMetrics = map[string]bool{
	"connections":              true,
	"active_users":             true,
	"traffic":                  true,
	"refusals":                 true,
	"attempts":                 true,
	"health":                   true,
	"mode.route":               true,
	"telemt.available":         true,
	"telemt.unavailable":       true,
	"dc.coverage_pct":          true,
	"upstream.healthy_total":   true,
	"upstream.unhealthy_total": true,
}

func isKnownHistoryMetric(metric string) bool {
	if historyKnownMetrics[metric] {
		return true
	}
	parts := strings.Split(metric, ".")
	if len(parts) != 3 {
		return false
	}
	switch parts[0] {
	case "dc":
		if _, err := strconv.ParseInt(parts[1], 10, 16); err != nil {
			return false
		}
		return parts[2] == "rtt_ms" || parts[2] == "coverage_pct"
	case "upstream":
		if _, err := strconv.ParseUint(parts[1], 10, 32); err != nil {
			return false
		}
		return parts[2] == "healthy" || parts[2] == "unhealthy" || parts[2] == "latency_ms"
	default:
		return false
	}
}

// historyPointView mirrors one entry of HistorySeries.points.
type historyPointView struct {
	TS   int64    `json:"ts"`
	V    float64  `json:"v"`
	Tier string   `json:"tier,omitempty"`
	Max  *float64 `json:"max,omitempty"`
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

type historyEventsView struct {
	Range         string               `json:"range"`
	RetentionSecs int64                `json:"retention_secs"`
	Events        []store.HistoryEvent `json:"events"`
}

// handleGetHistory implements GET /api/history?metric=&range=: a read of
// the active store. Never errors on empty history — an unrecorded,
// disabled or not-yet-populated metric comes back with points: [].
func (s *Server) handleGetHistory(w http.ResponseWriter, r *http.Request) {
	metric := r.URL.Query().Get("metric")
	if !isKnownHistoryMetric(metric) {
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

// handleGetHistoryEvents returns safe, structured transition events from the
// store. It never proxies Telemt's raw runtime-event ring and therefore cannot
// expose log text, IP history, endpoints or configuration snapshots.
func (s *Server) handleGetHistoryEvents(w http.ResponseWriter, r *http.Request) {
	rangeParam := r.URL.Query().Get("range")
	window, ok := historyRanges[rangeParam]
	if !ok {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "unknown range")
		return
	}
	limit := 200
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 500 {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "limit must be between 1 and 500")
			return
		}
		limit = parsed
	}
	events, err := s.st.ListHistoryEvents(store.HistoryEventFilter{
		From:     time.Now().Add(-window),
		Limit:    limit,
		Category: store.StorageEvents,
		Kind:     r.URL.Query().Get("kind"),
		Entity:   r.URL.Query().Get("entity"),
	})
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read history events")
		return
	}
	if events == nil {
		events = []store.HistoryEvent{}
	}
	policies, err := s.st.ListStoragePolicies()
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read history policy")
		return
	}
	retentionSecs := int64(0)
	for _, policy := range policies {
		if policy.Category == store.StorageEvents && policy.Enabled {
			retentionSecs = int64(time.Duration(policy.RetentionDays) * 24 * time.Hour / time.Second)
			break
		}
	}
	writeJSON(w, http.StatusOK, historyEventsView{Range: rangeParam, RetentionSecs: retentionSecs, Events: events})
}

func toHistoryPoints(points []store.MetricPoint) []historyPointView {
	out := make([]historyPointView, len(points))
	for i, p := range points {
		out[i] = historyPointView{TS: p.TS, V: p.Value}
		if p.Tier != store.MetricTierRaw {
			out[i].Tier = string(p.Tier)
			maxValue := p.Max
			out[i].Max = &maxValue
		}
	}
	return out
}
