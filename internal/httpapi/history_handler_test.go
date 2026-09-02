package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

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

	if got := request(); got.State != "disabled" || got.RetentionSecs != 0 || len(got.Points) != 0 {
		t.Fatalf("disabled response = %+v", got)
	}
	policies, err := srv.st.ListStoragePolicies()
	if err != nil {
		t.Fatal(err)
	}
	for i := range policies {
		if policies[i].Category == store.StorageUserTraffic {
			policies[i].Enabled = true
		}
	}
	if err := srv.st.ReplaceStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	if err := srv.st.RecordUserTraffic([]store.UserTrafficDelta{{Username: "alice", TS: now, Bytes: 2048}}); err != nil {
		t.Fatal(err)
	}
	got := request()
	if got.Metric != "user.alice.traffic" || got.State != "partial" || len(got.Points) != 1 || got.Points[0].V != 2048 || got.Points[0].Tier != "15m" {
		t.Fatalf("traffic response = %+v", got)
	}
}

func TestMetricHistoryStateDistinguishesDisabledEmptyPartialAndReady(t *testing.T) {
	now := int64(10_000)
	from := now - 600
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
		{name: "ready", retention: 600, points: []store.MetricPoint{{TS: from + 30, Value: 1}}, want: "ready"},
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
