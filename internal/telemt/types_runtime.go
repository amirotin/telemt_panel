package telemt

// Gated wraps a runtime payload that is only produced when a feature gate is
// on and its data source is reachable (07-telemt-sdk.md §SDK-4). Telemt's
// actual serde structs mark both `reason` and `data` with
// skip_serializing_if = "Option::is_none" (verified against runtime_min.rs,
// runtime_edge.rs and MinimalAllData in model.rs, 3.5.2 sources) — so a
// closed gate OMITS `data` entirely, it does not send an explicit JSON null,
// despite 07-telemt-sdk.md's "known gotchas" section and the task brief both
// claiming the opposite. A *T field decodes identically either way (absent
// or null both leave Data nil), so this type is correct against either wire
// behavior; see the package doc comment on this discrepancy.
type Gated[T any] struct {
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason,omitempty"`
	// omitempty because not every gated payload HAS one: the WEB status
	// route is not a Gated[T] in Telemt at all, so hub's fetchWeb builds
	// the wrapper by hand and has no timestamp to put here — emitting a
	// constant 0 would be a stamp that says "1970".
	GeneratedAtEpochSecs int64 `json:"generated_at_epoch_secs,omitempty"`
	Data                 *T    `json:"data,omitempty"`
}

// RuntimeGatesData is the payload of GET /v1/runtime/gates. Unlike the other
// runtime/* endpoints this group is never wrapped in Gated[T] — the group is
// "always enabled" per 07-telemt-sdk.md, and runtime_zero.rs's
// build_runtime_gates_data returns the struct directly.
type RuntimeGatesData struct {
	AcceptingNewConnections    bool    `json:"accepting_new_connections"`
	ConditionalCastEnabled     bool    `json:"conditional_cast_enabled"`
	MeRuntimeReady             bool    `json:"me_runtime_ready"`
	Me2DcFallbackEnabled       bool    `json:"me2dc_fallback_enabled"`
	Me2DcFastEnabled           bool    `json:"me2dc_fast_enabled"`
	UseMiddleProxy             bool    `json:"use_middle_proxy"`
	RouteMode                  string  `json:"route_mode"`
	RerouteActive              bool    `json:"reroute_active"`
	RerouteToDirectAtEpochSecs int64   `json:"reroute_to_direct_at_epoch_secs,omitempty"`
	RerouteReason              string  `json:"reroute_reason,omitempty"`
	StartupStatus              string  `json:"startup_status"`
	StartupStage               string  `json:"startup_stage"`
	StartupProgressPct         float64 `json:"startup_progress_pct"`
}

// RuntimeInitializationComponentData is one startup component row inside
// RuntimeInitializationData.Components.
type RuntimeInitializationComponentData struct {
	ID                string `json:"id"`
	Title             string `json:"title"`
	Status            string `json:"status"`
	StartedAtEpochMs  *int64 `json:"started_at_epoch_ms"`
	FinishedAtEpochMs *int64 `json:"finished_at_epoch_ms"`
	DurationMs        *int64 `json:"duration_ms"`
	Attempts          uint32 `json:"attempts"`
	Details           string `json:"details,omitempty"`
}

// RuntimeInitializationMeData is the ME-pool-specific slice of startup state.
type RuntimeInitializationMeData struct {
	Status       string  `json:"status"`
	CurrentStage string  `json:"current_stage"`
	ProgressPct  float64 `json:"progress_pct"`
	InitAttempt  uint32  `json:"init_attempt"`
	RetryLimit   string  `json:"retry_limit"`
	LastError    string  `json:"last_error,omitempty"`
}

// RuntimeInitializationData is the payload of GET /v1/runtime/initialization
// — like Gates, this group is always enabled and never wrapped in Gated[T].
type RuntimeInitializationData struct {
	Status             string                               `json:"status"`
	Degraded           bool                                 `json:"degraded"`
	CurrentStage       string                               `json:"current_stage"`
	ProgressPct        float64                              `json:"progress_pct"`
	StartedAtEpochSecs int64                                `json:"started_at_epoch_secs"`
	ReadyAtEpochSecs   int64                                `json:"ready_at_epoch_secs,omitempty"`
	TotalElapsedMs     int64                                `json:"total_elapsed_ms"`
	TransportMode      string                               `json:"transport_mode"`
	Me                 RuntimeInitializationMeData          `json:"me"`
	Components         []RuntimeInitializationComponentData `json:"components"`
}

