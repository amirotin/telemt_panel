package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/store"
)

// loginRequestBodyLimit caps the login request body (api/openapi.yaml
// /api/auth/login), well above any real username/password payload.
const loginRequestBodyLimit = 1 << 20 // 1MB

// loginUsernameMaxBytes bounds an accepted login username. A request over
// this is rejected before auth.VerifyCredentials — which always runs
// bcrypt, matched username or not, specifically to avoid a timing oracle —
// so an oversized username can't be used to force wasted bcrypt work; no
// legitimate username is anywhere near this long. Also the cap applied to
// the audit Subject for login.failed entries, so an oversized or
// adversarial username can't bloat the audit log either.
const loginUsernameMaxBytes = 256

// truncateAuditSubject caps s to loginUsernameMaxBytes on a byte boundary —
// fine for an audit log field, where a truncated multi-byte rune at the cut
// is cosmetic, not a correctness concern.
func truncateAuditSubject(s string) string {
	if len(s) <= loginUsernameMaxBytes {
		return s
	}
	return s[:loginUsernameMaxBytes]
}

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

	if len(req.Username) > loginUsernameMaxBytes {
		s.limiter.RecordFailure(ip)
		s.appendAudit(r, "login.failed", truncateAuditSubject(req.Username), "ip="+ip)
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "username too long")
		return
	}

	if !auth.VerifyCredentials(s.cfg.Auth.Username, s.cfg.Auth.PasswordHash, req.Username, req.Password) {
		s.limiter.RecordFailure(ip)
		s.appendAudit(r, "login.failed", truncateAuditSubject(req.Username), "ip="+ip)
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
	s.appendAudit(r, "login", req.Username, "ip="+ip)
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
	s.appendAudit(r, "logout", username, "")

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

type sessionPage struct {
	Items       []sessionInfo `json:"items"`
	Total       int           `json:"total"`
	DeviceCount int           `json:"device_count"`
	NextCursor  string        `json:"next_cursor,omitempty"`
}

const (
	defaultSessionPageSize = 30
	maxSessionPageSize     = 100
	maxSessionSearchBytes  = 200
)

func encodeSessionCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func decodeSessionCursor(cursor string) (int, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, err
	}
	offset, err := strconv.Atoi(string(raw))
	if err != nil || offset < 0 {
		return 0, strconv.ErrSyntax
	}
	return offset, nil
}

// handleListSessions implements GET /api/auth/sessions. A session whose
// LastSeen has aged past the TTL is filtered out and lazily deleted here —
// the same expiry rule RequireSession enforces on every request
// (auth.SessionExpired) — so a session that would already be rejected as
// expired on use never shows up as a live device in the list.
func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	current, _ := auth.SessionIDHashFromContext(r.Context())
	limit := defaultSessionPageSize
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxSessionPageSize {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "limit must be between 1 and 100")
			return
		}
		limit = parsed
	}
	offset := 0
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		parsed, err := decodeSessionCursor(raw)
		if err != nil {
			auth.WriteError(w, http.StatusBadRequest, "bad_request", "invalid session cursor")
			return
		}
		offset = parsed
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if len(query) > maxSessionSearchBytes {
		auth.WriteError(w, http.StatusBadRequest, "bad_request", "session search is too long")
		return
	}

	sessions, err := s.st.ListSessions()
	if err != nil {
		slog.Error("list sessions", "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not list sessions")
		return
	}

	now := time.Now()
	ttl := s.cfg.Auth.SessionTTLDuration()
	active := make([]store.Session, 0, len(sessions))
	for _, sess := range sessions {
		if auth.SessionExpired(now.Sub(sess.LastSeen), ttl) {
			if err := s.st.DeleteSession(sess.IDHash); err != nil {
				slog.Error("list sessions: delete expired", "err", err)
			}
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(sess.IP), query) &&
			!strings.Contains(strings.ToLower(sess.UserAgentLabel), query) {
			continue
		}
		active = append(active, sess)
	}
	slices.SortFunc(active, func(a, b store.Session) int {
		aCurrent := a.IDHash == current
		bCurrent := b.IDHash == current
		if aCurrent != bCurrent {
			if aCurrent {
				return -1
			}
			return 1
		}
		if bySeen := b.LastSeen.Compare(a.LastSeen); bySeen != 0 {
			return bySeen
		}
		return strings.Compare(a.IDHash, b.IDHash)
	})

	deviceKeys := make(map[string]struct{}, len(active))
	for _, sess := range active {
		key := strings.ToLower(strings.TrimSpace(sess.UserAgentLabel)) + "\x00" + strings.ToLower(strings.TrimSpace(sess.IP))
		if key == "\x00" {
			key = sess.IDHash
		}
		deviceKeys[key] = struct{}{}
	}

	if offset > len(active) {
		offset = len(active)
	}
	end := min(offset+limit, len(active))
	items := make([]sessionInfo, 0, end-offset)
	for _, sess := range active[offset:end] {
		items = append(items, sessionInfo{
			ID:             sess.IDHash,
			Created:        sess.Created,
			LastSeen:       sess.LastSeen,
			IP:             sess.IP,
			UserAgentLabel: sess.UserAgentLabel,
			AuthMethod:     sess.AuthMethod,
			Current:        sess.IDHash == current,
		})
	}
	nextCursor := ""
	if end < len(active) {
		nextCursor = encodeSessionCursor(end)
	}
	writeJSON(w, http.StatusOK, sessionPage{
		Items:       items,
		Total:       len(active),
		DeviceCount: len(deviceKeys),
		NextCursor:  nextCursor,
	})
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
func (s *Server) appendAudit(r *http.Request, action, subject, detail string) {
	now := time.Now()
	actor, _ := auth.UsernameFromContext(r.Context())
	if actor == "" && (action == "login" || action == "login.failed") {
		actor = subject
	}
	ip := auth.ClientIP(r, s.cfg.TrustedProxyPrefixes)
	if strings.HasPrefix(detail, "ip=") {
		ip = strings.TrimPrefix(detail, "ip=")
	}
	err := s.st.AppendAudit(store.AuditEntry{
		TS:      now,
		ID:      auditEntryID(now),
		Action:  action,
		Actor:   actor,
		Target:  auditTarget(action, subject),
		Outcome: auditOutcome(action),
		IP:      ip,
		Subject: subject,
		Detail:  detail,
	})
	if err != nil {
		slog.Error("append audit entry", "action", action, "err", err)
	}
}

func auditTarget(action, subject string) string {
	if subject != "" && action != "login" && action != "login.failed" && action != "logout" {
		return subject
	}
	switch action {
	case "config.patch":
		return "telemt.toml"
	case "telemt.reload", "telemt.restart":
		return "telemt"
	case "update.auto_change":
		return "auto_update"
	default:
		return "panel"
	}
}

func auditOutcome(action string) string {
	if action == "login.failed" {
		return "rejected"
	}
	if action == "telemt.reload" || action == "telemt.restart" || action == "update.apply" || action == "web.sessions.close" {
		return "accepted"
	}
	return "success"
}

func auditEntryID(ts time.Time) string {
	return "audit_" + strconv.FormatInt(ts.UnixNano(), 36)
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
