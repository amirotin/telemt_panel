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
// telemt.ConfigSections's json.RawMessage fields so GetConfig's decode path
// is exercised the same way it would be against real Telemt. request_body_limit_bytes
// is deliberately a value that only survives round-trip as an integer (not a
// float) — see the "known rakes" integer round-trip test.
func sampleConfigSections() telemt.ConfigSections {
	general, _ := json.Marshal(map[string]any{
		"log_level":                  "info",
		"use_middle_proxy":           true,
		"request_body_limit_bytes":   65536,
		"upstream_connect_budget_ms": 5000,
	})
	timeouts, _ := json.Marshal(map[string]any{"client_handshake": 10, "client_keepalive": 60})
	return telemt.ConfigSections{General: general, Timeouts: timeouts}
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
		DeferredProcessFields: []string{},
	}
	status := http.StatusOK
	if mode != "" {
		accepted := s.submitReload(mode, values.Get("timeout_secs"), values.Get("failure_policy"), result.Revision)
		result.Reload = &accepted
		status = http.StatusAccepted
	}
	writeOK(w, status, result, result.Revision)
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