// RuntimeMePoolStateGenerationData describes the ME pool's generation churn.
type RuntimeMePoolStateGenerationData struct {
	ActiveGeneration          uint64   `json:"active_generation"`
	WarmGeneration            uint64   `json:"warm_generation"`
	PendingHardswapGeneration uint64   `json:"pending_hardswap_generation"`
	PendingHardswapAgeSecs    *uint64  `json:"pending_hardswap_age_secs"`
	DrainingGenerations       []uint64 `json:"draining_generations"`
}

// RuntimeMePoolStateHardswapData reports the ME pool's hardswap machinery.
type RuntimeMePoolStateHardswapData struct {
	Enabled bool `json:"enabled"`
	Pending bool `json:"pending"`
}

// RuntimeMePoolStateWriterContourData is a writer-count breakdown by contour.
type RuntimeMePoolStateWriterContourData struct {
	Warm     int `json:"warm"`
	Active   int `json:"active"`
	Draining int `json:"draining"`
}

// RuntimeMePoolStateWriterHealthData is a writer-count breakdown by health.
type RuntimeMePoolStateWriterHealthData struct {
	Healthy  int `json:"healthy"`
	Degraded int `json:"degraded"`
	Draining int `json:"draining"`
}

// RuntimeMePoolStateWriterData summarizes the ME pool's writer population.
type RuntimeMePoolStateWriterData struct {
	Total            int                                 `json:"total"`
	AliveNonDraining int                                 `json:"alive_non_draining"`
	Draining         int                                 `json:"draining"`
	Degraded         int                                 `json:"degraded"`
	Contour          RuntimeMePoolStateWriterContourData `json:"contour"`
	Health           RuntimeMePoolStateWriterHealthData  `json:"health"`
}

// RuntimeMePoolStateRefillDcData is one DC's in-flight refill count.
type RuntimeMePoolStateRefillDcData struct {
	DC       int16  `json:"dc"`
	Family   string `json:"family"`
	Inflight int    `json:"inflight"`
}

// RuntimeMePoolStateRefillData summarizes in-flight ME writer refills.
type RuntimeMePoolStateRefillData struct {
	InflightEndpointsTotal int                              `json:"inflight_endpoints_total"`
	InflightDcTotal        int                              `json:"inflight_dc_total"`
	ByDc                   []RuntimeMePoolStateRefillDcData `json:"by_dc"`
}

// RuntimeMePoolStatePayload is the Gated[T] payload of GET /v1/runtime/me-pool-state
// (alias /v1/runtime/me_pool_state).
type RuntimeMePoolStatePayload struct {
	Generations RuntimeMePoolStateGenerationData `json:"generations"`
	Hardswap    RuntimeMePoolStateHardswapData   `json:"hardswap"`
	Writers     RuntimeMePoolStateWriterData     `json:"writers"`
	Refill      RuntimeMePoolStateRefillData     `json:"refill"`
}

// RuntimeMeQualityCountersData is the raw counter block of a MeQuality payload.
type RuntimeMeQualityCountersData struct {
	IdleCloseByPeerTotal  uint64 `json:"idle_close_by_peer_total"`
	ReaderEOFTotal        uint64 `json:"reader_eof_total"`
	KdfDriftTotal         uint64 `json:"kdf_drift_total"`
	KdfPortOnlyDriftTotal uint64 `json:"kdf_port_only_drift_total"`
	ReconnectAttemptTotal uint64 `json:"reconnect_attempt_total"`
	ReconnectSuccessTotal uint64 `json:"reconnect_success_total"`
}

