package telemt

import "encoding/json"

// ZeroSection is a leaf family of GET /v1/stats/zero/all — a deep counter
// dump whose Rust source (model.rs ZeroCoreData/ZeroUpstreamData/
// ZeroMiddleProxyData/ZeroPoolData/ZeroDesyncData) names 15-50+ fixed fields
// per section, mixing u64 counters with bools, an enum-ish String field
// (telemetry_me_level) and nested Vec<ClassCount>/Vec<ZeroCodeCount> arrays.
// 07-telemt-sdk.md calls these leaves "display-only map[string]int64
// families", but a literal map[string]int64 cannot decode the non-integer
// leaves Telemt actually sends. ZeroSection keeps 07's spirit (a generic,
// forward-compatible leaf the panel only ever displays, never branches on)
// while staying decode-safe: json.RawMessage preserves whatever shape a
// given key holds instead of forcing it through int64.
type ZeroSection = map[string]json.RawMessage

// ZeroAllData is the payload of GET /v1/stats/zero/all. Only the top level
// (the five named sections) is typed, per 07-telemt-sdk.md; each section's
// leaves are ZeroSection.
type ZeroAllData struct {
	GeneratedAtEpochSecs int64       `json:"generated_at_epoch_secs"`
	Core                 ZeroSection `json:"core"`
	Upstream             ZeroSection `json:"upstream"`
	MiddleProxy          ZeroSection `json:"middle_proxy"`
	Pool                 ZeroSection `json:"pool"`
	Desync               ZeroSection `json:"desync"`
}

// ZeroUpstreamData is the upstream-connect counter block also embedded (as
// UpstreamsData.Zero) in GET /v1/stats/upstreams — unlike the zero/all
// leaves this one is fully typed, since /v1/stats/upstreams is a real
// dashboard source, not just a display-only deep dump.
type ZeroUpstreamData struct {
	ConnectAttemptTotal                     uint64 `json:"connect_attempt_total"`
	ConnectSuccessTotal                     uint64 `json:"connect_success_total"`
	ConnectFailTotal                        uint64 `json:"connect_fail_total"`
	ConnectFailfastHardErrorTotal           uint64 `json:"connect_failfast_hard_error_total"`
	ConnectAttemptsBucket1                  uint64 `json:"connect_attempts_bucket_1"`
	ConnectAttemptsBucket2                  uint64 `json:"connect_attempts_bucket_2"`
	ConnectAttemptsBucket3To4               uint64 `json:"connect_attempts_bucket_3_4"`
	ConnectAttemptsBucketGt4                uint64 `json:"connect_attempts_bucket_gt_4"`
	ConnectDurationSuccessBucketLe100ms     uint64 `json:"connect_duration_success_bucket_le_100ms"`
	ConnectDurationSuccessBucket101To500ms  uint64 `json:"connect_duration_success_bucket_101_500ms"`
	ConnectDurationSuccessBucket501To1000ms uint64 `json:"connect_duration_success_bucket_501_1000ms"`
	ConnectDurationSuccessBucketGt1000ms    uint64 `json:"connect_duration_success_bucket_gt_1000ms"`
	ConnectDurationFailBucketLe100ms        uint64 `json:"connect_duration_fail_bucket_le_100ms"`
	ConnectDurationFailBucket101To500ms     uint64 `json:"connect_duration_fail_bucket_101_500ms"`
	ConnectDurationFailBucket501To1000ms    uint64 `json:"connect_duration_fail_bucket_501_1000ms"`
	ConnectDurationFailBucketGt1000ms       uint64 `json:"connect_duration_fail_bucket_gt_1000ms"`
}

// UpstreamDcStatus is one upstream's per-DC latency/preference row.
type UpstreamDcStatus struct {
	DC           int16    `json:"dc"`
	LatencyEmaMs *float64 `json:"latency_ema_ms"`
	IPPreference string   `json:"ip_preference"`
}

// UpstreamStatus is one configured upstream's live health status.
type UpstreamStatus struct {
	UpstreamID         int                `json:"upstream_id"`
	RouteKind          string             `json:"route_kind"` // direct|socks4|socks5|shadowsocks
	Address            string             `json:"address"`
	Weight             uint16             `json:"weight"`
	Scopes             string             `json:"scopes"`
	Healthy            bool               `json:"healthy"`
	Fails              uint32             `json:"fails"`
	LastCheckAgeSecs   uint64             `json:"last_check_age_secs"`
	EffectiveLatencyMs *float64           `json:"effective_latency_ms"`
	DC                 []UpstreamDcStatus `json:"dc"`
}

