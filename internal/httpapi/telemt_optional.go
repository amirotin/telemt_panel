package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

func (s *Server) handleTelemtCapabilities(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTelemtConfigTimeout(r)
	defer cancel()
	data, err := s.tc.Discovery(ctx)
	if err != nil {
		writeTelemtOptionalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) handleTelemtConfigSchema(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTelemtConfigTimeout(r)
	defer cancel()
	data, err := s.tc.ConfigSchema(ctx)
	if err != nil {
		writeTelemtOptionalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) handleTelemtConfigState(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTelemtConfigTimeout(r)
	defer cancel()
	data, revision, err := s.tc.ConfigState(ctx)
	if err != nil {
		writeTelemtOptionalError(w, err)
		return
	}
	raw, err := json.Marshal(data)
	if err != nil {
		writeTelemtOptionalError(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		writeTelemtOptionalError(w, err)
		return
	}
	fields["revision"], _ = json.Marshal(revision)
	writeJSON(w, http.StatusOK, fields)
}

func (s *Server) handleTelemtConfigValidate(w http.ResponseWriter, r *http.Request) {
	revision := r.Header.Get("If-Match")
	if revision == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "If-Match header is required")
		return
	}
	var req telemtConfigPatchRequest
	if err := decodeJSONBody(w, r, &req, jsonBodyOptions{MaxBytes: maxTelemtConfigPatchBody, RejectUnknown: true}); err != nil || len(req.Sections) == 0 {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "sections must be a non-empty object")
		return
	}
	reload, err := parseTelemtReloadQuery(r.URL.Query())
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), telemt.ConfigMutationTimeout)
	defer cancel()
	if !allowTelemtConfigMutationResponse(w, ctx) {
		return
	}
	patch := make(map[string]any, len(req.Sections))
	for name, value := range req.Sections {
		patch[name] = value
	}
	data, next, err := s.tc.ValidateConfig(ctx, patch, revision, r.Header.Get("If-Runtime-Match"), reload)
	if err != nil {
		writeTelemtOptionalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Revision string `json:"revision"`
		telemt.ConfigValidationData
	}{next, data})
}

func writeTelemtOptionalError(w http.ResponseWriter, err error) {
	var apiErr *telemt.APIError
	if errors.As(err, &apiErr) && (apiErr.Status == 404 || apiErr.Status == 405) {
		auth.WriteError(w, http.StatusNotImplemented, "capability_absent", "telemt build does not support this operation")
		return
	}
	writeTelemtConfigError(w, err)
}

func writeTelemtDetailedError(w http.ResponseWriter, status int, apiErr *telemt.APIError) {
	writeJSON(w, status, struct {
		Code    string              `json:"code"`
		Message string              `json:"message"`
		Details []telemt.FieldIssue `json:"details,omitempty"`
	}{apiErr.Code, apiErr.Message, apiErr.Details})
}