// RuntimeMeQualityRouteDropData counts why the ME route dropped traffic.
type RuntimeMeQualityRouteDropData struct {
	NoConnTotal        uint64 `json:"no_conn_total"`
	ChannelClosedTotal uint64 `json:"channel_closed_total"`
	QueueFullTotal     uint64 `json:"queue_full_total"`
	QueueFullBaseTotal uint64 `json:"queue_full_base_total"`
	QueueFullHighTotal uint64 `json:"queue_full_high_total"`
}

// RuntimeMeQualityFamilyStateData is one address-family's ME-quality state
// machine snapshot (e.g. IPv4 vs IPv6 reachability).
type RuntimeMeQualityFamilyStateData struct {
	Family                   string `json:"family"`
	State                    string `json:"state"`
	StateSinceEpochSecs      int64  `json:"state_since_epoch_secs"`
	SuppressedUntilEpochSecs int64  `json:"suppressed_until_epoch_secs,omitempty"`
	FailStreak               uint32 `json:"fail_streak"`
	RecoverSuccessStreak     uint32 `json:"recover_success_streak"`
}

// RuntimeMeQualityDrainGateData reports whether the pool is allowed to drain.
type RuntimeMeQualityDrainGateData struct {
	RouteQuorumOK      bool   `json:"route_quorum_ok"`
	RedundancyOK       bool   `json:"redundancy_ok"`
	BlockReason        string `json:"block_reason"`
	UpdatedAtEpochSecs int64  `json:"updated_at_epoch_secs"`
}

// RuntimeMeQualityDcRttData is one DC's ME round-trip/coverage snapshot.
type RuntimeMeQualityDcRttData struct {
	DC              int16    `json:"dc"`
	RttEmaMs        *float64 `json:"rtt_ema_ms"`
	AliveWriters    int      `json:"alive_writers"`
	RequiredWriters int      `json:"required_writers"`
	CoveragePct     float64  `json:"coverage_pct"`
}

// RuntimeMeQualityPayload is the Gated[T] payload of GET /v1/runtime/me-quality
// (alias /v1/runtime/me_quality).
type RuntimeMeQualityPayload struct {
	Counters     RuntimeMeQualityCountersData      `json:"counters"`
	RouteDrops   RuntimeMeQualityRouteDropData     `json:"route_drops"`
	FamilyStates []RuntimeMeQualityFamilyStateData `json:"family_states"`
	DrainGate    RuntimeMeQualityDrainGateData     `json:"drain_gate"`
	DcRtt        []RuntimeMeQualityDcRttData       `json:"dc_rtt"`
}

// RuntimeUpstreamQualityPolicyData mirrors the effective upstream-connect policy.
type RuntimeUpstreamQualityPolicyData struct {
	ConnectRetryAttempts      uint32 `json:"connect_retry_attempts"`
	ConnectRetryBackoffMs     uint64 `json:"connect_retry_backoff_ms"`
	ConnectBudgetMs           uint64 `json:"connect_budget_ms"`
	UnhealthyFailThreshold    uint32 `json:"unhealthy_fail_threshold"`
	ConnectFailfastHardErrors bool   `json:"connect_failfast_hard_errors"`
}

// RuntimeUpstreamQualityCountersData is the raw upstream-connect counter block.
type RuntimeUpstreamQualityCountersData struct {
	ConnectAttemptTotal           uint64 `json:"connect_attempt_total"`
	ConnectSuccessTotal           uint64 `json:"connect_success_total"`
	ConnectFailTotal              uint64 `json:"connect_fail_total"`
	ConnectFailfastHardErrorTotal uint64 `json:"connect_failfast_hard_error_total"`
}

// RuntimeUpstreamQualitySummaryData is a health/route-kind rollup of upstreams.
type RuntimeUpstreamQualitySummaryData struct {
	ConfiguredTotal  int `json:"configured_total"`
	HealthyTotal     int `json:"healthy_total"`
	UnhealthyTotal   int `json:"unhealthy_total"`
	DirectTotal      int `json:"direct_total"`
	Socks4Total      int `json:"socks4_total"`
	Socks5Total      int `json:"socks5_total"`
	ShadowsocksTotal int `json:"shadowsocks_total"`
}

