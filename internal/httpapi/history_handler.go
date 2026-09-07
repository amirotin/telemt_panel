package httpapi

import (
	"encoding/base64"
	"errors"
	"fmt"
	"math"
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
	"30d": 30 * 24 * time.Hour,
	"90d": 90 * 24 * time.Hour,
}

var userTrafficRanges = map[string]time.Duration{
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
	"1y":  365 * 24 * time.Hour,
}

var trafficReportRanges = map[string]time.Duration{
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
	"30d": 30 * 24 * time.Hour,
	"1y":  365 * 24 * time.Hour,
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
	TS              int64    `json:"ts"`
	V               float64  `json:"v"`
	Tier            string   `json:"tier,omitempty"`
	Max             *float64 `json:"max,omitempty"`
	Min             *float64 `json:"min,omitempty"`
	Samples         int64    `json:"samples,omitempty"`
	FirstTS         *int64   `json:"first_observed_epoch_secs,omitempty"`
	LastTS          *int64   `json:"last_observed_epoch_secs,omitempty"`
	Delta           *float64 `json:"observed_delta,omitempty"`
	ObservedSeconds *int64   `json:"observed_seconds,omitempty"`
	Gaps            *int64   `json:"gaps,omitempty"`
}

type userTrafficPointView struct {
	TS   int64  `json:"ts"`
	V    int64  `json:"v"`
	Tier string `json:"tier"`
}

// historySeriesView mirrors api/openapi.yaml HistorySeries.
type historySeriesView struct {
	Metric        string `json:"metric"`
	Range         string `json:"range"`
	State         string `json:"state"`
	RequestedFrom int64  `json:"requested_from_epoch_secs"`
	// RetentionSecs includes the live RAM window when disk history is disabled.
	// Gaps and the sample cap may shorten the actual returned coverage.
	RetentionSecs int64              `json:"retention_secs"`
	AvailableFrom *int64             `json:"available_from_epoch_secs,omitempty"`
	Source        *bool              `json:"source_available,omitempty"`
	Points        []historyPointView `json:"points"`
}

type userTrafficHistorySeriesView struct {
	Metric          string                       `json:"metric"`
	Range           string                       `json:"range"`
	State           string                       `json:"state"`
	RequestedFrom   int64                        `json:"requested_from_epoch_secs"`
	RetentionSecs   int64                        `json:"retention_secs"`
	AvailableFrom   *int64                       `json:"available_from_epoch_secs,omitempty"`
	Source          *bool                        `json:"source_available,omitempty"`
	SourceState     store.UserTrafficSourceState `json:"source_state"`
	Continuity      store.UserTrafficContinuity  `json:"continuity"`
	Durability      string                       `json:"durability"`
	ObservedSince   int64                        `json:"observed_since_epoch_secs,omitempty"`
	ObservedThrough int64                        `json:"observed_through_epoch_secs,omitempty"`
	Points          []userTrafficPointView       `json:"points"`
}

type trafficCollectionView struct {
	SourceState     store.UserTrafficSourceState `json:"source_state"`
	Continuity      store.UserTrafficContinuity  `json:"continuity"`
	Durability      string                       `json:"durability"`
	RetentionSecs   int64                        `json:"retention_secs"`
	ObservedSince   int64                        `json:"observed_since_epoch_secs,omitempty"`
	ObservedThrough int64                        `json:"observed_through_epoch_secs,omitempty"`
}

type trafficSummaryView struct {
	Range              string                  `json:"range"`
	State              string                  `json:"state"`
	RequestedFrom      int64                   `json:"requested_from_epoch_secs"`
	TotalBytes         int64                   `json:"total_bytes"`
	PreviousTotalBytes *int64                  `json:"previous_total_bytes,omitempty"`
	Points             []userTrafficPointView  `json:"points"`
	TopUsers           []store.UserTrafficRank `json:"top_users"`
	Collection         trafficCollectionView   `json:"collection"`
}

