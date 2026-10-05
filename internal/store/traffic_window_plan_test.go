package store

import (
	"context"
	"math"
	"reflect"
	"testing"
)

func TestTrafficWindowBoundaries(t *testing.T) {
	asOf := int64(50*86400 + 10*3600 + 30*60)
	fine := asOf - 86400
	hour := asOf - 30*86400
	tiers := []TrafficTierPolicy{{MetricTierQuarter, 900, 86400}, {MetricTierHour, 3600, 30 * 86400}, {MetricTierDay, 86400, 365 * 86400}}
	for _, tc := range []struct {
		name         string
		from, to, at int64
		want         []TrafficWindow
		partial      bool
	}{
		{"audit retained quarter", fine + 900, fine + 1800, asOf, []TrafficWindow{{MetricTierQuarter, fine + 900, fine + 1800}}, false},
		{"fine cutoff minus second", fine - 1, fine + 900, asOf, []TrafficWindow{{MetricTierQuarter, fine, fine + 900}}, true},
		{"fine cutoff exact", fine, fine + 900, asOf, []TrafficWindow{{MetricTierQuarter, fine, fine + 900}}, false},
		{"fine cutoff plus second", fine + 1, fine + 900, asOf, []TrafficWindow{}, true},
		{"full coarse hour at cutoff", fine - 1800, fine + 1800, asOf, []TrafficWindow{{MetricTierHour, fine - 1800, fine + 1800}}, false},
		{"historical partial upper", fine, fine + 450, asOf, []TrafficWindow{}, true},
		{"current open upper", asOf, asOf + 123, asOf + 123, []TrafficWindow{{MetricTierQuarter, asOf, asOf + 123}}, false},
		{"partial day retains hours", hour + 1800, hour + 5400, asOf, []TrafficWindow{{MetricTierHour, hour + 1800, hour + 5400}}, false},
		{"empty", fine, fine, asOf, []TrafficWindow{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			windows, coverage, err := PlanTrafficWindows(tc.from, tc.to, tc.at, tiers)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(windows, tc.want) || coverage.BoundaryPartial != tc.partial || coverage.AsOfEpochSecs != tc.at {
				t.Fatalf("windows=%+v coverage=%+v want=%+v partial=%t", windows, coverage, tc.want, tc.partial)
			}
			if len(windows) == 0 {
				if coverage.CoveredFromEpochSecs != nil || coverage.CoveredToEpochSecs != nil {
					t.Fatalf("empty bounds=%+v", coverage)
				}
			} else if coverage.CoveredFromEpochSecs == nil || *coverage.CoveredFromEpochSecs != windows[0].From || coverage.CoveredToEpochSecs == nil || *coverage.CoveredToEpochSecs != windows[len(windows)-1].To {
				t.Fatalf("bounds=%+v windows=%+v", coverage, windows)
			}
		})
	}
	if _, _, err := PlanTrafficWindows(2, 1, 3, tiers); err == nil {
		t.Fatal("reversed range accepted")
	}
	for _, invalid := range [][]TrafficTierPolicy{{{MetricTierQuarter, 0, 1}}, {{MetricTierQuarter, 900, -1}}, {{MetricTierQuarter, 900, 1}, {MetricTierQuarter, 3600, 1}}} {
		if _, _, err := PlanTrafficWindows(0, 1, 1, invalid); err == nil {
			t.Fatal("invalid policy accepted")
		}
	}
}

func TestTrafficWindowInt64AndConservation(t *testing.T) {
	tiers := []TrafficTierPolicy{{MetricTierQuarter, 900, 86400}, {MetricTierHour, 3600, 30 * 86400}, {MetricTierDay, 86400, 365 * 86400}}
	asOf := int64(400 * 86400)
	for _, bounds := range [][2]int64{{asOf - 35*86400, asOf}, {asOf - 86400, asOf - 900}, {asOf - 30*86400, asOf - 29*86400}, {asOf - 35*86400 + 1, asOf - 900 + 1}, {math.MinInt64, math.MinInt64 + 1}, {math.MaxInt64 - 1000, math.MaxInt64}} {
		windows, coverage, err := PlanTrafficWindows(bounds[0], bounds[1], max(asOf, bounds[1]), tiers)
		if err != nil {
			t.Fatal(err)
		}
		var selected int64
		for i, window := range windows {
			if window.To <= window.From || (i > 0 && windows[i-1].To > window.From) {
				t.Fatalf("overlapping or reversed windows=%+v", windows)
			}
			selected += window.To - window.From
		}
		if !coverage.BoundaryPartial && selected != bounds[1]-bounds[0] {
			t.Fatalf("unconserved width=%d bounds=%v coverage=%+v", selected, bounds, coverage)
		}
	}
}

func TestMemoryTrafficCoverageSnapshotIsolation(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := m.BeginTrafficRead(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	r := raw.(*memoryTrafficReadSnapshot)
	ts := r.asOf/900*900 - 900
	m.userTrafficBuckets[memoryUserTrafficBucketKey{"alice", ts}] = 100
	if total, _, _, err := r.Aggregate(ts, ts+900); err != nil || total != 0 {
		t.Fatalf("snapshot changed: %d %v", total, err)
	}
	r.buckets[memoryUserTrafficBucketKey{"alice", ts}] = 100
	points, coverage, err := r.Range("alice", ts, ts+900)
	if err != nil || len(points) != 1 || points[0].Bytes != 100 || coverage.BoundaryPartial {
		t.Fatalf("points=%+v coverage=%+v err=%v", points, coverage, err)
	}
	r.summaries["alice"] = UserTrafficSummary{Username: "alice", ObservedTotalBytes: 500, CurrentMonthBytes: 300}
	r.summaries["bob"] = UserTrafficSummary{Username: "bob", DeletedEpochSecs: 1}
	r.buckets[memoryUserTrafficBucketKey{"bob", ts}] = 100
	total, points, coverage, err := r.Aggregate(ts, ts+900)
	if err != nil || total != 200 || len(points) != 1 || coverage.BoundaryPartial {
		t.Fatalf("aggregate=%d %+v %+v %v", total, points, coverage, err)
	}
	ranks, _, err := r.Ranking(ts, ts+900, false, 1, nil)
	if err != nil || len(ranks) != 1 || ranks[0].Username != "alice" || ranks[0].ObservedTotal != 500 || ranks[0].CurrentMonth != 300 {
		t.Fatalf("rank=%+v err=%v", ranks, err)
	}
	ranks, _, err = r.Ranking(ts, ts+900, true, 1, &UserTrafficRankCursor{Bytes: 100, Username: "alice"})
	if err != nil || len(ranks) != 1 || ranks[0].Username != "bob" {
		t.Fatalf("cursor=%+v err=%v", ranks, err)
	}
	r.buckets[memoryUserTrafficBucketKey{"alice", ts}] = math.MaxInt64
	if _, _, _, err := r.Aggregate(ts, ts+900); err == nil {
		t.Fatal("overflow accepted")
	}
}