// RuntimeUpstreamQualityDcData is one upstream's per-DC latency/preference row.
type RuntimeUpstreamQualityDcData struct {
	DC           int16    `json:"dc"`
	LatencyEmaMs *float64 `json:"latency_ema_ms"`
	IPPreference string   `json:"ip_preference"`
}

// RuntimeUpstreamQualityUpstreamData is one upstream's live health row.
type RuntimeUpstreamQualityUpstreamData struct {
	UpstreamID         int                            `json:"upstream_id"`
	RouteKind          string                         `json:"route_kind"`
	Address            string                         `json:"address"`
	Weight             uint16                         `json:"weight"`
	Scopes             string                         `json:"scopes"`
	Healthy            bool                           `json:"healthy"`
	Fails              uint32                         `json:"fails"`
	LastCheckAgeSecs   uint64                         `json:"last_check_age_secs"`
	EffectiveLatencyMs *float64                       `json:"effective_latency_ms"`
	DC                 []RuntimeUpstreamQualityDcData `json:"dc"`
}

// RuntimeUpstreamQualityData is the payload of GET /v1/runtime/upstream-quality
// (alias /v1/runtime/upstream_quality). Unlike the other runtime/* groups
// this one does NOT follow the Gated[T] shape — Policy/Counters are always
// present alongside enabled/reason, and Summary/Upstreams are independently
// optional (RuntimeUpstreamQualityData in runtime_min.rs).
type RuntimeUpstreamQualityData struct {
	Enabled              bool                                 `json:"enabled"`
	Reason               string                               `json:"reason,omitempty"`
	GeneratedAtEpochSecs int64                                `json:"generated_at_epoch_secs"`
	Policy               RuntimeUpstreamQualityPolicyData     `json:"policy"`
	Counters             RuntimeUpstreamQualityCountersData   `json:"counters"`
	Summary              *RuntimeUpstreamQualitySummaryData   `json:"summary,omitempty"`
	Upstreams            []RuntimeUpstreamQualityUpstreamData `json:"upstreams,omitempty"`
}

// RuntimeNatStunReflectionData is one address family's STUN reflection result.
type RuntimeNatStunReflectionData struct {
	Addr    string `json:"addr"`
	AgeSecs uint64 `json:"age_secs"`
}

// RuntimeNatStunFlagsData reports the NAT-probe feature flags in effect.
type RuntimeNatStunFlagsData struct {
	NatProbeEnabled         bool  `json:"nat_probe_enabled"`
	NatProbeDisabledRuntime bool  `json:"nat_probe_disabled_runtime"`
	NatProbeAttempts        uint8 `json:"nat_probe_attempts"`
}

// RuntimeNatStunServersData lists configured vs currently-live STUN servers.
type RuntimeNatStunServersData struct {
	Configured []string `json:"configured"`
	Live       []string `json:"live"`
	LiveTotal  int      `json:"live_total"`
}

// RuntimeNatStunReflectionBlockData holds the v4/v6 reflection results.
type RuntimeNatStunReflectionBlockData struct {
	V4 *RuntimeNatStunReflectionData `json:"v4,omitempty"`
	V6 *RuntimeNatStunReflectionData `json:"v6,omitempty"`
}

// RuntimeNatStunPayload is the Gated[T] payload of GET /v1/runtime/nat-stun
// (alias /v1/runtime/nat_stun).
type RuntimeNatStunPayload struct {
	Flags                  RuntimeNatStunFlagsData           `json:"flags"`
	Servers                RuntimeNatStunServersData         `json:"servers"`
	Reflection             RuntimeNatStunReflectionBlockData `json:"reflection"`
	StunBackoffRemainingMs *uint64                           `json:"stun_backoff_remaining_ms,omitempty"`
}

// RuntimeMeSelftestKdfData reports the KDF handshake error-rate self-test.
type RuntimeMeSelftestKdfData struct {
	State                 string  `json:"state"`
	EwmaErrorsPerMin      float64 `json:"ewma_errors_per_min"`
	ThresholdErrorsPerMin float64 `json:"threshold_errors_per_min"`
	ErrorsTotal           uint64  `json:"errors_total"`
}

