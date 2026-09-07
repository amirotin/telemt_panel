package store

import "testing"

func TestMetricPortableRejectsInvalidObservationMetadata(t *testing.T) {
	base := aggregateMetricSamples("connections", []MetricPoint{{TS: 300, Value: 10}, {TS: 305, Value: 20}})
	base.Tier = MetricTierFive
	for _, change := range []func(*MetricPoint){
		func(p *MetricPoint) { p.LastTS = 9999999999 },
		func(p *MetricPoint) { p.ObservedSeconds = 6 },
		func(p *MetricPoint) { p.Samples = 0 },
		func(p *MetricPoint) { p.FirstValue = 500 },
	} {
		point := base
		change(&point)
		if err := validatePortableMetrics(map[string][]MetricPoint{"connections": {point}}); err == nil {
			t.Fatalf("accepted invalid observation metadata: %+v", point)
		}
	}
	if err := validatePortableMetrics(map[string][]MetricPoint{"connections": {base}}); err != nil {
		t.Fatal(err)
	}
}
