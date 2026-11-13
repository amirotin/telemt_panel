package telemt

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// CIDRRateLimit contains integer bit-per-second limits, preserving the full u64 range.
type CIDRRateLimit struct {
	UpBPS   uint64 `json:"up_bps"`
	DownBPS uint64 `json:"down_bps"`
}

// AccessPolicy describes global per-user defaults and CIDR shaping policy.
type AccessPolicy struct {
	UserMaxTCPConnsGlobalEach  uint64                   `json:"user_max_tcp_conns_global_each"`
	UserMaxUniqueIPsGlobalEach uint64                   `json:"user_max_unique_ips_global_each"`
	UserMaxUniqueIPsMode       string                   `json:"user_max_unique_ips_mode"`
	UserMaxUniqueIPsWindowSecs uint64                   `json:"user_max_unique_ips_window_secs"`
	CIDRRateLimits             map[string]CIDRRateLimit `json:"cidr_rate_limits"`
}

// AccessPolicyState separates desired source policy from the active publication.
type AccessPolicyState struct {
	Desired              AccessPolicy    `json:"desired"`
	Effective            AccessPolicy    `json:"effective"`
	Runtime              RuntimeBaseline `json:"runtime"`
	PublishedMatch       bool            `json:"published_match"`
	EffectiveScope       string          `json:"effective_scope"`
	SubsystemConvergence string          `json:"subsystem_convergence"`
	ApplyMode            string          `json:"apply_mode"`
	ChangedPaths         []string        `json:"changed_paths,omitempty"`
}

// AccessPolicyPatch retains absent/null/value distinctions without float64.
// CIDR maps merge individual keys, null entries remove keys, and a null map
// clears all entries. An empty map does not clear existing entries.
type AccessPolicyPatch map[string]json.RawMessage

// Validate checks the policy request shape; Telemt owns CIDR and semantic validation.
func (p AccessPolicyPatch) Validate() error {
	if len(p) == 0 {
		return fmt.Errorf("access policy patch must not be empty")
	}
	for key, raw := range p {
		if string(raw) == "null" {
			switch key {
			case "user_max_tcp_conns_global_each", "user_max_unique_ips_global_each", "user_max_unique_ips_mode", "user_max_unique_ips_window_secs", "cidr_rate_limits":
				continue
			}
		}
		switch key {
		case "user_max_tcp_conns_global_each", "user_max_unique_ips_global_each", "user_max_unique_ips_window_secs":
			var value uint64
			if err := json.Unmarshal(raw, &value); err != nil {
				return fmt.Errorf("%s must be an unsigned integer or null", key)
			}
		case "user_max_unique_ips_mode":
			var value string
			if err := json.Unmarshal(raw, &value); err != nil {
				return fmt.Errorf("%s must be a string or null", key)
			}
		case "cidr_rate_limits":
			var entries map[string]json.RawMessage
			if err := json.Unmarshal(raw, &entries); err != nil {
				return fmt.Errorf("cidr_rate_limits must be an object or null")
			}
			for cidr, value := range entries {
				if string(value) == "null" {
					continue
				}
				var rates map[string]json.RawMessage
				if err := json.Unmarshal(value, &rates); err != nil || rates == nil {
					return fmt.Errorf("cidr_rate_limits.%s must be an object or null", cidr)
				}
				for name, rate := range rates {
					if name != "up_bps" && name != "down_bps" {
						return fmt.Errorf("unknown rate field: %s", name)
					}
					var n uint64
					if string(rate) == "null" {
						return fmt.Errorf("%s must be an unsigned integer", name)
					}
					if err := json.Unmarshal(rate, &n); err != nil {
						return fmt.Errorf("%s must be an unsigned integer", name)
					}
				}
			}
		default:
			return fmt.Errorf("unknown access policy field: %s", key)
		}
	}
	return nil
}

// AccessPolicy calls the optional GET /v1/access/policy route.
func (c *Client) AccessPolicy(ctx context.Context) (AccessPolicyState, string, error) {
	return getRevision[AccessPolicyState](ctx, c, "/v1/access/policy")
}

// PatchAccessPolicy writes only explicit policy fields, fenced by source/runtime revisions.
func (c *Client) PatchAccessPolicy(ctx context.Context, patch AccessPolicyPatch, revision, runtimeMatch string) (AccessPolicyState, string, error) {
	if err := patch.Validate(); err != nil {
		return AccessPolicyState{}, "", err
	}
	data, _, next, err := configCall[AccessPolicyState](ctx, c, http.MethodPatch, "/v1/access/policy", patch, revision, runtimeMatch)
	return data, next, err
}
