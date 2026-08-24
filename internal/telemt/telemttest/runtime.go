package telemttest

import (
	"net/http"
	"net/url"
	"strconv"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func (s *Server) handleGates(w http.ResponseWriter) {
	writeOK(w, http.StatusOK, telemt.RuntimeGatesData{
		AcceptingNewConnections: true, UseMiddleProxy: true, MeRuntimeReady: true,
		RouteMode: "middle_proxy", StartupStatus: "ready", StartupStage: "done", StartupProgressPct: 100,
	}, s.revision())
}

func (s *Server) handleInitialization(w http.ResponseWriter) {
	writeOK(w, http.StatusOK, telemt.RuntimeInitializationData{
		Status: "ready", CurrentStage: "done", ProgressPct: 100, StartedAtEpochSecs: 1000,
		TransportMode: "middle_proxy",
		Me:            telemt.RuntimeInitializationMeData{Status: "ready", CurrentStage: "done", ProgressPct: 100, RetryLimit: "unbounded"},
		Components:    []telemt.RuntimeInitializationComponentData{{ID: "me_pool_construct", Title: "ME pool", Status: "ready", Attempts: 1}},
	}, s.revision())
}

func (s *Server) handleEffectiveLimits(w http.ResponseWriter) {
	writeOK(w, http.StatusOK, telemt.EffectiveLimitsData{
		UpdateEverySecs: 5, MeReinitEverySecs: 60, MePoolForceCloseSecs: 30,
		Timeouts:      telemt.EffectiveTimeoutLimits{ClientHandshakeSecs: 10, TgConnectSecs: 10, ClientKeepaliveSecs: 60, ClientAckSecs: 30},
		Upstream:      telemt.EffectiveUpstreamLimits{ConnectRetryAttempts: 3, ConnectBudgetMs: 5000, UnhealthyFailThreshold: 3},
		MiddleProxy:   telemt.EffectiveMiddleProxyLimits{FloorMode: "adaptive", WriterPickMode: "p2c"},
		UserIPPolicy:  telemt.EffectiveUserIPPolicyLimits{GlobalEach: 3, Mode: "active_window", WindowSecs: 3600},
		UserTCPPolicy: telemt.EffectiveUserTCPPolicyLimits{GlobalEach: 8},
	}, s.revision())
}

func (s *Server) handleMePoolState(w http.ResponseWriter) {
	if s.scenario.MinimalRuntimeOff {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeMePoolStatePayload]{
			Enabled: false, Reason: "source_unavailable", GeneratedAtEpochSecs: 5000,
		}, s.revision())
		return
	}
	payload := telemt.RuntimeMePoolStatePayload{
		Generations: telemt.RuntimeMePoolStateGenerationData{ActiveGeneration: 3, WarmGeneration: 3},
		Hardswap:    telemt.RuntimeMePoolStateHardswapData{Enabled: true},
		Writers:     telemt.RuntimeMePoolStateWriterData{Total: 2, AliveNonDraining: 2},
		Refill:      telemt.RuntimeMePoolStateRefillData{},
	}
	writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeMePoolStatePayload]{
		Enabled: true, GeneratedAtEpochSecs: 5000, Data: &payload,
	}, s.revision())
}

func (s *Server) handleMeQuality(w http.ResponseWriter) {
	if s.scenario.MinimalRuntimeOff {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeMeQualityPayload]{
			Enabled: false, Reason: "source_unavailable", GeneratedAtEpochSecs: 5000,
		}, s.revision())
		return
	}
	payload := telemt.RuntimeMeQualityPayload{
		Counters:  telemt.RuntimeMeQualityCountersData{ReconnectSuccessTotal: 5},
		DrainGate: telemt.RuntimeMeQualityDrainGateData{RouteQuorumOK: true, RedundancyOK: true, BlockReason: "none"},
	}
	writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeMeQualityPayload]{
		Enabled: true, GeneratedAtEpochSecs: 5000, Data: &payload,
	}, s.revision())
}

func (s *Server) handleUpstreamQuality(w http.ResponseWriter) {
	data := telemt.RuntimeUpstreamQualityData{
		GeneratedAtEpochSecs: 5000,
		Policy:               telemt.RuntimeUpstreamQualityPolicyData{ConnectRetryAttempts: 3, ConnectBudgetMs: 5000},
		Counters:             telemt.RuntimeUpstreamQualityCountersData{ConnectAttemptTotal: 50, ConnectSuccessTotal: 48},
	}
	if s.scenario.MinimalRuntimeOff {
		data.Enabled = false
		data.Reason = "feature_disabled"
		writeOK(w, http.StatusOK, data, s.revision())
		return
	}
	data.Enabled = true
	summary := telemt.RuntimeUpstreamQualitySummaryData{ConfiguredTotal: 1, HealthyTotal: 1, DirectTotal: 1}
	data.Summary = &summary
	writeOK(w, http.StatusOK, data, s.revision())
}