// RuntimeMeSelftestTimeskewData reports the clock-skew self-test.
type RuntimeMeSelftestTimeskewData struct {
	State           string  `json:"state"`
	MaxSkewSecs15m  *uint64 `json:"max_skew_secs_15m"`
	Samples15m      int     `json:"samples_15m"`
	LastSkewSecs    *uint64 `json:"last_skew_secs,omitempty"`
	LastSource      string  `json:"last_source,omitempty"`
	LastSeenAgeSecs *uint64 `json:"last_seen_age_secs,omitempty"`
}

// RuntimeMeSelftestIPFamilyData is one address family's detected-IP self-test row.
type RuntimeMeSelftestIPFamilyData struct {
	Addr  string `json:"addr"`
	State string `json:"state"`
}

// RuntimeMeSelftestIPData holds the v4/v6 detected-IP self-test rows.
type RuntimeMeSelftestIPData struct {
	V4 *RuntimeMeSelftestIPFamilyData `json:"v4,omitempty"`
	V6 *RuntimeMeSelftestIPFamilyData `json:"v6,omitempty"`
}

// RuntimeMeSelftestPidData reports the ME child-process self-test.
type RuntimeMeSelftestPidData struct {
	PID   uint32 `json:"pid"`
	State string `json:"state"`
}

// RuntimeMeSelftestBndData reports the ME BND (bind-address) self-test.
type RuntimeMeSelftestBndData struct {
	AddrState       string  `json:"addr_state"`
	PortState       string  `json:"port_state"`
	LastAddr        string  `json:"last_addr,omitempty"`
	LastSeenAgeSecs *uint64 `json:"last_seen_age_secs,omitempty"`
}

// RuntimeMeSelftestUpstreamData is one upstream's BND/IP self-test row.
type RuntimeMeSelftestUpstreamData struct {
	UpstreamID int                       `json:"upstream_id"`
	RouteKind  string                    `json:"route_kind"`
	Address    string                    `json:"address"`
	Bnd        *RuntimeMeSelftestBndData `json:"bnd,omitempty"`
	IP         string                    `json:"ip,omitempty"`
}

// RuntimeMeSelftestPayload is the Gated[T] payload of GET /v1/runtime/me-selftest.
type RuntimeMeSelftestPayload struct {
	Kdf       RuntimeMeSelftestKdfData        `json:"kdf"`
	Timeskew  RuntimeMeSelftestTimeskewData   `json:"timeskew"`
	IP        RuntimeMeSelftestIPData         `json:"ip"`
	Pid       RuntimeMeSelftestPidData        `json:"pid"`
	Bnd       *RuntimeMeSelftestBndData       `json:"bnd"`
	Upstreams []RuntimeMeSelftestUpstreamData `json:"upstreams,omitempty"`
}

// EffectiveTimeoutLimits is the effective (post-clamp) timeout configuration.
type EffectiveTimeoutLimits struct {
	ClientFirstByteIdleSecs uint64 `json:"client_first_byte_idle_secs"`
	ClientHandshakeSecs     uint64 `json:"client_handshake_secs"`
	TgConnectSecs           uint64 `json:"tg_connect_secs"`
	ClientKeepaliveSecs     uint64 `json:"client_keepalive_secs"`
	ClientAckSecs           uint64 `json:"client_ack_secs"`
	MeOneRetry              uint8  `json:"me_one_retry"`
	MeOneTimeoutMs          uint64 `json:"me_one_timeout_ms"`
}

// EffectiveUpstreamLimits is the effective upstream-connect policy.
type EffectiveUpstreamLimits struct {
	ConnectRetryAttempts      uint32 `json:"connect_retry_attempts"`
	ConnectRetryBackoffMs     uint64 `json:"connect_retry_backoff_ms"`
	ConnectBudgetMs           uint64 `json:"connect_budget_ms"`
	UnhealthyFailThreshold    uint32 `json:"unhealthy_fail_threshold"`
	ConnectFailfastHardErrors bool   `json:"connect_failfast_hard_errors"`
}