type trafficUsersView struct {
	Range      string                  `json:"range"`
	Users      []store.UserTrafficRank `json:"users"`
	NextCursor string                  `json:"next_cursor,omitempty"`
	Collection trafficCollectionView   `json:"collection"`
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
// the active store. Optional disk persistence does not disable live samples.
// An unrecorded or expired metric comes back with points: [].
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
	retentionSecs := int64(s.st.MetricRetention(metric) / time.Second)
	readFrom := max(fromTS, now.Unix()-retentionSecs)
	points, err := s.st.MetricRange(metric, readFrom)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read history")
		return
	}

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
	collector, err := s.st.UserTrafficCollectorState()
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read traffic collector state")
		return
	}
	summaries, err := s.st.UserTrafficSummaries()
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read user traffic summary")
		return
	}
	summary := summaries[username]
	state, availableFrom := userTrafficHistoryState(now.Unix(), fromTS, retentionSecs, summary.ObservedSinceEpochSecs, points)
	sourceState := collector.SourceState
	if collector.LastSuccessTS == 0 || now.Unix()-collector.LastSuccessTS > int64(historySourceFreshness/time.Second) {
		sourceState = store.UserTrafficUnavailable
	}
	continuity := collector.Continuity
	if summary.Continuity == store.UserTrafficPartial {
		continuity = store.UserTrafficPartial
	}
	durability := "volatile"
	if s.st.Info().Durable {
		durability = "durable"
	}
	writeJSON(w, http.StatusOK, userTrafficHistorySeriesView{
		Metric:          userTrafficMetricLabel(username),
		Range:           rangeParam,
		State:           state,
		RequestedFrom:   fromTS,
		RetentionSecs:   retentionSecs,
		AvailableFrom:   availableFrom,
		Source:          s.historySourceAvailability(now),
		SourceState:     sourceState,
		Continuity:      continuity,
		Durability:      durability,
		ObservedSince:   summary.ObservedSinceEpochSecs,
		ObservedThrough: collector.LastSuccessTS,
		Points:          toUserTrafficHistoryPoints(points),
	})
}

func (s *Server) handleGetTrafficSummary(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	rangeParam := r.URL.Query().Get("range")
	from, to, ok := trafficReportBounds(rangeParam, now)
	if !ok {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "unknown range")
		return
	}
	total, points, err := s.st.UserTrafficAggregate(from, to)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not aggregate user traffic")
		return
	}
	if rangeParam == "month" {
		summaries, summaryErr := s.st.UserTrafficSummaries()
		if summaryErr != nil {
			auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read user traffic totals")
			return
		}
		total = 0
		for _, summary := range summaries {
			if summary.CurrentMonthBytes > math.MaxInt64-total {
				auth.WriteError(w, http.StatusInternalServerError, "internal_error", "user traffic total exceeds supported range")
				return
			}
			total += summary.CurrentMonthBytes
		}
	}
	window := to - from
	previousTotal, _, err := s.st.UserTrafficAggregate(from-window, from)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not aggregate previous user traffic")
		return
	}
	ranks, err := s.st.UserTrafficRanking(from, to, false, 5, nil)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not rank user traffic")
		return
	}
	collection, err := s.trafficCollection(now)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read traffic collection state")
		return
	}
	state, _ := userTrafficHistoryState(to, from, collection.RetentionSecs, collection.ObservedSince, points)
	var previous *int64
	if collection.ObservedSince != 0 && collection.ObservedSince <= from-window && collection.RetentionSecs >= 2*window {
		previous = &previousTotal
	}
	writeJSON(w, http.StatusOK, trafficSummaryView{
		Range: rangeParam, State: state, RequestedFrom: from, TotalBytes: total,
		PreviousTotalBytes: previous, Points: toUserTrafficHistoryPoints(points),
		TopUsers: ranks, Collection: collection,
	})
}

func (s *Server) handleGetTrafficUsers(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	rangeParam := r.URL.Query().Get("range")
	from, to, ok := trafficReportBounds(rangeParam, now)
	if !ok {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "unknown range")
		return
	}
	includeDeleted := false
	if raw := r.URL.Query().Get("include_deleted"); raw != "" {
		var err error
		includeDeleted, err = strconv.ParseBool(raw)
		if err != nil {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "include_deleted must be a boolean")
			return
		}
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 200 {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "limit must be between 1 and 200")
			return
		}
		limit = parsed
	}
	cursor, err := decodeUserTrafficCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid cursor")
		return
	}
	ranks, err := s.st.UserTrafficRanking(from, to, includeDeleted, limit+1, cursor)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not rank user traffic")
		return
	}
	nextCursor := ""
	if len(ranks) > limit {
		last := ranks[limit-1]
		nextCursor = encodeUserTrafficCursor(last.Bytes, last.Username)
		ranks = ranks[:limit]
	}
	collection, err := s.trafficCollection(now)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read traffic collection state")
		return
	}
	writeJSON(w, http.StatusOK, trafficUsersView{
		Range: rangeParam, Users: ranks, NextCursor: nextCursor, Collection: collection,
	})
}

