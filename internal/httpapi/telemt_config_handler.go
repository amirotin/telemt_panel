package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// telemtConfigRequestTimeout bounds every handler in this file: config
// reads/patches and reload submissions are all single round-trips to
// Telemt, not the kind of long-running operation update.Engine models.
const telemtConfigRequestTimeout = 15 * time.Second

// maxTelemtConfigPatchBody bounds PATCH /api/telemt/config and POST
// /api/telemt/reload request bodies. This is a DoS backstop on the panel's
// own side, not a mirror of Telemt's limit — it's deliberately larger than
// Telemt's own 64KiB default body-size limit (07-telemt-sdk.md,
// config/defaults.rs::default_api_request_body_limit_bytes), so a
// legitimately large config patch isn't truncated by the panel before it
// even reaches Telemt; a patch that's still too big for Telemt's own limit
// surfaces as a normal payload_too_large passthrough from that call
// (writeTelemtConfigError → writeTelemtError's 4xx passthrough), not a
// panel-side rejection.
const maxTelemtConfigPatchBody = 256 << 10

// telemtConfigView mirrors api/openapi.yaml TelemtConfig: a passthrough of
// GET /v1/config's editable sections plus the revision to chain into a
// later PATCH's If-Match.
type telemtConfigView struct {
	Revision string                `json:"revision"`
	Sections telemt.ConfigSections `json:"sections"`
}

// requireConfigAPI checks the config_api capability before either config
// handler touches Telemt, per the task brief: a build/config without the
// config API reports 503 capability_unavailable up front rather than
// falling through to the generic old-build 404 mapping. A Capabilities
// probe failure (context only — see Capabilities' doc comment) is treated
// as "don't know, don't block" and lets the real GetConfig/PatchConfig call
// surface its own error.
func (s *Server) requireConfigAPI(w http.ResponseWriter, r *http.Request) bool {
	caps, err := s.tc.Capabilities(r.Context())
	if err == nil && !caps.ConfigAPI {
		auth.WriteError(w, http.StatusServiceUnavailable, "capability_unavailable", "telemt build/config does not expose the config API (config_edit_mode=file is not implemented in this release)")
		return false
	}
	return true
}

// handleGetTelemtConfig implements GET /api/telemt/config: a passthrough of
// Telemt's editable config sections plus the revision.
func (s *Server) handleGetTelemtConfig(w http.ResponseWriter, r *http.Request) {
	if !s.requireConfigAPI(w, r) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	sections, revision, err := s.tc.GetConfig(ctx)
	if err != nil {
		writeTelemtConfigError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, telemtConfigView{Revision: revision, Sections: sections})
}

// telemtConfigPatchRequest is the body of PATCH /api/telemt/config: a
// sparse map of section name to that section's JSON Merge Patch value,
// forwarded to telemt.PatchConfig as-is. The revision travels as an
// If-Match header (required), not a body field — see handlePatchTelemtConfig.
type telemtConfigPatchRequest struct {
	Sections map[string]json.RawMessage `json:"sections"`
}

// parseTelemtReloadQuery reads the optional reload=instant|drain,
// timeout_secs, failure_policy query parameters PATCH /api/telemt/config
// forwards into telemt.PatchConfig's inline-reload query (07-telemt-sdk.md
// §Config) — absent reload means "patch only, no inline reload" (SDK's
// ReloadQuery zero value).
func parseTelemtReloadQuery(q url.Values) (telemt.ReloadQuery, error) {
	if len(q) == 0 {
		return telemt.ReloadQuery{}, nil
	}
	for key, values := range q {
		switch key {
		case "reload", "timeout_secs", "failure_policy":
		default:
			return telemt.ReloadQuery{}, fmt.Errorf("unknown query parameter: %s", key)
		}
		if len(values) != 1 {
			return telemt.ReloadQuery{}, fmt.Errorf("duplicate query parameter: %s", key)
		}
	}

	mode, ok := q["reload"]
	if !ok {
		return telemt.ReloadQuery{}, errors.New("reload query parameter is required")
	}
	if mode[0] != telemt.ReloadModeInstant && mode[0] != telemt.ReloadModeDrain {
		return telemt.ReloadQuery{}, errors.New("reload must be instant or drain")
	}
	rq := telemt.ReloadQuery{Mode: mode[0]}
	if values, ok := q["failure_policy"]; ok {
		if values[0] != "keep_new" && values[0] != "rollback" {
			return telemt.ReloadQuery{}, errors.New("failure_policy must be keep_new or rollback")
		}
		rq.FailurePolicy = values[0]
	}
	if values, ok := q["timeout_secs"]; ok {
		raw := values[0]
		n, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			return telemt.ReloadQuery{}, errors.New("timeout_secs must be an integer")
		}
		rq.TimeoutSecs = &n
	}
	if rq.Mode == telemt.ReloadModeInstant && rq.TimeoutSecs != nil {
		return telemt.ReloadQuery{}, errors.New("timeout_secs is only valid when mode is drain")
	}
	if rq.Mode == telemt.ReloadModeDrain {
		if rq.TimeoutSecs == nil {
			return telemt.ReloadQuery{}, errors.New("timeout_secs is required when mode is drain")
		}
		if *rq.TimeoutSecs < 1 || *rq.TimeoutSecs > 3600 {
			return telemt.ReloadQuery{}, errors.New("timeout_secs must be within 1..=3600")
		}
	}
	return rq, nil
}