func (s *Server) handleNatStun(w http.ResponseWriter) {
	if s.scenario.MinimalRuntimeOff {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeNatStunPayload]{
			Enabled: false, Reason: "source_unavailable", GeneratedAtEpochSecs: 5000,
		}, s.revision())
		return
	}
	payload := telemt.RuntimeNatStunPayload{
		Flags:   telemt.RuntimeNatStunFlagsData{NatProbeEnabled: true, NatProbeAttempts: 3},
		Servers: telemt.RuntimeNatStunServersData{Configured: []string{"stun.example.com:3478"}, Live: []string{"stun.example.com:3478"}, LiveTotal: 1},
		Reflection: telemt.RuntimeNatStunReflectionBlockData{
			V4: &telemt.RuntimeNatStunReflectionData{Addr: "203.0.113.5", AgeSecs: 10},
		},
	}
	writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeNatStunPayload]{
		Enabled: true, GeneratedAtEpochSecs: 5000, Data: &payload,
	}, s.revision())
}

func (s *Server) handleMeSelftest(w http.ResponseWriter) {
	if s.scenario.MinimalRuntimeOff {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeMeSelftestPayload]{
			Enabled: false, Reason: "source_unavailable", GeneratedAtEpochSecs: 5000,
		}, s.revision())
		return
	}
	payload := telemt.RuntimeMeSelftestPayload{
		Kdf:      telemt.RuntimeMeSelftestKdfData{State: "ok", ThresholdErrorsPerMin: 0.3},
		Timeskew: telemt.RuntimeMeSelftestTimeskewData{State: "ok", Samples15m: 10},
		IP:       telemt.RuntimeMeSelftestIPData{V4: &telemt.RuntimeMeSelftestIPFamilyData{Addr: "203.0.113.5", State: "ok"}},
		Pid:      telemt.RuntimeMeSelftestPidData{PID: 4242, State: "ok"},
	}
	writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeMeSelftestPayload]{
		Enabled: true, GeneratedAtEpochSecs: 5000, Data: &payload,
	}, s.revision())
}

func (s *Server) handleConnectionsSummary(w http.ResponseWriter) {
	if !s.scenario.RuntimeEdge {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeEdgeConnectionsSummaryPayload]{
			Enabled: false, Reason: "feature_disabled", GeneratedAtEpochSecs: 5000,
		}, s.revision())
		return
	}
	payload := telemt.RuntimeEdgeConnectionsSummaryPayload{
		Totals: telemt.RuntimeEdgeConnectionTotalsData{CurrentConnections: 2, ActiveUsers: 1},
		Top: telemt.RuntimeEdgeConnectionTopData{Limit: 10, ByConnections: []telemt.RuntimeEdgeConnectionUserData{
			{Username: "alice", CurrentConnections: 2, TotalOctets: 123456789},
		}},
	}
	writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeEdgeConnectionsSummaryPayload]{
		Enabled: true, GeneratedAtEpochSecs: 5000, Data: &payload,
	}, s.revision())
}

func (s *Server) handleRecentEvents(w http.ResponseWriter, rawQuery string) {
	if !s.scenario.RuntimeEdge {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeEdgeEventsPayload]{
			Enabled: false, Reason: "feature_disabled", GeneratedAtEpochSecs: 5000,
		}, s.revision())
		return
	}
	limit := 50
	if v, err := url.ParseQuery(rawQuery); err == nil {
		if raw := v.Get("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				limit = parsed
			}
		}
	}
	events := []telemt.EventRecord{{Seq: 1, TsEpochSecs: 4990, EventType: "config.reload.applied", Context: "generation 3 activated"}}
	if len(events) > limit {
		events = events[:limit]
	}
	payload := telemt.RuntimeEdgeEventsPayload{Capacity: 200, Events: events}
	writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeEdgeEventsPayload]{
		Enabled: true, GeneratedAtEpochSecs: 5000, Data: &payload,
	}, s.revision())
}

func (s *Server) handleTLSFingerprints(w http.ResponseWriter, rawQuery string) {
	if !s.scenario.RuntimeEdge {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeEdgeTLSFingerprintsPayload]{
			Enabled: false, Reason: "feature_disabled", GeneratedAtEpochSecs: 5000,
		}, s.revision())
		return
	}
	limit := 50
	if v, err := url.ParseQuery(rawQuery); err == nil {
		if raw := v.Get("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				limit = parsed
			}
		}
	}
	rows := []telemt.RuntimeEdgeTLSFingerprintRow{
		{JA3: "aaaa", JA3Raw: "raw-aaaa", JA4: "bbbb", JA4Raw: "raw-bbbb", Total: 5, AuthSuccess: 5, FirstSeenEpochSecs: 100, LastSeenEpochSecs: 5000},
	}
	if len(rows) > limit {
		rows = rows[:limit]
	}
	payload := telemt.RuntimeEdgeTLSFingerprintsPayload{Limit: limit, RetentionSecs: 900, Capacity: 500, ByFingerprint: rows}
	writeOK(w, http.StatusOK, telemt.Gated[telemt.RuntimeEdgeTLSFingerprintsPayload]{
		Enabled: true, GeneratedAtEpochSecs: 5000, Data: &payload,
	}, s.revision())
}
