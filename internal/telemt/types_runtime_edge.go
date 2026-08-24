package telemt

// RuntimeEdgeConnectionUserData is one user's row in a connections top-N list.
type RuntimeEdgeConnectionUserData struct {
	Username           string `json:"username"`
	CurrentConnections uint64 `json:"current_connections"`
	TotalOctets        uint64 `json:"total_octets"`
}

// RuntimeEdgeConnectionTotalsData is the aggregate connection counts.
type RuntimeEdgeConnectionTotalsData struct {
	CurrentConnections       uint64 `json:"current_connections"`
	CurrentConnectionsMe     uint64 `json:"current_connections_me"`
	CurrentConnectionsDirect uint64 `json:"current_connections_direct"`
	ActiveUsers              int    `json:"active_users"`
}

// RuntimeEdgeConnectionTopData holds the top-N-by-connections and
// top-N-by-throughput user lists.
type RuntimeEdgeConnectionTopData struct {
	Limit         int                             `json:"limit"`
	ByConnections []RuntimeEdgeConnectionUserData `json:"by_connections"`
	ByThroughput  []RuntimeEdgeConnectionUserData `json:"by_throughput"`
}

// RuntimeEdgeConnectionCacheData reports whether this response came from the
// runtime-edge cache and whether that cache was stale.
type RuntimeEdgeConnectionCacheData struct {
	TTLMs           uint64 `json:"ttl_ms"`
	ServedFromCache bool   `json:"served_from_cache"`
	StaleCacheUsed  bool   `json:"stale_cache_used"`
}

// RuntimeEdgeConnectionTelemetryData reports the telemetry policy in effect
// for the connections summary.
type RuntimeEdgeConnectionTelemetryData struct {
	UserEnabled            bool `json:"user_enabled"`
	ThroughputIsCumulative bool `json:"throughput_is_cumulative"`
}

// RuntimeEdgeConnectionsSummaryPayload is the Gated[T] payload of
// GET /v1/runtime/connections/summary.
type RuntimeEdgeConnectionsSummaryPayload struct {
	Cache     RuntimeEdgeConnectionCacheData     `json:"cache"`
	Totals    RuntimeEdgeConnectionTotalsData    `json:"totals"`
	Top       RuntimeEdgeConnectionTopData       `json:"top"`
	Telemetry RuntimeEdgeConnectionTelemetryData `json:"telemetry"`
}

// EventRecord is one panel-visible runtime event (config reloads, admission
// state changes, user mutations — anything Telemt records via
// shared.runtime_events).
type EventRecord struct {
	Seq         uint64 `json:"seq"`
	TsEpochSecs int64  `json:"ts_epoch_secs"`
	EventType   string `json:"event_type"`
	Context     string `json:"context"`
}

// RuntimeEdgeEventsPayload is the Gated[T] payload of GET /v1/runtime/events/recent.
type RuntimeEdgeEventsPayload struct {
	Capacity     int           `json:"capacity"`
	DroppedTotal uint64        `json:"dropped_total"`
	Events       []EventRecord `json:"events"`
}

// RuntimeEdgeTLSFingerprintRow is one aggregated JA3/JA4 fingerprint row,
// grouped by fingerprint, source IP, CIDR, or user depending on which
// RuntimeEdgeTLSFingerprintsPayload field it appears in.
type RuntimeEdgeTLSFingerprintRow struct {
	Scope              string `json:"scope,omitempty"`
	JA3                string `json:"ja3"`
	JA3Raw             string `json:"ja3_raw"`
	JA4                string `json:"ja4"`
	JA4Raw             string `json:"ja4_raw"`
	Total              uint64 `json:"total"`
	AuthSuccess        uint64 `json:"auth_success"`
	BadOrProbe         uint64 `json:"bad_or_probe"`
	FirstSeenEpochSecs int64  `json:"first_seen_epoch_secs"`
	LastSeenEpochSecs  int64  `json:"last_seen_epoch_secs"`
}

// RuntimeEdgeTLSFingerprintsPayload is the Gated[T] payload of
// GET /v1/runtime/tls-fingerprints.
type RuntimeEdgeTLSFingerprintsPayload struct {
	Limit           int                            `json:"limit"`
	RetentionSecs   uint64                         `json:"retention_secs"`
	Capacity        int                            `json:"capacity"`
	DroppedTotal    uint64                         `json:"dropped_total"`
	ParseErrorTotal uint64                         `json:"parse_error_total"`
	ByFingerprint   []RuntimeEdgeTLSFingerprintRow `json:"by_fingerprint"`
	ByIP            []RuntimeEdgeTLSFingerprintRow `json:"by_ip"`
	ByCIDR          []RuntimeEdgeTLSFingerprintRow `json:"by_cidr"`
	ByUser          []RuntimeEdgeTLSFingerprintRow `json:"by_user"`
}
