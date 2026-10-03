package telemt

// WebIngressStatus describes this process's private TCP ingress, not external
// TLS termination or client reachability. Telemt 3.5.6 adds this status group.
type WebIngressStatus struct {
	ConfiguredListeners  uint64 `json:"configured_listeners"`
	LiveAcceptors        uint64 `json:"live_acceptors"`
	AcceptingConnections bool   `json:"accepting_connections"`
	Reason               string `json:"reason,omitempty"`
	TCPAcceptTotal       uint64 `json:"tcp_accept_total"`
	TCPAcceptErrorTotal  uint64 `json:"tcp_accept_error_total"`
}

// WebCapacityResourceStatus is current retained usage against one immutable
// process-wide ceiling. Available is measured before class-specific reserves.
type WebCapacityResourceStatus struct {
	Resource  string `json:"resource"`
	Unit      string `json:"unit"`
	Used      uint64 `json:"used"`
	Available uint64 `json:"available"`
	Limit     uint64 `json:"limit"`
	Closed    bool   `json:"closed"`
}

// WebRejectionCounter counts one terminal decision over this process's
// lifetime. Reason stays open to future tokens; this is not a sliding window.
type WebRejectionCounter struct {
	Reason string `json:"reason"`
	Total  uint64 `json:"total"`
}

// WebOutcomeCounter counts a fixed outcome over this process's lifetime.
type WebOutcomeCounter struct {
	Outcome string `json:"outcome"`
	Total   uint64 `json:"total"`
}

// WebCapacityStatus separates capacity saturation, terminal rejections and
// contended observation planes. Partial names omitted planes, never zero usage.
type WebCapacityStatus struct {
	HTTPConnectionCapacityAction   string                      `json:"http_connection_capacity_action"`
	MaxHTTPOverloadConnections     uint64                      `json:"max_http_overload_connections"`
	HTTPOverloadTimeoutMs          uint64                      `json:"http_overload_timeout_ms"`
	Resources                      []WebCapacityResourceStatus `json:"resources"`
	SaturatedResources             []string                    `json:"saturated_resources"`
	Partial                        []string                    `json:"partial"`
	Rejections                     []WebRejectionCounter       `json:"rejections"`
	HTTPConnectionOverloadOutcomes []WebOutcomeCounter         `json:"http_connection_overload_outcomes"`
}

// WebDecoyUpstreamStatus reports passive outcomes of the internal plain-HTTP
// origin hop. LastOutcomeAgeMs is absent until an outcome has been observed.
type WebDecoyUpstreamStatus struct {
	Outcomes         []WebOutcomeCounter `json:"outcomes"`
	LastOutcome      string              `json:"last_outcome,omitempty"`
	LastOutcomeAgeMs *uint64             `json:"last_outcome_age_ms,omitempty"`
}
