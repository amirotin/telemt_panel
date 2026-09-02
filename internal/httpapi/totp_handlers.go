package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

const (
	totpRequestBodyLimit = 4 << 10
	totpCodeMaxBytes     = 64
	totpGlobalLimiterKey = "\x00totp-global"
)

type totpSetupResponse struct {
	ProvisioningURL string `json:"otpauth_url"`
	Secret          string `json:"secret"`
}

type totpCodeRequest struct {
	Code string `json:"code"`
}

type totpEnableResponse struct {
	RecoveryCodes []string `json:"recovery_codes"`
}

func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		slog.Error("TOTP setup: generate secret", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start TOTP setup")
		return
	}
	if err := s.st.BeginTOTPSetup(secret, time.Now().Add(auth.TOTPSetupTTL)); err != nil {
		if errors.Is(err, store.ErrTOTPAlreadyEnabled) {
			auth.WriteError(w, http.StatusConflict, "totp_already_enabled", "TOTP is already enabled")
			return
		}
		slog.Error("TOTP setup: persist pending secret", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not start TOTP setup")
		return
	}
	writeJSON(w, http.StatusOK, totpSetupResponse{
		ProvisioningURL: auth.TOTPProvisioningURI("Telemt Panel", s.cfg.Auth.Username, secret),
		Secret:          secret,
	})
}

func (s *Server) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	var req totpCodeRequest
	r.Body = http.MaxBytesReader(w, r.Body, totpRequestBodyLimit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil || len(req.Code) > totpCodeMaxBytes {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid TOTP code")
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid TOTP code")
		return
	}
	if !s.limiter.Allow(totpGlobalLimiterKey) {
		auth.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many failed second-factor attempts")
		return
	}
	state, err := s.st.GetTOTPState()
	if err != nil {
		slog.Error("TOTP enable: read pending setup", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not enable TOTP")
		return
	}
	now := time.Now()
	_, valid := auth.ValidateTOTP(state.PendingSecret, strings.TrimSpace(req.Code), now)
	if state.Enabled || state.PendingSecret == "" || !state.PendingExpires.After(now) || !valid {
		s.limiter.RecordFailure(totpGlobalLimiterKey)
		auth.WriteError(w, http.StatusBadRequest, "invalid_totp", "invalid or expired TOTP setup")
		return
	}
	codes, hashes, err := auth.GenerateRecoveryCodes()
	if err != nil {
		slog.Error("TOTP enable: generate recovery codes", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not enable TOTP")
		return
	}
	if err := s.st.EnableTOTP(state.PendingSecret, now, hashes); err != nil {
		if errors.Is(err, store.ErrTOTPSetupInvalid) {
			auth.WriteError(w, http.StatusConflict, "totp_setup_changed", "TOTP setup expired or was replaced")
			return
		}
		slog.Error("TOTP enable: persist factor", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not enable TOTP")
		return
	}
	s.appendAudit(r, "totp.enable", "", "")
	writeJSON(w, http.StatusOK, totpEnableResponse{RecoveryCodes: codes})
}

func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DisableTOTP(); err != nil {
		slog.Error("TOTP disable", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not disable TOTP")
		return
	}
	s.appendAudit(r, "totp.disable", "", "")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) acceptSecondFactor(secret, code string, now time.Time) (string, error) {
	code = strings.TrimSpace(code)
	if len(code) > totpCodeMaxBytes {
		return "", store.ErrRecoveryCode
	}
	if step, ok := auth.ValidateTOTP(secret, code, now); ok {
		if err := s.st.AcceptTOTPTimestep(step); err != nil {
			return "", err
		}
		return "password+totp", nil
	}
	hash := auth.RecoveryCodeHash(code)
	if err := s.st.ConsumeRecoveryCode(hash[:]); err != nil {
		return "", err
	}
	return "password+recovery", nil
}

func isSecondFactorRejection(err error) bool {
	return errors.Is(err, store.ErrTOTPReplay) || errors.Is(err, store.ErrRecoveryCode)
}
