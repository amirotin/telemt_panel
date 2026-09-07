package store

import (
	"math"
	"testing"
	"time"
)

func TestMemoryLiveMetricsKeepTwoHoursAtDifferentPollIntervals(t *testing.T) {
	for _, step := range []int64{5, 10, 15} {
		t.Run(time.Duration(step*int64(time.Second)).String(), func(t *testing.T) {
			m, err := NewMemory("")
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			for ts := int64(0); ts <= 10800; ts += step {
				if err := m.RecordMetric("connections", MetricPoint{TS: ts, Value: float64(ts)}); err != nil {
					t.Fatal(err)
				}
			}
			points, err := m.MetricRange("connections", 0)
			if err != nil {
				t.Fatal(err)
			}
			want := int(7200/step) + 1
			if len(points) != want {
				t.Fatalf("live window: count=%d, want %d", len(points), want)
			}
			if points[0].TS != 3600 || points[len(points)-1].TS != 10800 {
				t.Fatalf("live window: first=%+v, last=%+v; want [3600,10800]", points[0], points[len(points)-1])
			}
			if got := m.MetricRetention("connections"); got != 2*time.Hour {
				t.Fatalf("retention = %s, want 2h", got)
			}
		})
	}
}

func TestMemoryLiveMetricsSortReplaceAndBoundLateSamples(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	for _, p := range []MetricPoint{
		{TS: 8000, Value: 8}, {TS: 8010, Value: 10}, {TS: 8005, Value: 5},
		{TS: 8005, Value: 6}, {TS: 0, Value: 100},
	} {
		if err := m.RecordMetric("connections", p); err != nil {
			t.Fatal(err)
		}
	}
	got, err := m.MetricRange("connections", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].TS != 8000 || got[1].TS != 8005 || got[1].Value != 6 || got[2].TS != 8010 {
		t.Fatalf("points = %+v, want sorted unique samples without the expired point", got)
	}
	got[0].Value = 999
	again, _ := m.MetricRange("connections", 0)
	if again[0].Value != 8 {
		t.Fatal("reader mutated the live buffer")
	}
}

func TestMemoryLiveMetricsRemainAvailableWhenDiskCategoryDisabled(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	policies := DefaultStoragePolicies()
	for i := range policies {
		if policies[i].Category == StorageTraffic || policies[i].Category == StorageConnectionIssues {
			policies[i].Enabled = false
		}
	}
	if err := m.ApplyStoragePolicies(policies); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"traffic", "attempts", "refusals"} {
		if err := m.RecordMetric(name, MetricPoint{TS: 100, Value: 5}); err != nil {
			t.Fatal(err)
		}
		points, err := m.MetricRange(name, 0)
		if err != nil || len(points) != 1 || m.MetricRetention(name) != 2*time.Hour {
			t.Errorf("%s live history = %+v, err=%v, retention=%s", name, points, err, m.MetricRetention(name))
		}
	}
}

func TestMemoryLiveMetricsIgnoreNonFiniteSamples(t *testing.T) {
	m, err := NewMemory("")
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	for i, value := range []float64{1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := m.RecordMetric("connections", MetricPoint{TS: int64(i), Value: value}); err != nil {
			t.Fatal(err)
		}
	}
	points, _ := m.MetricRange("connections", 0)
	if len(points) != 1 || points[0].Value != 1 {
		t.Fatalf("non-finite data reached live history: %+v", points)
	}
}

func BenchmarkLiveMetricSteadyState(b *testing.B) {
	var points []MetricPoint
	for i := range MetricCap {
		points = appendLiveMetric(points, MetricPoint{TS: int64(i) * 5, Value: float64(i)})
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		points = appendLiveMetric(points, MetricPoint{TS: int64(MetricCap+i) * 5, Value: float64(i)})
	}
}