// UpstreamSummaryData is a health/route-kind rollup of configured upstreams.
type UpstreamSummaryData struct {
	ConfiguredTotal  int `json:"configured_total"`
	HealthyTotal     int `json:"healthy_total"`
	UnhealthyTotal   int `json:"unhealthy_total"`
	DirectTotal      int `json:"direct_total"`
	Socks4Total      int `json:"socks4_total"`
	Socks5Total      int `json:"socks5_total"`
	ShadowsocksTotal int `json:"shadowsocks_total"`
}

// UpstreamsData is the payload of GET /v1/stats/upstreams. Gated behind
// minimal_runtime_enabled (default true), but with its own shape rather than
// Gated[T]: Zero is always present (even when disabled/unavailable),
// Summary/Upstreams are independently optional.
type UpstreamsData struct {
	Enabled              bool                 `json:"enabled"`
	Reason               string               `json:"reason,omitempty"`
	GeneratedAtEpochSecs int64                `json:"generated_at_epoch_secs"`
	Zero                 ZeroUpstreamData     `json:"zero"`
	Summary              *UpstreamSummaryData `json:"summary,omitempty"`
	Upstreams            []UpstreamStatus     `json:"upstreams,omitempty"`
}

// MeWritersSummary rolls up the ME writer population.
type MeWritersSummary struct {
	ConfiguredDcGroups  int     `json:"configured_dc_groups"`
	ConfiguredEndpoints int     `json:"configured_endpoints"`
	AvailableEndpoints  int     `json:"available_endpoints"`
	AvailablePct        float64 `json:"available_pct"`
	RequiredWriters     int     `json:"required_writers"`
	AliveWriters        int     `json:"alive_writers"`
	CoveragePct         float64 `json:"coverage_pct"`
	FreshAliveWriters   int     `json:"fresh_alive_writers"`
	FreshCoveragePct    float64 `json:"fresh_coverage_pct"`
}

// MeWriterStatus is one ME writer's live status row.
type MeWriterStatus struct {
	WriterID                uint64   `json:"writer_id"`
	DC                      *int16   `json:"dc"`
	Endpoint                string   `json:"endpoint"`
	Generation              uint64   `json:"generation"`
	State                   string   `json:"state"`
	Draining                bool     `json:"draining"`
	Degraded                bool     `json:"degraded"`
	BoundClients            int      `json:"bound_clients"`
	IdleForSecs             *uint64  `json:"idle_for_secs"`
	RttEmaMs                *float64 `json:"rtt_ema_ms"`
	MatchesActiveGeneration bool     `json:"matches_active_generation"`
	InDesiredMap            bool     `json:"in_desired_map"`
	AllowDrainFallback      bool     `json:"allow_drain_fallback"`
	DrainStartedAtEpochSecs *uint64  `json:"drain_started_at_epoch_secs"`
	DrainDeadlineEpochSecs  *uint64  `json:"drain_deadline_epoch_secs"`
	DrainOverTTL            bool     `json:"drain_over_ttl"`
}

// MeWritersData is the payload of GET /v1/stats/me-writers. Gated behind
// minimal_runtime_enabled, but Writers stays an always-present (possibly
// empty) array rather than an optional Gated[T] data payload
// (runtime_stats.rs disabled_me_writers/build_me_writers_data).
type MeWritersData struct {
	MiddleProxyEnabled   bool             `json:"middle_proxy_enabled"`
	Reason               string           `json:"reason,omitempty"`
	GeneratedAtEpochSecs int64            `json:"generated_at_epoch_secs"`
	Summary              MeWritersSummary `json:"summary"`
	Writers              []MeWriterStatus `json:"writers"`
}

// DcEndpointWriters is one endpoint's active-writer count within a DC.
type DcEndpointWriters struct {
	Endpoint      string `json:"endpoint"`
	ActiveWriters int    `json:"active_writers"`
}