// handlePatchTelemtConfig implements PATCH /api/telemt/config: a
// passthrough of telemt.PatchConfig, with the caller's revision sent as
// If-Match (required — see 07-telemt-sdk.md §SDK-5: "SDK шлёт If-Match
// всегда, когда у вызывающего кода есть ревизия"; the panel client always
// has one, from a prior GET) and an optional inline reload via query
// parameters.
func (s *Server) handlePatchTelemtConfig(w http.ResponseWriter, r *http.Request) {
	if !s.requireConfigAPI(w, r) {
		return
	}

	revision := r.Header.Get("If-Match")
	if revision == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "If-Match header is required (use the revision from a prior GET /api/telemt/config)")
		return
	}

	var req telemtConfigPatchRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxTelemtConfigPatchBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "request body must contain exactly one JSON object")
		return
	}
	if len(req.Sections) == 0 {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "sections must not be empty")
		return
	}
	reload, err := parseTelemtReloadQuery(r.URL.Query())
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	snapshot, _, err := s.tc.GetConfig(ctx)
	if err != nil {
		writeTelemtConfigError(w, err)
		return
	}
	if err := validateTelemtConfigPatch(req.Sections, snapshot); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	patch := make(map[string]any, len(req.Sections))
	for section, value := range req.Sections {
		patch[section] = value
	}
	result, status, _, err := s.tc.PatchConfig(ctx, patch, revision, reload)
	if err != nil {
		writeTelemtConfigError(w, err)
		return
	}
	s.appendAudit(r, "config.patch", "", strings.Join(result.Changed, ","))
	writeJSON(w, status, result)
}

// writeTelemtConfigError maps a telemt.APIError from GetConfig/PatchConfig
// to the panel's envelope. The three "this edit is not allowed" codes map
// to 422 regardless of whatever HTTP status Telemt itself used, per the
// task brief; every other code (notably revision_conflict, read_only, and
// the generic 4xx passthrough) is handled by writeTelemtError exactly like
// every other Telemt-backed endpoint.
func writeTelemtConfigError(w http.ResponseWriter, err error) {
	var apiErr *telemt.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Code {
		case "access_not_editable", "section_not_editable", "field_not_editable", "config_patch_not_atomic", "ambiguous_listeners":
			auth.WriteError(w, http.StatusUnprocessableEntity, apiErr.Code, apiErr.Message)
			return
		}
	}
	writeTelemtError(w, err, false)
}

// handleTelemtReload implements POST /api/telemt/reload: a passthrough of
// telemt.Reload. An empty body is valid (Telemt defaults mode to instant);
// If-Match is optional here (unlike the config patch above) since a manual
// "reload now" click may not be chained from a prior config read.
func (s *Server) handleTelemtReload(w http.ResponseWriter, r *http.Request) {
	var req telemt.ReloadRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(io.LimitReader(r.Body, maxTelemtConfigPatchBody)).Decode(&req); err != nil {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	accepted, _, err := s.tc.Reload(ctx, req, r.Header.Get("If-Match"))
	if err != nil {
		writeTelemtReloadError(w, err)
		return
	}
	s.appendAudit(r, "telemt.reload", "", accepted.Mode)
	writeJSON(w, http.StatusAccepted, accepted)
}

// handleTelemtReloadStatus implements GET /api/telemt/reload/{id}.
func (s *Server) handleTelemtReloadStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "id must be a positive integer")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	status, err := s.tc.ReloadStatus(ctx, id)
	if err != nil {
		writeTelemtReloadError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// writeTelemtReloadError maps a telemt.APIError from the reload endpoints.
// reload_not_found (Telemt's actual code for "unknown reload id" — absent
// from 07-telemt-sdk.md's master error-code list, see task-1's discrepancy
// note) must map to 404 before the old-build "route absent" fallback below:
// both are well-formed 404s, but writeTelemtError's capabilityGated branch
// only special-cases the generic "not_found" code the same way, and
// reload_not_found is a different string — without this, a genuine unknown
// reload id on a build that DOES have the reload API would be
// misreported as 501 capability_absent.
func writeTelemtReloadError(w http.ResponseWriter, err error) {
	var apiErr *telemt.APIError
	if errors.As(err, &apiErr) && apiErr.Code == "reload_not_found" {
		auth.WriteError(w, http.StatusNotFound, apiErr.Code, apiErr.Message)
		return
	}
	// capabilityGated=true: an old Telemt build that predates the reload
	// API (07-telemt-sdk.md: "существует... v1-эпоха его не имела") 404s/
	// 405s with no envelope, which writeTelemtError reports as 501
	// capability_absent — matching the pre-existing openapi draft for this
	// endpoint ("Capability absent — offer service restart instead").
	writeTelemtError(w, err, true)
}

// handleTelemtRestart implements POST /api/telemt/restart: a service-level
// restart through the host layer (01-host-matrix.md), independent of the
// config-reload endpoints above — this restarts the whole process (for a
// binary update or a wedged process), not just a config re-read.
func (s *Server) handleTelemtRestart(w http.ResponseWriter, r *http.Request) {
	caps := s.svcMgr.Caps()
	if !caps.CanRestart || s.privilegesMode == host.PrivilegesModeManual {
		hint := caps.ManualRestartHint
		if caps.CanRestart {
			hint = manualRestartCommand(s.svcMgr.Kind(), s.telemtServiceName)
		}
		auth.WriteError(w, http.StatusServiceUnavailable, "manual_restart_required",
			fmt.Sprintf("automatic restart is not available on this host: %s", hint))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), telemtConfigRequestTimeout)
	defer cancel()

	if _, err := s.runner.Run(ctx, host.Op{Kind: host.OpRestartService, Args: map[string]string{
		host.ArgService: s.telemtServiceName,
	}}); err != nil {
		auth.WriteError(w, http.StatusBadGateway, "internal_error", "restart failed: "+err.Error())
		return
	}
	s.appendAudit(r, "telemt.restart", "", "")
	w.WriteHeader(http.StatusAccepted)
}
