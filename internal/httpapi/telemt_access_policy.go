package httpapi

import (
	"context"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

type telemtAccessPolicyView struct {
	Revision string `json:"revision"`
	telemt.AccessPolicyState
}

func (s *Server) handleGetTelemtAccessPolicy(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTelemtConfigTimeout(r)
	defer cancel()
	data, revision, err := s.tc.AccessPolicy(ctx)
	if err != nil {
		writeTelemtOptionalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, telemtAccessPolicyView{revision, data})
}

func (s *Server) handlePatchTelemtAccessPolicy(w http.ResponseWriter, r *http.Request) {
	revision := r.Header.Get("If-Match")
	if revision == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "If-Match header is required")
		return
	}
	var patch telemt.AccessPolicyPatch
	if err := decodeJSONBody(w, r, &patch, jsonBodyOptions{MaxBytes: maxTelemtConfigPatchBody}); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid policy object")
		return
	}
	if err := patch.Validate(); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), telemt.ConfigMutationTimeout)
	defer cancel()
	if !allowTelemtConfigMutationResponse(w, ctx) {
		return
	}
	data, next, err := s.tc.PatchAccessPolicy(ctx, patch, revision, r.Header.Get("If-Runtime-Match"))
	if err != nil {
		writeTelemtOptionalError(w, err)
		return
	}
	s.appendAudit(r, "access.policy.patch", "", "")
	writeJSON(w, http.StatusOK, telemtAccessPolicyView{next, data})
}
