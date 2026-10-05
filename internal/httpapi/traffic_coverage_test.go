package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/store"
)

type coverageHistoryStore struct {
	store.Store
	snapshot *coverageTrafficSnapshot
}

func (s *coverageHistoryStore) BeginTrafficRead(ctx context.Context) (store.TrafficReadSnapshot, error) {
	s.snapshot.ctx = ctx
	return s.snapshot, nil
}

type coverageTrafficSnapshot struct {
	ctx    context.Context
	closed bool
	asOf   int64
	ranges [][2]int64
}

func (s *coverageTrafficSnapshot) AsOf() int64  { return s.asOf }
func (s *coverageTrafficSnapshot) Close() error { s.closed = true; return nil }
func (s *coverageTrafficSnapshot) CollectorState() (store.UserTrafficCollectorState, error) {
	return store.UserTrafficCollectorState{LastSuccessTS: s.asOf, SourceState: store.UserTrafficCollecting, Continuity: store.UserTrafficNormal}, nil
}
func (s *coverageTrafficSnapshot) Summaries() (map[string]store.UserTrafficSummary, error) {
	return map[string]store.UserTrafficSummary{"alice": {Username: "alice", CurrentMonthBytes: 500, ObservedSinceEpochSecs: s.asOf - 90*86400}}, nil
}
func (s *coverageTrafficSnapshot) Range(username string, from, to int64) ([]store.UserTrafficPoint, store.TrafficCoverage, error) {
	s.ranges = append(s.ranges, [2]int64{from, to})
	return []store.UserTrafficPoint{}, store.TrafficCoverage{AsOfEpochSecs: s.asOf, BoundaryPartial: true}, nil
}
func (s *coverageTrafficSnapshot) Aggregate(from, to int64) (int64, []store.UserTrafficPoint, store.TrafficCoverage, error) {
	s.ranges = append(s.ranges, [2]int64{from, to})
	return 100, []store.UserTrafficPoint{{TS: from, Bytes: 100, Tier: store.MetricTierDay}}, store.TrafficCoverage{AsOfEpochSecs: s.asOf, BoundaryPartial: true}, nil
}
func (s *coverageTrafficSnapshot) Ranking(from, to int64, deleted bool, limit int, cursor *store.UserTrafficRankCursor) ([]store.UserTrafficRank, store.TrafficCoverage, error) {
	s.ranges = append(s.ranges, [2]int64{from, to})
	return []store.UserTrafficRank{}, store.TrafficCoverage{AsOfEpochSecs: s.asOf, BoundaryPartial: true}, nil
}

type coverageResponseWriter struct {
	*httptest.ResponseRecorder
	t        *testing.T
	snapshot *coverageTrafficSnapshot
}

func (w *coverageResponseWriter) Write(body []byte) (int, error) {
	if !w.snapshot.closed {
		w.t.Error("JSON serialization holds traffic snapshot")
	}
	return w.ResponseRecorder.Write(body)
}

func TestTrafficCoverageHTTPConsistentMonthAndClosedSnapshot(t *testing.T) {
	m, err := store.NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	asOf := time.Date(2026, 10, 5, 10, 30, 0, 0, time.UTC).Unix()
	snapshot := &coverageTrafficSnapshot{asOf: asOf}
	s := &Server{st: &coverageHistoryStore{Store: m, snapshot: snapshot}}
	w := &coverageResponseWriter{ResponseRecorder: httptest.NewRecorder(), t: t, snapshot: snapshot}
	r := httptest.NewRequest(http.MethodGet, "/api/traffic/summary?range=month", nil)
	s.handleGetTrafficSummary(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var view trafficSummaryView
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	month := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC).Unix()
	if view.RequestedFrom != month || view.TotalBytes != 500 || view.Points[0].V != 100 || view.State != "partial" || view.PreviousTotalBytes != nil || view.Coverage.AsOfEpochSecs != asOf {
		t.Fatalf("view=%+v", view)
	}
	if snapshot.ctx != r.Context() {
		t.Error("request context was not forwarded")
	}
	for i, bounds := range snapshot.ranges {
		if i == 1 {
			if bounds[1] != month {
				t.Errorf("previous bounds=%v", bounds)
			}
		} else if bounds != [2]int64{month, asOf} {
			t.Errorf("current bounds=%v", bounds)
		}
	}
}
