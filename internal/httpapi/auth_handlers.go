package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

// loginRequestBodyLimit caps the login request body (api/openapi.yaml
// /api/auth/login), well above any real username/password payload.
const loginRequestBodyLimit = 1 << 20 // 1MB

// loginRequest is the /api/auth/login body. TOTP is accepted but unused
// until the TOTP milestone lands (spec 05-auth.md).
type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	TOTP     string `json:"totp"`
}

// handleLogin implements POST /api/auth/login: verify credentials, rate
// limit failures per client IP, and start a session on success.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, loginRequestBodyLimit)

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		return
	}

	ip := auth.ClientIP(r, s.cfg.TrustedProxyPrefixes)
	if !s.limiter.Allow(ip) {
		auth.WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many failed login attempts")
		return
	}

	if !auth.VerifyCredentials(s.cfg.Auth.Username, s.cfg.Auth.PasswordHash, req.Username, req.Password) {
		s.limiter.RecordFailure(ip)
		s.appendAudit("login.failed", req.Username, "ip="+ip)
		auth.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "invalid username or password")
		return
	}

	token, err := auth.NewToken()
	if err != nil {
		slog.Error("login: generate session token", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not create session")
		return
	}

	now := time.Now()
	sess := store.Session{
		IDHash:         auth.HashToken(token),
		Created:        now,
		LastSeen:       now,
		IP:             ip,
		UserAgentLabel: userAgentLabel(r),
		AuthMethod:     "password",
	}
	if err := s.st.PutSession(sess); err != nil {
		slog.Error("login: store session", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not create session")
		return
	}

	auth.SetSessionCookie(w, r, s.cfg, token)
	s.appendAudit("login", req.Username, "ip="+ip)
	w.WriteHeader(http.StatusNoContent)
}

// handleLogout implements POST /api/auth/logout: revoke the session
// server-side (a real revocation, not just clearing the cookie) and clear
// the cookie.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if idHash, ok := auth.SessionIDHashFromContext(r.Context()); ok {
		if err := s.st.DeleteSession(idHash); err != nil {
			slog.Error("logout: delete session", "err", err)
		}
	}
	username, _ := auth.UsernameFromContext(r.Context())
	s.appendAudit("logout", username, "")

	auth.ClearSessionCookie(w, r, s.cfg)
	w.WriteHeader(http.StatusNoContent)
}

// passkeyInfo mirrors api/openapi.yaml schema PasskeyInfo. Always empty
// until the passkey milestone lands.
type passkeyInfo struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Created time.Time `json:"created"`
}

// meResponse mirrors the /api/auth/me 200 response.
type meResponse struct {
	Username    string        `json:"username"`
	TOTPEnabled bool          `json:"totp_enabled"`
	Passkeys    []passkeyInfo `json:"passkeys"`
}

// handleMe implements GET /api/auth/me.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	username, _ := auth.UsernameFromContext(r.Context())
	writeJSON(w, http.StatusOK, meResponse{
		Username:    username,
		TOTPEnabled: false,
		Passkeys:    []passkeyInfo{},
	})
}

// sessionInfo mirrors api/openapi.yaml schema SessionInfo. ID is the
// session's store key (IDHash) — the store never holds the raw token, so
// there is nothing more sensitive to expose here.
type sessionInfo struct {
	ID             string    `json:"id"`
	Created        time.Time `json:"created"`
	LastSeen       time.Time `json:"last_seen"`
	IP             string    `json:"ip,omitempty"`
	UserAgentLabel string    `json:"user_agent_label,omitempty"`
	AuthMethod     string    `json:"auth_method,omitempty"`
	Current        bool      `json:"current"`
}

// handleListSessions implements GET /api/auth/sessions.
func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	current, _ := auth.SessionIDHashFromContext(r.Context())

	sessions, err := s.st.ListSessions()
	if err != nil {
		slog.Error("list sessions", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not list sessions")
		return
	}

	out := make([]sessionInfo, 0, len(sessions))
	for _, sess := range sessions {
		out = append(out, sessionInfo{
			ID:             sess.IDHash,
			Created:        sess.Created,
			LastSeen:       sess.LastSeen,
			IP:             sess.IP,
			UserAgentLabel: sess.UserAgentLabel,
			AuthMethod:     sess.AuthMethod,
			Current:        sess.IDHash == current,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleRevokeOtherSessions implements DELETE /api/auth/sessions: revoke
// every session except the caller's current one.
func (s *Server) handleRevokeOtherSessions(w http.ResponseWriter, r *http.Request) {
	current, _ := auth.SessionIDHashFromContext(r.Context())
	if err := s.st.DeleteOtherSessions(current); err != nil {
		slog.Error("revoke other sessions", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not revoke sessions")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleRevokeSession implements DELETE /api/auth/sessions/{sessionId}.
func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")

	_, ok, err := s.st.GetSession(sessionID)
	if err != nil {
		slog.Error("revoke session: lookup", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not revoke session")
		return
	}
	if !ok {
		auth.WriteError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}

	if err := s.st.DeleteSession(sessionID); err != nil {
		slog.Error("revoke session: delete", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not revoke session")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// appendAudit records an audit entry, logging (not failing the request) on
// a store error — the audit log is best-effort observability, not the
// source of truth for whether the action itself succeeded.
func (s *Server) appendAudit(action, subject, detail string) {
	err := s.st.AppendAudit(store.AuditEntry{
		TS:      time.Now(),
		Action:  action,
		Subject: subject,
		Detail:  detail,
	})
	if err != nil {
		slog.Error("append audit entry", "action", action, "err", err)
	}
}

// userAgentLabel returns the raw User-Agent header, capped to a sane
// length for storage. Parsing it into a human label ("iPhone · Safari") is
// UI polish for a later milestone; the SessionInfo field is otherwise
// usable as-is.
func userAgentLabel(r *http.Request) string {
	const maxLen = 200
	ua := r.Header.Get("User-Agent")
	if len(ua) > maxLen {
		ua = ua[:maxLen]
	}
	return ua
}
