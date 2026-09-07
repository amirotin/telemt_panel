package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

const maxStorageSettingsBody = 64 << 10

type storageSettingsView struct {
	Policies     []store.StoragePolicy `json:"policies"`
	Stats        store.StorageStats    `json:"stats"`
	StateDurable bool                  `json:"state_durable"`
}

type storagePurgeRequest struct {
	Category store.StorageCategory `json:"category"`
	Confirm  bool                  `json:"confirm"`
}

type destructiveConfirmationRequest struct {
	Confirm bool `json:"confirm"`
}

// handleGetStorageSettings implements GET /api/settings/storage.
func (s *Server) handleGetStorageSettings(w http.ResponseWriter, _ *http.Request) {
	policies, err := s.st.ListStoragePolicies()
	if err != nil {
		slog.Error("read storage policies", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read storage settings")
		return
	}
	stats, err := s.st.StorageStats()
	if err != nil {
		slog.Error("read storage stats", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not read storage usage")
		return
	}
	writeJSON(w, http.StatusOK, storageSettingsView{
		Policies:     policies,
		Stats:        stats,
		StateDurable: s.st.StateDurable(),
	})
}

// handlePutStorageSettings implements PUT /api/settings/storage.
func (s *Server) handlePutStorageSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Policies []store.StoragePolicy `json:"policies"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxStorageSettingsBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	if err := s.st.ReplaceStoragePolicies(req.Policies); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	s.appendAudit(r, "storage.policy_change", "storage", "")
	w.WriteHeader(http.StatusNoContent)
}

// handlePurgeStorageHistory implements POST /api/settings/storage/purge.
func (s *Server) handlePurgeStorageHistory(w http.ResponseWriter, r *http.Request) {
	var req storagePurgeRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxStorageSettingsBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	if !req.Confirm {
		auth.WriteError(w, http.StatusBadRequest, "confirmation_required", "history purge requires explicit confirmation")
		return
	}
	var err error
	if req.Category == store.StorageUserIPHistory {
		err = s.resetUserIPHistory("")
	} else {
		err = s.st.PurgeHistory(req.Category)
	}
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	s.appendAudit(r, "storage.history_purge", string(req.Category), "")
	w.WriteHeader(http.StatusNoContent)
}

// handleResetUserTraffic removes one account's accumulated total, baseline
// and graph history. Deleting a Telemt account does not call this handler.
func (s *Server) handleResetUserTraffic(w http.ResponseWriter, r *http.Request) {
	username := r.PathValue("username")
	if username == "" {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "username is required")
		return
	}
	if !decodeDestructiveConfirmation(w, r, "user traffic reset requires explicit confirmation") {
		return
	}
	if err := s.st.DeleteUserHistory(username); err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not reset user traffic")
		return
	}
	s.appendAudit(r, "user.traffic_reset", username, "")
	w.WriteHeader(http.StatusNoContent)
}

// handleResetAllUserTraffic removes every accumulated total, baseline and
// graph bucket. The next coherent collector snapshot creates fresh baselines.
func (s *Server) handleResetAllUserTraffic(w http.ResponseWriter, r *http.Request) {
	if !decodeDestructiveConfirmation(w, r, "user traffic reset requires explicit confirmation") {
		return
	}
	if err := s.st.ResetUserTraffic(); err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not reset user traffic")
		return
	}
	s.appendAudit(r, "traffic.reset", "user_traffic", "")
	w.WriteHeader(http.StatusNoContent)
}

func decodeDestructiveConfirmation(w http.ResponseWriter, r *http.Request, message string) bool {
	var req destructiveConfirmationRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxStorageSettingsBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return false
	}
	if !req.Confirm {
		auth.WriteError(w, http.StatusBadRequest, "confirmation_required", message)
		return false
	}
	return true
}