// DcStatus is one DC group's live coverage/floor status.
type DcStatus struct {
	DC                 int16               `json:"dc"`
	Endpoints          []string            `json:"endpoints"`
	EndpointWriters    []DcEndpointWriters `json:"endpoint_writers"`
	AvailableEndpoints int                 `json:"available_endpoints"`
	AvailablePct       float64             `json:"available_pct"`
	RequiredWriters    int                 `json:"required_writers"`
	FloorMin           int                 `json:"floor_min"`
	FloorTarget        int                 `json:"floor_target"`
	FloorMax           int                 `json:"floor_max"`
	FloorCapped        bool                `json:"floor_capped"`
	AliveWriters       int                 `json:"alive_writers"`
	CoveragePct        float64             `json:"coverage_pct"`
	FreshAliveWriters  int                 `json:"fresh_alive_writers"`
	FreshCoveragePct   float64             `json:"fresh_coverage_pct"`
	RttMs              *float64            `json:"rtt_ms"`
	Load               int                 `json:"load"`
}

// DcStatusData is the payload of GET /v1/stats/dcs. Gated behind
// minimal_runtime_enabled like MeWritersData; DCs stays an always-present
// (possibly empty) array.
type DcStatusData struct {
	MiddleProxyEnabled   bool       `json:"middle_proxy_enabled"`
	Reason               string     `json:"reason,omitempty"`
	GeneratedAtEpochSecs int64      `json:"generated_at_epoch_secs"`
	DCs                  []DcStatus `json:"dcs"`
}

// MinimalQuarantineData is one endpoint currently quarantined from ME routing.
type MinimalQuarantineData struct {
	Endpoint    string `json:"endpoint"`
	RemainingMs uint64 `json:"remaining_ms"`
}

// MinimalDcPathData is one DC's selected network path (IP family preference).
type MinimalDcPathData struct {
	DC             int16  `json:"dc"`
	IPPreference   string `json:"ip_preference,omitempty"`
	SelectedAddrV4 string `json:"selected_addr_v4,omitempty"`
	SelectedAddrV6 string `json:"selected_addr_v6,omitempty"`
}