func trafficReportBounds(rangeParam string, now time.Time) (int64, int64, bool) {
	to := now.Unix()
	if rangeParam == "month" {
		from := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).Unix()
		return from, to, true
	}
	window, ok := trafficReportRanges[rangeParam]
	if !ok {
		return 0, 0, false
	}
	return now.Add(-window).Unix(), to, true
}

func (s *Server) trafficCollection(now time.Time) (trafficCollectionView, error) {
	collector, err := s.st.UserTrafficCollectorState()
	if err != nil {
		return trafficCollectionView{}, err
	}
	summaries, err := s.st.UserTrafficSummaries()
	if err != nil {
		return trafficCollectionView{}, err
	}
	sourceState := collector.SourceState
	if collector.LastSuccessTS == 0 || now.Unix()-collector.LastSuccessTS > int64(historySourceFreshness/time.Second) {
		sourceState = store.UserTrafficUnavailable
	}
	continuity := collector.Continuity
	observedSince := int64(0)
	for _, summary := range summaries {
		if observedSince == 0 || summary.ObservedSinceEpochSecs < observedSince {
			observedSince = summary.ObservedSinceEpochSecs
		}
		if summary.Continuity == store.UserTrafficPartial {
			continuity = store.UserTrafficPartial
		}
	}
	durability := "volatile"
	if s.st.Info().Durable {
		durability = "durable"
	}
	return trafficCollectionView{
		SourceState: sourceState, Continuity: continuity, Durability: durability,
		RetentionSecs: int64(s.st.UserTrafficRetention() / time.Second),
		ObservedSince: observedSince, ObservedThrough: collector.LastSuccessTS,
	}, nil
}

func encodeUserTrafficCursor(bytes int64, username string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("%d\n%s", bytes, username)))
}

func decodeUserTrafficCursor(value string) (*store.UserTrafficRankCursor, error) {
	if value == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, err
	}
	parts := strings.SplitN(string(raw), "\n", 2)
	if len(parts) != 2 || parts[1] == "" {
		return nil, errors.New("invalid cursor payload")
	}
	bytes, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || bytes < 0 {
		return nil, errors.New("invalid cursor bytes")
	}
	return &store.UserTrafficRankCursor{Bytes: bytes, Username: parts[1]}, nil
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
	if points[0].Min != nil {
		oldest = points[0].FirstTS
	}
	state := "ready"
	requestedWindow := nowTS - fromTS
	if retentionSecs < requestedWindow || oldest > fromTS+historyPointTolerance(points[0]) {
		state = "partial"
	}
	for i, point := range points {
		if point.Gaps > 0 {
			state = "partial"
		}
		if i > 0 {
			previous := points[i-1]
			end := previous.TS
			if previous.LastTS > end {
				end = previous.LastTS
			}
			if point.TS-end > max(historyPointTolerance(previous), historyPointTolerance(point)) {
				state = "partial"
			}
		}
	}
	last := points[len(points)-1]
	if nowTS-max(last.TS, last.LastTS) > historyPointTolerance(last) {
		state = "partial"
	}
	return state, &oldest
}

func historyPointTolerance(point store.MetricPoint) int64 {
	switch point.Tier {
	case store.MetricTierFive:
		return 300
	case store.MetricTierQuarter:
		return 900
	case store.MetricTierHour:
		return 3600
	default:
		return 120
	}
}

func userTrafficHistoryState(nowTS, fromTS, retentionSecs, observedSince int64, points []store.UserTrafficPoint) (string, *int64) {
	if retentionSecs == 0 {
		return "disabled", nil
	}
	if len(points) == 0 {
		return "empty", nil
	}
	oldest := points[0].TS
	state := "ready"
	if retentionSecs < nowTS-fromTS || observedSince == 0 || observedSince > fromTS {
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
			out[i].Samples = p.Samples
			out[i].Min = p.Min
			if p.Min != nil {
				first, last, observed, gaps := p.FirstTS, p.LastTS, p.ObservedSeconds, p.Gaps
				out[i].FirstTS, out[i].LastTS = &first, &last
				out[i].ObservedSeconds, out[i].Gaps = &observed, &gaps
				out[i].Delta = p.Delta
			}
		}
	}
	return out
}

func toUserTrafficHistoryPoints(points []store.UserTrafficPoint) []userTrafficPointView {
	out := make([]userTrafficPointView, len(points))
	for i, point := range points {
		out[i] = userTrafficPointView{TS: point.TS, V: point.Bytes, Tier: string(point.Tier)}
	}
	return out
}