// EffectiveMiddleProxyLimits is the effective ME-pool floor/reconnect policy.
type EffectiveMiddleProxyLimits struct {
	FloorMode                                 string `json:"floor_mode"`
	AdaptiveFloorIdleSecs                     uint64 `json:"adaptive_floor_idle_secs"`
	AdaptiveFloorMinWritersSingleEndpoint     uint8  `json:"adaptive_floor_min_writers_single_endpoint"`
	AdaptiveFloorMinWritersMultiEndpoint      uint8  `json:"adaptive_floor_min_writers_multi_endpoint"`
	AdaptiveFloorRecoverGraceSecs             uint64 `json:"adaptive_floor_recover_grace_secs"`
	AdaptiveFloorWritersPerCoreTotal          uint16 `json:"adaptive_floor_writers_per_core_total"`
	AdaptiveFloorCPUCoresOverride             uint16 `json:"adaptive_floor_cpu_cores_override"`
	AdaptiveFloorMaxExtraWritersSinglePerCore uint16 `json:"adaptive_floor_max_extra_writers_single_per_core"`
	AdaptiveFloorMaxExtraWritersMultiPerCore  uint16 `json:"adaptive_floor_max_extra_writers_multi_per_core"`
	AdaptiveFloorMaxActiveWritersPerCore      uint16 `json:"adaptive_floor_max_active_writers_per_core"`
	AdaptiveFloorMaxWarmWritersPerCore        uint16 `json:"adaptive_floor_max_warm_writers_per_core"`
	AdaptiveFloorMaxActiveWritersGlobal       uint32 `json:"adaptive_floor_max_active_writers_global"`
	AdaptiveFloorMaxWarmWritersGlobal         uint32 `json:"adaptive_floor_max_warm_writers_global"`
	ReconnectMaxConcurrentPerDc               uint32 `json:"reconnect_max_concurrent_per_dc"`
	ReconnectBackoffBaseMs                    uint64 `json:"reconnect_backoff_base_ms"`
	ReconnectBackoffCapMs                     uint64 `json:"reconnect_backoff_cap_ms"`
	ReconnectFastRetryCount                   uint32 `json:"reconnect_fast_retry_count"`
	WriterPickMode                            string `json:"writer_pick_mode"`
	WriterPickSampleSize                      uint8  `json:"writer_pick_sample_size"`
	Me2DcFallback                             bool   `json:"me2dc_fallback"`
	Me2DcFast                                 bool   `json:"me2dc_fast"`
}

// EffectiveUserIPPolicyLimits is the effective per-user unique-IP policy.
type EffectiveUserIPPolicyLimits struct {
	GlobalEach int    `json:"global_each"`
	Mode       string `json:"mode"`
	WindowSecs uint64 `json:"window_secs"`
}

// EffectiveUserTCPPolicyLimits is the effective per-user TCP-connection policy.
type EffectiveUserTCPPolicyLimits struct {
	GlobalEach int `json:"global_each"`
}

// EffectiveLimitsData is the payload of GET /v1/limits/effective — note the
// route lives directly under /v1/limits, not /v1/runtime, despite being
// conceptually part of the runtime group (verified against mod.rs's route
// table). Like Gates/Initialization this group is always enabled and is
// never wrapped in Gated[T].
type EffectiveLimitsData struct {
	UpdateEverySecs      uint64                       `json:"update_every_secs"`
	MeReinitEverySecs    uint64                       `json:"me_reinit_every_secs"`
	MePoolForceCloseSecs uint64                       `json:"me_pool_force_close_secs"`
	Timeouts             EffectiveTimeoutLimits       `json:"timeouts"`
	Upstream             EffectiveUpstreamLimits      `json:"upstream"`
	MiddleProxy          EffectiveMiddleProxyLimits   `json:"middle_proxy"`
	UserIPPolicy         EffectiveUserIPPolicyLimits  `json:"user_ip_policy"`
	UserTCPPolicy        EffectiveUserTCPPolicyLimits `json:"user_tcp_policy"`
}
