package telemttest

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// sampleConfigSections is fixture TOML-shaped config data, marshaled through
// telemt.ConfigSections's json.RawMessage values so GetConfig's decode path
// is exercised the same way it would be against real Telemt. request_body_limit_bytes
// is deliberately a value that only survives round-trip as an integer (not a
// float) — see the "known rakes" integer round-trip test. `web` is the
// section Telemt 3.5.3+ made editable (API.md §ConfigData); it is here so
// the dev stack and the handler tests exercise a section the panel knows
// nothing about beyond passing it through, `web.limits` included (that
// subtable is the process-deferred one Telemt reports in
// deferred_process_fields).
func sampleConfigSections() telemt.ConfigSections {
	general, _ := json.Marshal(map[string]any{
		"log_level":                  "info",
		"use_middle_proxy":           true,
		"request_body_limit_bytes":   65536,
		"upstream_connect_budget_ms": 5000,
	})
	timeouts, _ := json.Marshal(map[string]any{"client_handshake": 10, "client_keepalive": 60})
	web, _ := json.Marshal(map[string]any{
		"enabled":          true,
		"carrier":          "https-lanes",
		"carrier_learning": true,
		"limits": map[string]any{
			"max_sessions_global":     128,
			"max_streams_per_session": 128,
		},
	})
	return telemt.ConfigSections{"general": general, "timeouts": timeouts, "web": web}
}

func (s *Server) handleGetConfig(w http.ResponseWriter) {
	if s.scenario.OldBuild {
		writeBareNotFound(w)
		return
	}
	writeOK(w, http.StatusOK, sampleConfigSections(), s.revision())
}

func (s *Server) bodyLimit() int {
	if s.scenario.BodyLimitBytes > 0 {
		return s.scenario.BodyLimitBytes
	}
	return defaultBodyLimitBytes
}

func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request, rawQuery string) {
	if s.scenario.OldBuild {
		writeBareNotFound(w)
		return
	}
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	if expected := r.Header.Get("If-Match"); expected != "" && expected != s.revision() {
		writeErr(w, http.StatusConflict, "revision_conflict", "config revision mismatch")
		return
	}

	limited := io.LimitReader(r.Body, int64(s.bodyLimit()+1))
	body, err := io.ReadAll(limited)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	if len(body) > s.bodyLimit() {
		writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds the configured limit")
		return
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(body, &patch); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if len(patch) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "empty patch: no editable sections")
		return
	}

	changed := make([]string, 0, len(patch))
	for section := range patch {
		changed = append(changed, section)
	}

	values, _ := url.ParseQuery(rawQuery)
	mode := values.Get("reload")
	result := telemt.PatchConfigResult{
		Revision: s.bumpRevision(), RuntimeReloadRequired: true, Changed: changed,
		DeferredProcessFields: deferredProcessFields(patch),
	}
	result.ProcessRestartRequired = len(result.DeferredProcessFields) > 0
	status := http.StatusOK
	if mode != "" {
		accepted := s.submitReload(mode, values.Get("timeout_secs"), values.Get("failure_policy"), result.Revision)
		result.Reload = &accepted
		status = http.StatusAccepted
	}
	writeOK(w, status, result, result.Revision)
}

// deferredProcessFields mirrors the one process-deferred config path real
// Telemt reports today: any change under `[web.limits]` is accepted as
// desired configuration but only takes effect after a process restart
// (API.md §ConfigData). Everything else in this fake reloads in place.
func deferredProcessFields(patch map[string]json.RawMessage) []string {
	web, ok := patch["web"]
	if !ok {
		return []string{}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(web, &fields); err != nil {
		return []string{}
	}
	if _, ok := fields["limits"]; !ok {
		return []string{}
	}
	return []string{"web.limits"}
}

func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	if s.scenario.OldBuild {
		writeBareNotFound(w)
		return
	}
	if s.scenario.ReadOnly {
		writeReadOnly(w)
		return
	}
	if expected := r.Header.Get("If-Match"); expected != "" && expected != s.revision() {
		writeErr(w, http.StatusConflict, "revision_conflict", "config revision mismatch")
		return
	}
	var req telemt.ReloadRequest
	body, _ := io.ReadAll(r.Body)
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
	}
	mode := req.Mode
	if mode == "" {
		mode = telemt.ReloadModeInstant
	}
	failurePolicy := req.FailurePolicy
	if failurePolicy == "" {
		failurePolicy = telemt.ReloadFailurePolicyKeepNew
	}
	timeoutSecs := ""
	if req.TimeoutSecs != nil {
		timeoutSecs = strconv.FormatUint(*req.TimeoutSecs, 10)
	}
	accepted := s.submitReload(mode, timeoutSecs, failurePolicy, s.revision())
	writeOK(w, http.StatusAccepted, accepted, s.revision())
}

// submitReload records a new reload operation in the succeeded terminal
// state — telemttest is a synchronous fake, so there is no pending phase to
// simulate; tests polling ReloadStatus see the terminal state immediately.
func (s *Server) submitReload(mode, timeoutSecs, failurePolicy, configRevision string) telemt.ReloadAccepted {
	if mode == "" {
		mode = telemt.ReloadModeInstant
	}
	if failurePolicy == "" {
		failurePolicy = telemt.ReloadFailurePolicyKeepNew
	}
	s.nextReloadID++
	id := s.nextReloadID
	accepted := telemt.ReloadAccepted{
		ReloadID: id, TargetGeneration: id, ConfigRevision: configRevision,
		State: telemt.ReloadPhaseAccepted, Mode: mode, FailurePolicy: failurePolicy,
	}
	_ = timeoutSecs
	s.reloads[id] = telemt.ReloadStatus{
		ReloadID: id, TargetGeneration: id, ConfigRevision: configRevision,
		State: telemt.ReloadPhaseSucceeded, Mode: mode, FailurePolicy: failurePolicy,
		RequestedAtEpochSecs: 5000,
	}
	return accepted
}

func (s *Server) handleReloadStatus(w http.ResponseWriter, idStr string) {
	if s.scenario.OldBuild {
		writeBareNotFound(w)
		return
	}
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		writeErr(w, http.StatusNotFound, "reload_not_found", "invalid reload id")
		return
	}
	status, ok := s.reloads[id]
	if !ok {
		writeErr(w, http.StatusNotFound, "reload_not_found", "no such reload")
		return
	}
	writeOK(w, http.StatusOK, status, s.revision())
}
