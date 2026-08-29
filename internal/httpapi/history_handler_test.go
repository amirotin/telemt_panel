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
