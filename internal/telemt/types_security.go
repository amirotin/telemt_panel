package telemt

// SecurityPostureData is the payload of GET /v1/security/posture.
type SecurityPostureData struct {
	APIReadOnly          bool   `json:"api_read_only"`
	APIWhitelistEnabled  bool   `json:"api_whitelist_enabled"`
	APIWhitelistEntries  int    `json:"api_whitelist_entries"`
	APIAuthHeaderEnabled bool   `json:"api_auth_header_enabled"`
	ProxyProtocolEnabled bool   `json:"proxy_protocol_enabled"`
	LogLevel             string `json:"log_level"`
	TelemetryCoreEnabled bool   `json:"telemetry_core_enabled"`
	TelemetryUserEnabled bool   `json:"telemetry_user_enabled"`
	TelemetryMeLevel     string `json:"telemetry_me_level"`
}

// SecurityWhitelistData is the payload of GET /v1/security/whitelist. Enabled
// here means "the API whitelist is non-empty", not a feature gate — the
// field is always present, never wrapped in Gated[T] (runtime_min.rs
// build_security_whitelist_data).
type SecurityWhitelistData struct {
	GeneratedAtEpochSecs int64    `json:"generated_at_epoch_secs"`
	Enabled              bool     `json:"enabled"`
	EntriesTotal         int      `json:"entries_total"`
	Entries              []string `json:"entries"`
}
