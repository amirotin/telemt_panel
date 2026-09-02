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
	Policies         []store.StoragePolicy `json:"policies"`
	Stats            store.StorageStats    `json:"stats"`
	ConfiguredDriver string                `json:"configured_driver"`
	ActiveDriver     string                `json:"active_driver"`
	StoreError       string                `json:"store_error,omitempty"`
}

type storagePurgeRequest struct {
	Category store.StorageCategory `json:"category"`
	Confirm  bool                  `json:"confirm"`
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
	runtime := store.Runtime(s.st, s.cfg.Store.Driver)
	writeJSON(w, http.StatusOK, storageSettingsView{
		Policies:         policies,
		Stats:            stats,
		ConfiguredDriver: runtime.ConfiguredDriver,
		ActiveDriver:     runtime.ActiveDriver,
		StoreError:       runtime.Error,
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
	if err := s.st.PurgeHistory(req.Category); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	s.appendAudit(r, "storage.history_purge", string(req.Category), "")
	w.WriteHeader(http.StatusNoContent)
}
