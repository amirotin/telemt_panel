package store

import (
	"fmt"
	"strings"
	"time"
)

// StorageCategory identifies one independently configurable family of
// historical data. Operational state such as sessions, auth settings and
// update recovery records is deliberately not a category: it is always
// persisted by durable stores.
type StorageCategory string

const (
	StorageTechnical        StorageCategory = "technical"
	StorageEvents           StorageCategory = "events"
	StorageAudit            StorageCategory = "audit"
	StorageConnectionIssues StorageCategory = "connection_issues"
	StorageTraffic          StorageCategory = "traffic"
	StorageUserTraffic      StorageCategory = "user_traffic"
	StorageDiagnostics      StorageCategory = "diagnostics"
)

const (
	MinRetentionDays = 1
	MaxRetentionDays = 3650
)

// StoragePolicy controls persistence and retention for one history family.
// Technical history is mandatory and therefore cannot be disabled.
type StoragePolicy struct {
	Category      StorageCategory `json:"category"`
	Enabled       bool            `json:"enabled"`
	RetentionDays int             `json:"retention_days"`
}

// StorageCategoryStats reports the current number of retained records.
type StorageCategoryStats struct {
	Category StorageCategory `json:"category"`
	Records  int64           `json:"records"`
}

// StorageStats describes the active backend and its current footprint.
type StorageStats struct {
	Driver        string                 `json:"driver"`
	Durable       bool                   `json:"durable"`
	DatabaseBytes int64                  `json:"database_bytes"`
	Categories    []StorageCategoryStats `json:"categories"`
}

var storageCategoryOrder = []StorageCategory{
	StorageTechnical,
	StorageEvents,
	StorageAudit,
	StorageConnectionIssues,
	StorageTraffic,
	StorageUserTraffic,
	StorageDiagnostics,
}

// DefaultStoragePolicies returns a fresh copy of the recommended policy set.
func DefaultStoragePolicies() []StoragePolicy {
	return []StoragePolicy{
		{Category: StorageTechnical, Enabled: true, RetentionDays: 7},
		{Category: StorageEvents, Enabled: true, RetentionDays: 30},
		{Category: StorageAudit, Enabled: true, RetentionDays: 90},
		{Category: StorageConnectionIssues, Enabled: true, RetentionDays: 14},
		{Category: StorageTraffic, Enabled: true, RetentionDays: 7},
		{Category: StorageUserTraffic, Enabled: false, RetentionDays: 30},
		{Category: StorageDiagnostics, Enabled: false, RetentionDays: 7},
	}
}

func defaultPolicyMap() map[StorageCategory]StoragePolicy {
	out := make(map[StorageCategory]StoragePolicy, len(storageCategoryOrder))
	for _, policy := range DefaultStoragePolicies() {
		out[policy.Category] = policy
	}
	return out
}

// ValidateStoragePolicies requires a complete, duplicate-free policy set.
func ValidateStoragePolicies(policies []StoragePolicy) error {
	if len(policies) != len(storageCategoryOrder) {
		return fmt.Errorf("storage policies: got %d categories, want %d", len(policies), len(storageCategoryOrder))
	}
	seen := make(map[StorageCategory]bool, len(policies))
	for _, policy := range policies {
		if _, ok := defaultPolicyMap()[policy.Category]; !ok {
			return fmt.Errorf("storage policies: unknown category %q", policy.Category)
		}
		if seen[policy.Category] {
			return fmt.Errorf("storage policies: duplicate category %q", policy.Category)
		}
		seen[policy.Category] = true
		if policy.RetentionDays < MinRetentionDays || policy.RetentionDays > MaxRetentionDays {
			return fmt.Errorf("storage policies: retention_days for %q must be between %d and %d", policy.Category, MinRetentionDays, MaxRetentionDays)
		}
		if policy.Category == StorageTechnical && !policy.Enabled {
			return fmt.Errorf("storage policies: technical history cannot be disabled")
		}
	}
	return nil
}

func policiesFromMap(byCategory map[StorageCategory]StoragePolicy) []StoragePolicy {
	out := make([]StoragePolicy, 0, len(storageCategoryOrder))
	for _, category := range storageCategoryOrder {
		out = append(out, byCategory[category])
	}
	return out
}

func policyMap(policies []StoragePolicy) map[StorageCategory]StoragePolicy {
	out := make(map[StorageCategory]StoragePolicy, len(policies))
	for _, policy := range policies {
		out[policy.Category] = policy
	}
	return out
}

func metricCategory(name string) StorageCategory {
	switch name {
	case "connections", "active_users", "health", "telemt.available", "telemt.unavailable":
		return StorageTechnical
	case "traffic", "rx_bytes", "tx_bytes":
		return StorageTraffic
	case "refusals", "attempts":
		return StorageConnectionIssues
	}
	if strings.HasPrefix(name, "user.") && strings.HasSuffix(name, ".traffic") {
		return StorageUserTraffic
	}
	if strings.HasPrefix(name, "dc.") || strings.HasPrefix(name, "mode.") || strings.HasPrefix(name, "upstream.") {
		return StorageTechnical
	}
	return StorageDiagnostics
}

func retentionDuration(policy StoragePolicy) time.Duration {
	return time.Duration(policy.RetentionDays) * 24 * time.Hour
}
