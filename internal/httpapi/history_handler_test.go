package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

func TestHistoryAggregateMetadata(t *testing.T) {
	minimum, delta := 2.0, 5.0
	points := toHistoryPoints([]store.MetricPoint{
		{TS: 300, Value: 7, Tier: store.MetricTierFive, Min: &minimum, Max: 9, Samples: 3, FirstTS: 305, LastTS: 315, FirstValue: 2, Delta: &delta, ObservedSeconds: 10},
		{TS: 600, Value: 4, Tier: store.MetricTierQuarter, Max: 8, Samples: 6},
		{TS: 1500, Value: 1},
	})
	p := points[0]
	if p.Min == nil || *p.Min != 2 || p.Max == nil || *p.Max != 9 || p.Samples != 3 ||
		p.FirstTS == nil || *p.FirstTS != 305 || p.LastTS == nil || *p.LastTS != 315 ||
		p.FirstValue == nil || *p.FirstValue != 2 ||
		p.Delta == nil || *p.Delta != 5 || p.ObservedSeconds == nil || *p.ObservedSeconds != 10 || p.Gaps == nil || *p.Gaps != 0 {
		t.Fatalf("aggregate metadata lost: %+v", p)
	}
	if points[1].Min != nil || points[1].FirstTS != nil || points[1].FirstValue != nil || points[1].Delta != nil || points[1].ObservedSeconds != nil || points[2].Max != nil || points[2].FirstValue != nil {
		t.Fatalf("fabricated raw or legacy metadata: %+v", points)
	}
}

func TestHistoryStateUsesAggregateResolutionAndGaps(t *testing.T) {
	minimum := 1.0
	points := []store.MetricPoint{{TS: 3600, Tier: store.MetricTierHour, Min: &minimum, FirstTS: 3605, LastTS: 7000}}
	if state, from := metricHistoryState(7200, 1800, 86400, points); state != "ready" || from == nil || *from != 3605 {
		t.Fatalf("hourly history falsely partial: %s, %v", state, from)
	}
	points[0].Gaps = 1
	if state, _ := metricHistoryState(7200, 1800, 86400, points); state != "partial" {
		t.Fatalf("observation gap concealed: %s", state)
	}
}

