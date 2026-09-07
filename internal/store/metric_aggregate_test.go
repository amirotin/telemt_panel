package store

import (
	"math"
	"testing"
)

func TestMetricAggregateKeepsExtremaAndWeightsSamples(t *testing.T) {
	first := aggregateMetricSamples("dc.2.coverage_pct", []MetricPoint{{TS: 300, Value: 100}, {TS: 305, Value: 0}, {TS: 310, Value: 100}})
	second := aggregateMetricSamples("dc.2.coverage_pct", []MetricPoint{{TS: 315, Value: 100}})
	got := mergeMetricAggregates("dc.2.coverage_pct", first, second)
	if got.Value != 75 || got.Max != 100 || got.Min == nil || *got.Min != 0 || got.Samples != 4 {
		t.Fatalf("aggregate lost extrema or sample weight: %+v", got)
	}
	if got.FirstTS != 300 || got.LastTS != 315 || got.ObservedSeconds != 15 || got.Gaps != 0 {
		t.Fatalf("observation coverage = %+v", got)
	}
}

func TestMetricAggregateCounterResetAndGapDoNotInventTraffic(t *testing.T) {
	got := aggregateMetricSamples("traffic", []MetricPoint{
		{TS: 300, Value: 100}, {TS: 305, Value: 150},
		{TS: 310, Value: 10}, {TS: 315, Value: 30},
		{TS: 600, Value: 900}, {TS: 605, Value: 950},
	})
	if got.Value != 950 || got.Delta == nil || *got.Delta != 120 || got.Gaps != 2 || got.ObservedSeconds != 15 {
		t.Fatalf("counter aggregate = %+v", got)
	}
}

func TestMetricAggregateCounterSegmentsJoinOnce(t *testing.T) {
	a := aggregateMetricSamples("attempts", []MetricPoint{{TS: 300, Value: 10}, {TS: 305, Value: 20}})
	b := aggregateMetricSamples("attempts", []MetricPoint{{TS: 310, Value: 25}, {TS: 315, Value: 40}})
	got := mergeMetricAggregates("attempts", a, b)
	if got.Delta == nil || *got.Delta != 30 || got.ObservedSeconds != 15 || got.Gaps != 0 {
		t.Fatalf("counter segments = %+v", got)
	}
}

func TestMetricAggregateLegacyMinRemainsUnknown(t *testing.T) {
	legacy := MetricPoint{TS: 300, LastTS: 305, Value: 80, Max: 100, Samples: 2}
	next := aggregateMetricSamples("connections", []MetricPoint{{TS: 310, Value: 20}})
	got := mergeMetricAggregates("connections", legacy, next)
	if got.Min != nil || math.Abs(got.Value-60) > 0.000001 || got.Max != 100 || got.Samples != 3 {
		t.Fatalf("legacy metadata was invented: %+v", got)
	}
}

func TestMetricAggregateOverlappingCounterSegmentsRemainUnknown(t *testing.T) {
	a := aggregateMetricSamples("attempts", []MetricPoint{{TS: 300, Value: 0}, {TS: 310, Value: 100}})
	b := aggregateMetricSamples("attempts", []MetricPoint{{TS: 305, Value: 20}, {TS: 306, Value: 30}})
	got := mergeMetricAggregates("attempts", a, b)
	if got.Delta != nil || got.Gaps == 0 || got.Value != 100 || got.Samples != 4 {
		t.Fatalf("overlap double-counted counter movement: %+v", got)
	}
}
