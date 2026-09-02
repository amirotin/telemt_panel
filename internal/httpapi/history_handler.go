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

var userTrafficRanges = map[string]time.Duration{
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
}

const historySourceFreshness = 2 * time.Minute

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
	Metric        string `json:"metric"`
	Range         string `json:"range"`
	State         string `json:"state"`
	RequestedFrom int64  `json:"requested_from_epoch_secs"`
	// RetentionSecs is the selected metric category's retention. Zero means
	// that persistent history for the category is disabled.
	RetentionSecs int64              `json:"retention_secs"`
	AvailableFrom *int64             `json:"available_from_epoch_secs,omitempty"`
	Source        *bool              `json:"source_available,omitempty"`
	Points        []historyPointView `json:"points"`
}

type historyEventsView struct {
	Range         string               `json:"range"`
	State         string               `json:"state"`
	RequestedFrom int64                `json:"requested_from_epoch_secs"`
	RetentionSecs int64                `json:"retention_secs"`
	AvailableFrom *int64               `json:"available_from_epoch_secs,omitempty"`
	Source        *bool                `json:"source_available,omitempty"`
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

	now := time.Now()
	fromTS := now.Add(-window).Unix()
	points, err := s.st.MetricRange(metric, fromTS)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read history")
		return
	}

	retentionSecs := int64(s.st.MetricRetention(metric) / time.Second)
	source := s.historySourceAvailability(now)
	state, availableFrom := metricHistoryState(now.Unix(), fromTS, retentionSecs, points)

	writeJSON(w, http.StatusOK, historySeriesView{
		Metric:        metric,
		Range:         rangeParam,
		State:         state,
		RequestedFrom: fromTS,
		RetentionSecs: retentionSecs,
		AvailableFrom: availableFrom,
		Source:        source,
		Points:        toHistoryPoints(points),
	})
}

// handleGetUserTrafficHistory returns sparse per-user traffic buckets. It is
// separate from the generic metric endpoint so user names never become an
// open-ended metric-name grammar.
func (s *Server) handleGetUserTrafficHistory(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")
	if username == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "username is required")
		return
	}
	rangeParam := r.URL.Query().Get("range")
	window, ok := userTrafficRanges[rangeParam]
	if !ok {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "unknown range")
		return
	}
	now := time.Now()
	fromTS := now.Add(-window).Unix()
	points, err := s.st.UserTrafficRange(username, fromTS)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read user traffic history")
		return
	}
	retentionSecs := int64(s.st.UserTrafficRetention() / time.Second)
	state, availableFrom := metricHistoryState(now.Unix(), fromTS, retentionSecs, points)
	writeJSON(w, http.StatusOK, historySeriesView{
		Metric:        userTrafficMetricLabel(username),
		Range:         rangeParam,
		State:         state,
		RequestedFrom: fromTS,
		RetentionSecs: retentionSecs,
		AvailableFrom: availableFrom,
		Source:        s.historySourceAvailability(now),
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
	now := time.Now()
	from := now.Add(-window)
	events, err := s.st.ListHistoryEvents(store.HistoryEventFilter{
		From:     from,
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
	state := "ready"
	if retentionSecs == 0 {
		state = "disabled"
	} else if len(events) == 0 {
		state = "empty"
	} else if retentionSecs < int64(window/time.Second) {
		state = "partial"
	}
	var availableFrom *int64
	if len(events) > 0 {
		oldest := events[len(events)-1].TS.Unix()
		availableFrom = &oldest
	}
	writeJSON(w, http.StatusOK, historyEventsView{
		Range: rangeParam, State: state, RequestedFrom: from.Unix(), RetentionSecs: retentionSecs,
		AvailableFrom: availableFrom, Source: s.historySourceAvailability(now), Events: events,
	})
}

func metricHistoryState(nowTS, fromTS, retentionSecs int64, points []store.MetricPoint) (string, *int64) {
	if retentionSecs == 0 {
		return "disabled", nil
	}
	if len(points) == 0 {
		return "empty", nil
	}
	oldest := points[0].TS
	state := "ready"
	requestedWindow := nowTS - fromTS
	if retentionSecs < requestedWindow || oldest > fromTS+int64(2*time.Minute/time.Second) {
		state = "partial"
	}
	return state, &oldest
}

func (s *Server) historySourceAvailability(now time.Time) *bool {
	points, err := s.st.MetricRange("telemt.available", now.Add(-historySourceFreshness).Unix())
	if err != nil || len(points) == 0 {
		return nil
	}
	latest := points[len(points)-1]
	if latest.TS < now.Add(-historySourceFreshness).Unix() {
		return nil
	}
	available := latest.Value >= 0.5
	return &available
}

func userTrafficMetricLabel(username string) string {
	return "user." + username + ".traffic"
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