func TestHistoryLongRanges(t *testing.T) {
	srv := newTestServer(t)
	for _, duration := range []string{"30d", "90d"} {
		w := httptest.NewRecorder()
		srv.handleGetHistory(w, httptest.NewRequest(http.MethodGet, "/api/history?metric=connections&range="+duration, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", duration, w.Code, w.Body.String())
		}
	}
}

func TestHistoryStateReportsUnobservedTail(t *testing.T) {
	points := []store.MetricPoint{{TS: 1000, Value: 1}, {TS: 1010, Value: 2}}
	if state, _ := metricHistoryState(1800, 1000, 7200, points); state != "partial" {
		t.Fatalf("stale series presented as complete: %s", state)
	}
}

func TestHandleGetHistoryDoesNotExtendIdleRAMRetention(t *testing.T) {
	srv := newTestServer(t)
	if err := srv.st.RecordMetric("connections", store.MetricPoint{TS: time.Now().Add(-3 * time.Hour).Unix(), Value: 12}); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	srv.handleGetHistory(w, httptest.NewRequest(http.MethodGet, "/api/history?metric=connections&range=24h", nil))
	var got historySeriesView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || got.State != "empty" || len(got.Points) != 0 || got.RetentionSecs != 7200 {
		t.Fatalf("expired live history = %+v, status=%d", got, w.Code)
	}
}

// TestHandleGetHistory_UnknownMetric covers the 400 bad_request case for an
// unrecognized metric name.
func TestHandleGetHistory_UnknownMetric(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	r := httptest.NewRequest("GET", "/api/history?metric=bogus&range=15m", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

func TestHandleGetHistory_UnknownRange(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	r := httptest.NewRequest("GET", "/api/history?metric=connections&range=bogus", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", w.Code, w.Body)
	}
}

// TestHandleGetHistory_EmptyIsNotAnError covers the R3 degrade contract: a
// known metric with nothing recorded yet is 200 with an empty points array,
// never an error.
func TestHandleGetHistory_EmptyIsNotAnError(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	r := httptest.NewRequest("GET", "/api/history?metric=connections&range=15m", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got historySeriesView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Metric != "connections" || got.Range != "15m" {
		t.Errorf("metric/range = %q/%q, want connections/15m", got.Metric, got.Range)
	}
	if got.State != "empty" || got.RequestedFrom == 0 {
		t.Errorf("history metadata = state %q, from %d", got.State, got.RequestedFrom)
	}
	if got.Points == nil {
		t.Error("points is JSON null, want an empty array")
	}
	if len(got.Points) != 0 {
		t.Errorf("points = %v, want empty", got.Points)
	}
}

// TestHandleGetHistory_ReturnsRecordedPoints covers the ordering/shape
// contract for a metric that does have data: points come back oldest
// first (store.MetricRange's own order) with the {ts, v} field names.
func TestHandleGetHistory_ReturnsRecordedPoints(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now().Unix()
	if err := srv.st.RecordMetric("connections", store.MetricPoint{TS: now - 10, Value: 3}); err != nil {
		t.Fatal(err)
	}
	if err := srv.st.RecordMetric("connections", store.MetricPoint{TS: now, Value: 5}); err != nil {
		t.Fatal(err)
	}

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	r := httptest.NewRequest("GET", "/api/history?metric=connections&range=15m", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got historySeriesView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Points) != 2 {
		t.Fatalf("points = %v, want 2", got.Points)
	}
	if got.Points[0].V != 3 || got.Points[1].V != 5 {
		t.Errorf("points = %+v, want oldest-first [3, 5]", got.Points)
	}
	if got.State != "partial" || got.AvailableFrom == nil {
		t.Errorf("newly collected series metadata = %+v", got)
	}
}

func TestHandleGetUserTrafficHistoryReportsPolicyAndSparseBuckets(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now().Unix()
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	request := func() historySeriesView {
		r := httptest.NewRequest("GET", "/api/users/alice/traffic-history?range=24h", nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", w.Code, w.Body)
		}
		var got historySeriesView
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got
	}

	policies, err := srv.st.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		if policies[i].Category == store.StorageUserTraffic {
			policies[i].Enabled = false
		}
	}
	if err := srv.st.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if got := request(); got.State != "disabled" || got.RetentionSecs != 0 || len(got.Points) != 0 {
		t.Fatalf("disabled response = %+v", got)
	}
	for i := range policies {
		if policies[i].Category == store.StorageUserTraffic {
			policies[i].Enabled = true
		}
	}
	if err := srv.st.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.st.ApplyUserTrafficSnapshot(store.UserTrafficSnapshot{
		ObservedAt: now - 1, SourceStartedAt: now - 3600, TelemetryEnabled: true,
		Users: []store.UserTrafficObservation{{Username: "alice", RawOctets: 100}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.st.ApplyUserTrafficSnapshot(store.UserTrafficSnapshot{
		ObservedAt: now, SourceStartedAt: now - 3600, TelemetryEnabled: true,
		Users: []store.UserTrafficObservation{{Username: "alice", RawOctets: 2148}},
	}); err != nil {
		t.Fatal(err)
	}
	got := request()
	if got.Metric != "user.alice.traffic" || got.State != "partial" || len(got.Points) != 1 || got.Points[0].V != 2048 || got.Points[0].Tier != "15m" {
		t.Fatalf("traffic response = %+v", got)
	}
}

func TestTrafficSummaryAndRanking(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now().UTC().Truncate(time.Second)
	source := now.Add(-time.Hour).Unix()
	for _, snapshot := range []store.UserTrafficSnapshot{
		{ObservedAt: now.Add(-2 * time.Minute).Unix(), SourceStartedAt: source, TelemetryEnabled: true,
			Users: []store.UserTrafficObservation{{Username: "alice", RawOctets: 10}, {Username: "bob", RawOctets: 20}}},
		{ObservedAt: now.Add(-time.Minute).Unix(), SourceStartedAt: source, TelemetryEnabled: true,
			Users: []store.UserTrafficObservation{{Username: "alice", RawOctets: 110}, {Username: "bob", RawOctets: 70}}},
	} {
		if _, err := srv.st.ApplyUserTrafficSnapshot(snapshot); err != nil {
			t.Fatal(err)
		}
	}
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	get := func(path string, target any) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d: %s", path, w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), target); err != nil {
			t.Fatal(err)
		}
	}

	var summary trafficSummaryView
	get("/api/traffic/summary?range=24h", &summary)
	if summary.TotalBytes != 150 || len(summary.Points) != 1 || summary.Points[0].V != 150 || len(summary.TopUsers) != 2 || summary.TopUsers[0].Username != "alice" {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.Collection.SourceState != store.UserTrafficCollecting || summary.Collection.Durability != "volatile" {
		t.Fatalf("collection = %+v", summary.Collection)
	}

	var first trafficUsersView
	get("/api/traffic/users?range=24h&limit=1", &first)
	if len(first.Users) != 1 || first.Users[0].Username != "alice" || first.NextCursor == "" {
		t.Fatalf("first page = %+v", first)
	}
	var second trafficUsersView
	get("/api/traffic/users?range=24h&limit=1&cursor="+first.NextCursor, &second)
	if len(second.Users) != 1 || second.Users[0].Username != "bob" || second.NextCursor != "" {
		t.Fatalf("second page = %+v", second)
	}

	policies, err := srv.st.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for index := range policies {
		if policies[index].Category == store.StorageUserTraffic {
			policies[index].Enabled = false
		}
	}
	if err := srv.st.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	var month trafficSummaryView
	get("/api/traffic/summary?range=month", &month)
	if month.TotalBytes != 150 || month.State != "disabled" || len(month.Points) != 0 {
		t.Fatalf("disabled month summary = %+v", month)
	}
}

func TestMetricHistoryStateDistinguishesDisabledEmptyPartialAndReady(t *testing.T) {
	now := int64(10_000)
	from := now - 600
	var continuous []store.MetricPoint
	for ts := from + 30; ts <= now; ts += 60 {
		continuous = append(continuous, store.MetricPoint{TS: ts, Value: 1})
	}
	for _, tc := range []struct {
		name      string
		retention int64
		points    []store.MetricPoint
		want      string
	}{
		{name: "disabled", want: "disabled"},
		{name: "empty", retention: 600, want: "empty"},
		{name: "partial retention", retention: 300, points: []store.MetricPoint{{TS: from, Value: 1}}, want: "partial"},
		{name: "partial collection", retention: 600, points: []store.MetricPoint{{TS: from + 180, Value: 1}}, want: "partial"},
		{name: "ready", retention: 600, points: continuous, want: "ready"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := metricHistoryState(now, from, tc.retention, tc.points)
			if got != tc.want {
				t.Fatalf("state = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestToHistoryPointsPublishesAggregatePeak(t *testing.T) {
	points := toHistoryPoints([]store.MetricPoint{
		{TS: 1, Value: 3},
		{TS: 60, Value: 4, Tier: store.MetricTierMinute, Max: 9, Samples: 12},
	})
	if points[0].Tier != "" || points[0].Max != nil {
		t.Fatalf("raw point unexpectedly exposes aggregate metadata: %+v", points[0])
	}
	if points[1].Tier != "1m" || points[1].Max == nil || *points[1].Max != 9 {
		t.Fatalf("aggregate point = %+v, want tier=1m max=9", points[1])
	}
	zero := toHistoryPoints([]store.MetricPoint{{TS: 120, Tier: store.MetricTierMinute}})
	if zero[0].Max == nil || *zero[0].Max != 0 {
		t.Fatalf("zero aggregate max must remain present: %+v", zero[0])
	}
}

// TestHandleGetHistory_AcceptsRefusals covers the metric the M5 Отказы tile
// reads: it is in the openapi enum and in historyKnownMetrics, so it comes
// back 200 with its recorded points rather than 400 unknown metric.
func TestHandleGetHistory_AcceptsRefusals(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now().Unix()
	for i, v := range []float64{0, 4, 9} {
		if err := srv.st.RecordMetric("refusals", store.MetricPoint{TS: now - int64(20-i*10), Value: v}); err != nil {
			t.Fatal(err)
		}
	}

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	r := httptest.NewRequest("GET", "/api/history?metric=refusals&range=15m", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got historySeriesView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Points) != 3 {
		t.Fatalf("points = %v, want 3", got.Points)
	}
	// The tile reads newest − oldest: nine refusals across the window.
	if d := got.Points[2].V - got.Points[0].V; d != 9 {
		t.Errorf("window delta = %v, want 9", d)
	}
}

func TestHandleGetHistory_AcceptsTypedEntityMetric(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now().Unix()
	if err := srv.st.RecordMetric("dc.-2.rtt_ms", store.MetricPoint{TS: now, Value: 87}); err != nil {
		t.Fatal(err)
	}
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	r := httptest.NewRequest("GET", "/api/history?metric=dc.-2.rtt_ms&range=15m", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got historySeriesView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Points) != 1 || got.Points[0].V != 87 {
		t.Fatalf("points = %+v, want one RTT point", got.Points)
	}
}

// TestHandleGetHistory_RequiresSession covers auth: no cookie, 401.
func TestHandleGetHistory_RequiresSession(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()

	r := httptest.NewRequest("GET", "/api/history?metric=connections&range=15m", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// TestHandleGetHistory_AcceptsThirtyMinuteRange covers the range Сводка's
// KPI captions actually ask for: fifteen minutes to show plus the fifteen
// before them to compare against.
func TestHandleGetHistory_AcceptsThirtyMinuteRange(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now().Unix()
	// Older than 15 minutes, younger than 30 — only the wider range reaches it.
	if err := srv.st.RecordMetric("attempts", store.MetricPoint{TS: now - 20*60, Value: 100}); err != nil {
		t.Fatal(err)
	}
	if err := srv.st.RecordMetric("attempts", store.MetricPoint{TS: now, Value: 160}); err != nil {
		t.Fatal(err)
	}

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	for _, tc := range []struct {
		rangeParam string
		wantPoints int
	}{
		{"15m", 1},
		{"30m", 2},
	} {
		r := httptest.NewRequest("GET", "/api/history?metric=attempts&range="+tc.rangeParam, nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("range=%s: status = %d, want 200: %s", tc.rangeParam, w.Code, w.Body)
		}
		var got historySeriesView
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("range=%s: decode: %v", tc.rangeParam, err)
		}
		if got.Range != tc.rangeParam {
			t.Errorf("range echoed as %q, want %q", got.Range, tc.rangeParam)
		}
		if len(got.Points) != tc.wantPoints {
			t.Errorf("range=%s: points = %d, want %d", tc.rangeParam, len(got.Points), tc.wantPoints)
		}
	}
}

// TestHandleGetHistory_ReportsRetention covers the meta the browser needs to
// tell "this window is empty" from "this window is older than the ring": the
// ring's own reach, store.MetricCap points at the hub's poll interval.
func TestHandleGetHistory_ReportsRetention(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)

	r := httptest.NewRequest("GET", "/api/history?metric=connections&range=30m", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got historySeriesView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := int64(srv.hub.HistoryRetention() / time.Second)
	if got.RetentionSecs != want {
		t.Errorf("retention_secs = %d, want %d", got.RetentionSecs, want)
	}
	// The whole point of the widening: two 15-minute windows fit.
	if got.RetentionSecs < 2*15*60 {
		t.Errorf("retention_secs = %d, want at least two 15-minute windows", got.RetentionSecs)
	}
}

func TestHandleGetHistoryEventsFiltersAndReportsRetention(t *testing.T) {
	srv := newTestServer(t)
	now := time.Now().UTC()
	for _, event := range []store.HistoryEvent{
		{TS: now.Add(-time.Minute), Category: store.StorageEvents, Kind: "route.mode.changed", Entity: "route", State: "fallback", PreviousState: "me", Severity: "warning"},
		{TS: now, Category: store.StorageEvents, Kind: "dc.coverage.changed", Entity: "dc:-203", State: "66", PreviousState: "100", Severity: "warning", Attributes: map[string]string{"route": "media"}},
	} {
		if err := srv.st.AppendHistoryEvent(event); err != nil {
			t.Fatal(err)
		}
	}
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	r := httptest.NewRequest("GET", "/api/history/events?range=24h&kind=dc.coverage.changed&entity=dc:-203&limit=1", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body)
	}
	var got historyEventsView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Range != "24h" || got.RetentionSecs != 30*24*60*60 || len(got.Events) != 1 {
		t.Fatalf("response = %+v", got)
	}
	if event := got.Events[0]; event.Entity != "dc:-203" || event.Attributes["route"] != "media" {
		t.Fatalf("event = %+v", event)
	}
}

func TestHandleGetHistoryEventsValidatesRangeAndLimit(t *testing.T) {
	srv := newTestServer(t)
	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	for _, path := range []string{
		"/api/history/events?range=never",
		"/api/history/events?range=24h&limit=0",
		"/api/history/events?range=24h&limit=501",
	} {
		r := httptest.NewRequest("GET", path, nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", path, w.Code)
		}
	}
}
