package telemttest

import (
	"encoding/json"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

func rawInt(v int64) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func (s *Server) handleZeroAll(w http.ResponseWriter) {
	data := telemt.ZeroAllData{
		GeneratedAtEpochSecs: s.generatedAt(),
		Core: telemt.ZeroSection{
			"uptime_seconds":            rawInt(3600),
			"connections_total":         rawInt(100),
			"telemetry_me_level":        json.RawMessage(`"basic"`),
			"conntrack_pressure_active": json.RawMessage(`false`),
		},
		Upstream:    telemt.ZeroSection{"connect_attempt_total": rawInt(50)},
		MiddleProxy: telemt.ZeroSection{"keepalive_sent_total": rawInt(10)},
		Pool:        telemt.ZeroSection{"pool_swap_total": rawInt(2)},
		Desync:      telemt.ZeroSection{"desync_total": rawInt(0)},
	}
	writeOK(w, http.StatusOK, data, s.revision())
}

func (s *Server) zeroUpstream() telemt.ZeroUpstreamData {
	return telemt.ZeroUpstreamData{ConnectAttemptTotal: 50, ConnectSuccessTotal: 48, ConnectFailTotal: 2}
}

func (s *Server) handleUpstreams(w http.ResponseWriter) {
	data := telemt.UpstreamsData{
		GeneratedAtEpochSecs: s.generatedAt(),
		Zero:                 s.zeroUpstream(),
	}
	if s.scenario.MinimalRuntimeOff {
		data.Enabled = false
		data.Reason = "feature_disabled"
		writeOK(w, http.StatusOK, data, s.revision())
		return
	}
	// The flag is on but the upstream manager's try_read lost: Telemt keeps
	// `enabled` true and reports the missing snapshot as a source state
	// (runtime_stats.rs::build_upstreams_data) — nothing to switch on.
	if s.scenario.UpstreamSourceDown {
		data.Enabled = true
		data.Reason = "source_unavailable"
		writeOK(w, http.StatusOK, data, s.revision())
		return
	}
	data.Enabled = true
	latency := 12.5
	summary := telemt.UpstreamSummaryData{ConfiguredTotal: 1, HealthyTotal: 1, DirectTotal: 1}
	data.Summary = &summary
	data.Upstreams = []telemt.UpstreamStatus{{
		UpstreamID: 1, RouteKind: "direct", Address: "198.51.100.1:443", Weight: 1,
		Scopes: "all", Healthy: true, EffectiveLatencyMs: &latency,
		DC: []telemt.UpstreamDcStatus{{DC: 2, LatencyEmaMs: &latency, IPPreference: "prefer_v4"}},
	}}
	writeOK(w, http.StatusOK, data, s.revision())
}

func (s *Server) disabledMeWriters(reason string) telemt.MeWritersData {
	return telemt.MeWritersData{MiddleProxyEnabled: false, Reason: reason, GeneratedAtEpochSecs: s.generatedAt(), Writers: []telemt.MeWriterStatus{}}
}

func (s *Server) enabledMeWriters() telemt.MeWritersData {
	return telemt.MeWritersData{
		MiddleProxyEnabled: true, GeneratedAtEpochSecs: s.generatedAt(),
		Summary: telemt.MeWritersSummary{ConfiguredDcGroups: 1, ConfiguredEndpoints: 2, AvailableEndpoints: 2, RequiredWriters: 2, AliveWriters: 2, CoveragePct: 100},
		Writers: []telemt.MeWriterStatus{{WriterID: 1, Endpoint: "1.2.3.4:443", State: "alive", MatchesActiveGeneration: true}},
	}
}

func (s *Server) handleMeWriters(w http.ResponseWriter) {
	if s.scenario.MinimalRuntimeOff {
		writeOK(w, http.StatusOK, s.disabledMeWriters("feature_disabled"), s.revision())
		return
	}
	if s.scenario.MePoolDown {
		writeOK(w, http.StatusOK, s.disabledMeWriters("source_unavailable"), s.revision())
		return
	}
	writeOK(w, http.StatusOK, s.enabledMeWriters(), s.revision())
}

func (s *Server) disabledDCs(reason string) telemt.DcStatusData {
	return telemt.DcStatusData{MiddleProxyEnabled: false, Reason: reason, GeneratedAtEpochSecs: s.generatedAt(), DCs: []telemt.DcStatus{}}
}

func (s *Server) enabledDCs() telemt.DcStatusData {
	return telemt.DcStatusData{
		MiddleProxyEnabled: true, GeneratedAtEpochSecs: s.generatedAt(),
		DCs: []telemt.DcStatus{{DC: 2, Endpoints: []string{"1.2.3.4:443"}, AvailableEndpoints: 1, RequiredWriters: 2, AliveWriters: 2, CoveragePct: 100}},
	}
}

func (s *Server) handleDCs(w http.ResponseWriter) {
	if s.scenario.MinimalRuntimeOff {
		writeOK(w, http.StatusOK, s.disabledDCs("feature_disabled"), s.revision())
		return
	}
	if s.scenario.MePoolDown {
		writeOK(w, http.StatusOK, s.disabledDCs("source_unavailable"), s.revision())
		return
	}
	writeOK(w, http.StatusOK, s.enabledDCs(), s.revision())
}

func (s *Server) handleMinimalAll(w http.ResponseWriter) {
	if s.scenario.MinimalRuntimeOff {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.MinimalAllPayload]{
			Enabled: false, Reason: "feature_disabled", GeneratedAtEpochSecs: s.generatedAt(),
		}, s.revision())
		return
	}
	// The flag is on but the ME pool is gone: Telemt still answers
	// `enabled: true` and pushes the source state down into the nested
	// payloads (runtime_stats.rs::build_minimal_all_data).
	if s.scenario.MePoolDown {
		writeOK(w, http.StatusOK, telemt.Gated[telemt.MinimalAllPayload]{
			Enabled: true, Reason: "source_unavailable", GeneratedAtEpochSecs: s.generatedAt(),
			Data: &telemt.MinimalAllPayload{
				MeWriters: s.disabledMeWriters("source_unavailable"),
				DCs:       s.disabledDCs("source_unavailable"),
			},
		}, s.revision())
		return
	}
	payload := telemt.MinimalAllPayload{
		MeWriters:   s.enabledMeWriters(),
		DCs:         s.enabledDCs(),
		NetworkPath: []telemt.MinimalDcPathData{{DC: 2, IPPreference: "prefer_v4"}},
	}
	writeOK(w, http.StatusOK, telemt.Gated[telemt.MinimalAllPayload]{
		Enabled: true, GeneratedAtEpochSecs: s.generatedAt(), Data: &payload,
	}, s.revision())
}
