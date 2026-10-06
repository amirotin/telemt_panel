package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

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
func (s *Server) handleGetStorageSettings(w http.ResponseWriter, r *http.Request) {
	policies, err := s.st.ListStoragePolicies()
	if err != nil {
		slog.Error("read storage policies", "err", err)
		writeHistoryError(w, err, "could not read storage settings")
		return
	}
	stats, err := s.st.StorageStatsContext(r.Context())
	if err != nil {
		slog.Error("read storage stats", "err", err)
		writeHistoryError(w, err, "could not read storage usage")
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
		Policies                  []store.StoragePolicy `json:"policies"`
		ConfirmRetentionReduction bool                  `json:"confirm_retention_reduction"`
	}
	if err := decodeJSONBody(w, r, &req, jsonBodyOptions{MaxBytes: maxStorageSettingsBody, RejectUnknown: true}); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	if err := store.ValidateStoragePolicies(req.Policies); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	// The previous policy, confirmation check and commit form one mutation.
	// Otherwise concurrent requests can silently replace an unlimited cap with
	// an older finite value without obtaining confirmation for that reduction.
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	s.storagePolicyOnce.Do(func() { s.storagePolicyGate = make(chan struct{}, 1) })
	select {
	case s.storagePolicyGate <- struct{}{}:
		defer func() { <-s.storagePolicyGate }()
	case <-ctx.Done():
		writeHistoryError(w, ctx.Err(), "could not save storage settings")
		return
	}
	if err := ctx.Err(); err != nil {
		writeHistoryError(w, err, "could not save storage settings")
		return
	}
	previous, err := s.st.ListStoragePolicies()
	if err != nil {
		writeHistoryError(w, err, "could not read storage settings")
		return
	}
	// Older clients omit the optional cap; preserve the current policy rather
	// than converting an explicit unlimited setting back to the legacy default.
	for i := range req.Policies {
		if req.Policies[i].Category != store.StorageUserIPHistory || req.Policies[i].MaxIPsPerUser != nil {
			continue
		}
		for _, old := range previous {
			if old.Category == store.StorageUserIPHistory {
				limit := store.EffectiveUserIPLimit(old)
				req.Policies[i].MaxIPsPerUser = &limit
				break
			}
		}
	}
	if !req.ConfirmRetentionReduction {
		for _, next := range req.Policies {
			for _, old := range previous {
				if next.Category != old.Category {
					continue
				}
				lowerIPLimit := false
				if next.Category == store.StorageUserIPHistory {
					before, after := store.EffectiveUserIPLimit(old), store.EffectiveUserIPLimit(next)
					lowerIPLimit = after > 0 && (before == 0 || after < before)
				}
				if next.RetentionDays < old.RetentionDays || lowerIPLimit {
					auth.WriteError(w, http.StatusBadRequest, "confirmation_required", "shorter retention or a lower IP history limit requires explicit confirmation")
					return
				}
			}
		}
	}
	if err := s.st.ReplaceStoragePoliciesContext(ctx, req.Policies); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, store.ErrHistoryTimeout) {
			writeHistoryError(w, err, "could not save storage settings")
		} else {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		}
		return
	}
	s.appendAudit(r, "storage.policy_change", "storage", "")
	w.WriteHeader(http.StatusNoContent)
}

// handlePurgeStorageHistory implements POST /api/settings/storage/purge.
func (s *Server) handlePurgeStorageHistory(w http.ResponseWriter, r *http.Request) {
	var req storagePurgeRequest
	if err := decodeJSONBody(w, r, &req, jsonBodyOptions{MaxBytes: maxStorageSettingsBody, RejectUnknown: true}); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}
	if !req.Confirm {
		auth.WriteError(w, http.StatusBadRequest, "confirmation_required", "history purge requires explicit confirmation")
		return
	}
	var err error
	if req.Category == store.StorageUserIPHistory {
		err = s.resetUserIPHistoryContext(r.Context(), "")
	} else {
		err = s.st.PurgeHistoryContext(r.Context(), req.Category)
	}
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, store.ErrHistoryTimeout) {
			writeHistoryError(w, err, "could not purge history")
		} else {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		}
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
	if err := s.st.DeleteUserHistoryContext(r.Context(), username); err != nil {
		writeHistoryError(w, err, "could not reset user traffic")
		return
	}
	s.appendAudit(r, "user.traffic_reset", username, "")
	if s.hub != nil {
		s.pokeUsersAfterMutation()
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleResetAllUserTraffic removes every accumulated total, baseline and
// graph bucket. The next coherent collector snapshot creates fresh baselines.
func (s *Server) handleResetAllUserTraffic(w http.ResponseWriter, r *http.Request) {
	if !decodeDestructiveConfirmation(w, r, "user traffic reset requires explicit confirmation") {
		return
	}
	if err := s.st.ResetUserTrafficContext(r.Context()); err != nil {
		writeHistoryError(w, err, "could not reset user traffic")
		return
	}
	s.appendAudit(r, "traffic.reset", "user_traffic", "")
	if s.hub != nil {
		s.pokeUsersAfterMutation()
	}
	w.WriteHeader(http.StatusNoContent)
}

func decodeDestructiveConfirmation(w http.ResponseWriter, r *http.Request, message string) bool {
	var req destructiveConfirmationRequest
	if err := decodeJSONBody(w, r, &req, jsonBodyOptions{MaxBytes: maxStorageSettingsBody, RejectUnknown: true}); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return false
	}
	if !req.Confirm {
		auth.WriteError(w, http.StatusBadRequest, "confirmation_required", message)
		return false
	}
	return true
}
