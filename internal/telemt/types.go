package telemt

// Response shapes mirror the serde structs in Telemt's src/api/model.rs
// (verified against the 3.5.2 sources; see workspace v2/specs/07-telemt-sdk.md).
// Optional response fields are omitted by Telemt, not null — except the
// gated-wrapper `data` fields, which are explicit null when unavailable.

// HealthData is the payload of GET /v1/health.
type HealthData struct {
	Status   string `json:"status"`
	ReadOnly bool   `json:"read_only"`
}

// SystemInfoData is the payload of GET /v1/system/info.
type SystemInfoData struct {
	Version                  string  `json:"version"`
	TargetArch               string  `json:"target_arch"`
	TargetOS                 string  `json:"target_os"`
	BuildProfile             string  `json:"build_profile"`
	GitCommit                string  `json:"git_commit,omitempty"`
	ProcessStartedAtEpochSec int64   `json:"process_started_at_epoch_secs"`
	UptimeSeconds            float64 `json:"uptime_seconds"`
	ConfigPath               string  `json:"config_path"`
	ConfigHash               string  `json:"config_hash"`
	ConfigReloadCount        uint64  `json:"config_reload_count"`
}

// TLSDomainLink is one domain-fronted fake-TLS link.
type TLSDomainLink struct {
	Domain string `json:"domain"`
	Link   string `json:"link"`
}

// UserLinks holds ready-made tg://proxy connection links. Telemt builds
// them server-side; the panel never constructs proxy links itself
// (the WEB-mode tg://webproxy links are the one exception — the API does
// not return those).
type UserLinks struct {
	Classic    []string        `json:"classic"`
	Secure     []string        `json:"secure"`
	TLS        []string        `json:"tls"`
	TLSDomains []TLSDomainLink `json:"tls_domains"`
}

// ClassCount pairs a connection or handshake-failure class with its counter.
type ClassCount struct {
	Class string `json:"class"`
	Total uint64 `json:"total"`
}

// SummaryData is the payload of GET /v1/stats/summary. The by-class
// breakdowns are absent (nil) on older Telemt builds that predate them.
type SummaryData struct {
	UptimeSeconds            float64      `json:"uptime_seconds"`
	ConnectionsTotal         uint64       `json:"connections_total"`
	ConnectionsBadTotal      uint64       `json:"connections_bad_total"`
	HandshakeTimeoutsTotal   uint64       `json:"handshake_timeouts_total"`
	ConfiguredUsers          uint64       `json:"configured_users"`
	ConnectionsBadByClass    []ClassCount `json:"connections_bad_by_class,omitempty"`
	HandshakeFailuresByClass []ClassCount `json:"handshake_failures_by_class,omitempty"`
}

// QuotaEntry is one user's entry in GET /v1/stats/users/quota — undocumented
// in Telemt's API.md but implemented; the endpoint 404s on older builds,
// which QuotaList surfaces as a false capability flag rather than an error.
type QuotaEntry struct {
	DataQuotaBytes     uint64 `json:"data_quota_bytes"`
	UsedBytes          uint64 `json:"used_bytes"`
	LastResetEpochSecs int64  `json:"last_reset_epoch_secs"`
}

// CreateUserRequest is the body of POST /v1/users. Username is required;
// every other field is omitted from the wire request when unset, letting
// Telemt apply its own defaults (secret generated, enabled=true, no limits).
type CreateUserRequest struct {
	Username          string  `json:"username"`
	Secret            string  `json:"secret,omitempty"`
	UserAdTag         string  `json:"user_ad_tag,omitempty"`
	MaxTCPConns       *uint64 `json:"max_tcp_conns,omitempty"`
	ExpirationRFC3339 string  `json:"expiration_rfc3339,omitempty"`
	DataQuotaBytes    *uint64 `json:"data_quota_bytes,omitempty"`
	RateLimitUpBps    *uint64 `json:"rate_limit_up_bps,omitempty"`
	RateLimitDownBps  *uint64 `json:"rate_limit_down_bps,omitempty"`
	MaxUniqueIPs      *uint64 `json:"max_unique_ips,omitempty"`
	Enabled           *bool   `json:"enabled,omitempty"`
}

// UserInfo is one user as returned by GET /v1/users.
type UserInfo struct {
	Username           string    `json:"username"`
	Enabled            bool      `json:"enabled"`
	InRuntime          bool      `json:"in_runtime"`
	UserAdTag          string    `json:"user_ad_tag,omitempty"`
	MaxTCPConns        *uint64   `json:"max_tcp_conns,omitempty"`
	ExpirationRFC3339  string    `json:"expiration_rfc3339,omitempty"`
	DataQuotaBytes     *uint64   `json:"data_quota_bytes,omitempty"`
	RateLimitUpBps     *uint64   `json:"rate_limit_up_bps,omitempty"`
	RateLimitDownBps   *uint64   `json:"rate_limit_down_bps,omitempty"`
	MaxUniqueIPs       *uint64   `json:"max_unique_ips,omitempty"`
	CurrentConnections uint64    `json:"current_connections"`
	ActiveUniqueIPs    uint64    `json:"active_unique_ips"`
	ActiveIPList       []string  `json:"active_unique_ips_list"`
	RecentUniqueIPs    uint64    `json:"recent_unique_ips"`
	RecentIPList       []string  `json:"recent_unique_ips_list"`
	TotalOctets        uint64    `json:"total_octets"`
	Links              UserLinks `json:"links"`
}
