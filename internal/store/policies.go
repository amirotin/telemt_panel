package store

import (
	"fmt"
	"slices"
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
	StorageUserIPHistory    StorageCategory = "user_ip_history"
	StorageDiagnostics      StorageCategory = "diagnostics"
)

const (
	MinRetentionDays = 1
	MaxRetentionDays = 3650
)

// StoragePolicy controls persistence and retention for one history family.
// Disabling service history does not disable the live RAM buffer.
type StoragePolicy struct {
	Category      StorageCategory `json:"category"`
	Enabled       bool            `json:"enabled"`
	RetentionDays int             `json:"retention_days"`
	MaxIPsPerUser *int            `json:"max_ips_per_user,omitempty"`
}

// StorageCategoryStats reports the current number of retained records.
type StorageCategoryStats struct {
	Category  StorageCategory            `json:"category"`
	Records   int64                      `json:"records"`
	Entities  *int64                     `json:"entities,omitempty"`
	Collector *UserTrafficCollectorState `json:"collector,omitempty"`
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
	StorageUserIPHistory,
	StorageDiagnostics,
}

// DefaultStoragePolicies returns a fresh copy of the recommended policy set.
func DefaultStoragePolicies() []StoragePolicy {
	ipLimit := UserIPPerUserLimit
	return []StoragePolicy{
		{Category: StorageTechnical, Enabled: true, RetentionDays: 30},
		{Category: StorageEvents, Enabled: true, RetentionDays: 30},
		{Category: StorageAudit, Enabled: true, RetentionDays: 90},
		{Category: StorageConnectionIssues, Enabled: true, RetentionDays: 30},
		{Category: StorageTraffic, Enabled: true, RetentionDays: 30},
		{Category: StorageUserTraffic, Enabled: true, RetentionDays: 365},
		{Category: StorageUserIPHistory, Enabled: true, RetentionDays: 30, MaxIPsPerUser: &ipLimit},
		{Category: StorageDiagnostics, Enabled: true, RetentionDays: 30},
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
		if policy.Category == StorageUserIPHistory && !policy.Enabled {
			return fmt.Errorf("storage policies: %s history cannot be disabled", policy.Category)
		}
		if policy.MaxIPsPerUser != nil {
			if policy.Category != StorageUserIPHistory {
				return fmt.Errorf("storage policies: max_ips_per_user is only valid for %s", StorageUserIPHistory)
			}
			if *policy.MaxIPsPerUser < 0 || *policy.MaxIPsPerUser > UserIPSQLiteLimit {
				return fmt.Errorf("storage policies: max_ips_per_user must be between 0 and %d", UserIPSQLiteLimit)
			}
		}
	}
	return nil
}

func policiesFromMap(byCategory map[StorageCategory]StoragePolicy) []StoragePolicy {
	out := make([]StoragePolicy, 0, len(storageCategoryOrder))
	for _, category := range storageCategoryOrder {
		out = append(out, cloneStoragePolicy(byCategory[category]))
	}
	return out
}

func policyMap(policies []StoragePolicy) map[StorageCategory]StoragePolicy {
	out := make(map[StorageCategory]StoragePolicy, len(policies))
	for _, policy := range policies {
		out[policy.Category] = cloneStoragePolicy(policy)
	}
	return out
}

// EffectiveUserIPLimit resolves legacy policies to the default; zero is unlimited per user.
// Invalid values fall back to the default even before policy validation runs.
func EffectiveUserIPLimit(policy StoragePolicy) int {
	if policy.MaxIPsPerUser == nil || *policy.MaxIPsPerUser < 0 || *policy.MaxIPsPerUser > UserIPSQLiteLimit {
		return UserIPPerUserLimit
	}
	return *policy.MaxIPsPerUser
}

func cloneStoragePolicy(policy StoragePolicy) StoragePolicy {
	if policy.MaxIPsPerUser != nil {
		limit := *policy.MaxIPsPerUser
		policy.MaxIPsPerUser = &limit
	} else if policy.Category == StorageUserIPHistory {
		limit := UserIPPerUserLimit
		policy.MaxIPsPerUser = &limit
	}
	return policy
}

func storagePoliciesEqual(a, b StoragePolicy) bool {
	return a.Category == b.Category && a.Enabled == b.Enabled && a.RetentionDays == b.RetentionDays &&
		EffectiveUserIPLimit(a) == EffectiveUserIPLimit(b)
}

// EqualStoragePolicies compares ordered policy sets by effective values, not
// pointer identity; an omitted legacy IP cap is equivalent to the default.
func EqualStoragePolicies(a, b []StoragePolicy) bool {
	return slices.EqualFunc(a, b, storagePoliciesEqual)
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