// MinimalMeRuntimeData is the ME pool's live tuning-knob snapshot — mostly
// advanced diagnostics, mirrored field-for-field from Rust's
// MinimalMeRuntimeData (runtime_stats.rs) rather than generalized, since
// 07-telemt-sdk.md's "display-only map" guidance is specifically about the
// zero/all deep counter dump, not this endpoint.
type MinimalMeRuntimeData struct {
	ActiveGeneration                          uint64                  `json:"active_generation"`
	WarmGeneration                            uint64                  `json:"warm_generation"`
	PendingHardswapGeneration                 uint64                  `json:"pending_hardswap_generation"`
	PendingHardswapAgeSecs                    *uint64                 `json:"pending_hardswap_age_secs"`
	HardswapEnabled                           bool                    `json:"hardswap_enabled"`
	FloorMode                                 string                  `json:"floor_mode"`
	AdaptiveFloorIdleSecs                     uint64                  `json:"adaptive_floor_idle_secs"`
	AdaptiveFloorMinWritersSingleEndpoint     uint8                   `json:"adaptive_floor_min_writers_single_endpoint"`
	AdaptiveFloorMinWritersMultiEndpoint      uint8                   `json:"adaptive_floor_min_writers_multi_endpoint"`
	AdaptiveFloorRecoverGraceSecs             uint64                  `json:"adaptive_floor_recover_grace_secs"`
	AdaptiveFloorWritersPerCoreTotal          uint16                  `json:"adaptive_floor_writers_per_core_total"`
	AdaptiveFloorCPUCoresOverride             uint16                  `json:"adaptive_floor_cpu_cores_override"`
	AdaptiveFloorMaxExtraWritersSinglePerCore uint16                  `json:"adaptive_floor_max_extra_writers_single_per_core"`
	AdaptiveFloorMaxExtraWritersMultiPerCore  uint16                  `json:"adaptive_floor_max_extra_writers_multi_per_core"`
	AdaptiveFloorMaxActiveWritersPerCore      uint16                  `json:"adaptive_floor_max_active_writers_per_core"`
	AdaptiveFloorMaxWarmWritersPerCore        uint16                  `json:"adaptive_floor_max_warm_writers_per_core"`
	AdaptiveFloorMaxActiveWritersGlobal       uint32                  `json:"adaptive_floor_max_active_writers_global"`
	AdaptiveFloorMaxWarmWritersGlobal         uint32                  `json:"adaptive_floor_max_warm_writers_global"`
	AdaptiveFloorCPUCoresDetected             uint32                  `json:"adaptive_floor_cpu_cores_detected"`
	AdaptiveFloorCPUCoresEffective            uint32                  `json:"adaptive_floor_cpu_cores_effective"`
	AdaptiveFloorGlobalCapRaw                 uint64                  `json:"adaptive_floor_global_cap_raw"`
	AdaptiveFloorGlobalCapEffective           uint64                  `json:"adaptive_floor_global_cap_effective"`
	AdaptiveFloorTargetWritersTotal           uint64                  `json:"adaptive_floor_target_writers_total"`
	AdaptiveFloorActiveCapConfigured          uint64                  `json:"adaptive_floor_active_cap_configured"`
	AdaptiveFloorActiveCapEffective           uint64                  `json:"adaptive_floor_active_cap_effective"`
	AdaptiveFloorWarmCapConfigured            uint64                  `json:"adaptive_floor_warm_cap_configured"`
	AdaptiveFloorWarmCapEffective             uint64                  `json:"adaptive_floor_warm_cap_effective"`
	AdaptiveFloorActiveWritersCurrent         uint64                  `json:"adaptive_floor_active_writers_current"`
	AdaptiveFloorWarmWritersCurrent           uint64                  `json:"adaptive_floor_warm_writers_current"`
	MeKeepaliveEnabled                        bool                    `json:"me_keepalive_enabled"`
	MeKeepaliveIntervalSecs                   uint64                  `json:"me_keepalive_interval_secs"`
	MeKeepaliveJitterSecs                     uint64                  `json:"me_keepalive_jitter_secs"`
	MeKeepalivePayloadRandom                  bool                    `json:"me_keepalive_payload_random"`
	RpcProxyReqEverySecs                      uint64                  `json:"rpc_proxy_req_every_secs"`
	MeReconnectMaxConcurrentPerDc             uint32                  `json:"me_reconnect_max_concurrent_per_dc"`
	MeReconnectBackoffBaseMs                  uint64                  `json:"me_reconnect_backoff_base_ms"`
	MeReconnectBackoffCapMs                   uint64                  `json:"me_reconnect_backoff_cap_ms"`
	MeReconnectFastRetryCount                 uint32                  `json:"me_reconnect_fast_retry_count"`
	MePoolDrainTTLSecs                        uint64                  `json:"me_pool_drain_ttl_secs"`
	MePoolForceCloseSecs                      uint64                  `json:"me_pool_force_close_secs"`
	MePoolMinFreshRatio                       float32                 `json:"me_pool_min_fresh_ratio"`
	MeBindStaleMode                           string                  `json:"me_bind_stale_mode"`
	MeBindStaleTTLSecs                        uint64                  `json:"me_bind_stale_ttl_secs"`
	MeSingleEndpointShadowWriters             uint8                   `json:"me_single_endpoint_shadow_writers"`
	MeSingleEndpointOutageModeEnabled         bool                    `json:"me_single_endpoint_outage_mode_enabled"`
	MeSingleEndpointOutageDisableQuarantine   bool                    `json:"me_single_endpoint_outage_disable_quarantine"`
	MeSingleEndpointOutageBackoffMinMs        uint64                  `json:"me_single_endpoint_outage_backoff_min_ms"`
	MeSingleEndpointOutageBackoffMaxMs        uint64                  `json:"me_single_endpoint_outage_backoff_max_ms"`
	MeSingleEndpointShadowRotateEverySecs     uint64                  `json:"me_single_endpoint_shadow_rotate_every_secs"`
	MeDeterministicWriterSort                 bool                    `json:"me_deterministic_writer_sort"`
	MeWriterPickMode                          string                  `json:"me_writer_pick_mode"`
	MeWriterPickSampleSize                    uint8                   `json:"me_writer_pick_sample_size"`
	MeSocksKdfPolicy                          string                  `json:"me_socks_kdf_policy"`
	QuarantinedEndpointsTotal                 int                     `json:"quarantined_endpoints_total"`
	QuarantinedEndpoints                      []MinimalQuarantineData `json:"quarantined_endpoints"`
}

// MinimalAllPayload is the Gated[T] payload of GET /v1/stats/minimal/all.
type MinimalAllPayload struct {
	MeWriters   MeWritersData         `json:"me_writers"`
	DCs         DcStatusData          `json:"dcs"`
	MeRuntime   *MinimalMeRuntimeData `json:"me_runtime,omitempty"`
	NetworkPath []MinimalDcPathData   `json:"network_path"`
}

// UserActiveIps is one user's active-IP row from GET /v1/stats/users/active-ips
// — only users with at least one active IP are listed.
type UserActiveIps struct {
	Username  string   `json:"username"`
	ActiveIPs []string `json:"active_ips"`
}
