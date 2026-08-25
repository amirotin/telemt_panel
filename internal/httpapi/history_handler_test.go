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
