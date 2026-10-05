//go:build !lite

package store

import "strings"

func persistentMetricHistory(name string) bool {
	switch name {
	case "health", "telemt.available", "telemt.unavailable", "mode.route", "dc.coverage_pct", "upstream.healthy_total", "upstream.unhealthy_total":
		return false
	}
	return !strings.HasPrefix(name, "upstream.") || (!strings.HasSuffix(name, ".healthy") && !strings.HasSuffix(name, ".unhealthy"))
}

func metricTierSQL(tier MetricTier) string {
	if tier == MetricTierRaw {
		return metricTierRawSQL
	}
	return string(tier)
}

func metricTierFromSQL(tier string) MetricTier {
	if tier == metricTierRawSQL {
		return MetricTierRaw
	}
	return MetricTier(tier)
}
