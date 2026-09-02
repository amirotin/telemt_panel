package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/subpage"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// subpageRequestTimeout bounds the Telemt round trip for both the public
// /sub/{token} view and the admin sublink endpoints.
const subpageRequestTimeout = 10 * time.Second

// handleSubpage implements GET /sub/{token}: the token-addressed, no-login
// per-user subscription page. Every failure path (bad token, unknown
// user, stale token, upstream error) below returns the uniform 404 text
// body — the page must never distinguish "wrong token" from "right token,
// backend hiccup" for an unauthenticated caller.
func (s *Server) handleSubpage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	username, ok := s.subIndex.Lookup(ctx, token)
	if !ok {
		writeSubpageNotFound(w)
		return
	}

	users, err := s.tc.Users(ctx)
	if err != nil {
		slog.Error("subpage: fetch users", "err", err)
		writeSubpageNotFound(w)
		return
	}
	u, ok := findUser(users, username)
	if !ok {
		writeSubpageNotFound(w)
		return
	}

	// Re-verify the token against the user's CURRENT secret and nonce
	// rather than trusting the index hit: the index is refreshed lazily
	// and best-effort, so an entry can still be cached after a secret or
	// nonce rotation that should have revoked it. This check, not the
	// index, is what makes revocation deterministic — a mismatch triggers
	// a throttled refresh so the stale entry ages out, then 404s exactly
	// like an unknown token. The stale-hit 404 does more work (Users fetch
	// + HMAC) than the unknown-token 404 — an accepted timing asymmetry:
	// reaching this path requires presenting a complete previously-valid
	// token, so the timing reveals nothing the caller does not already know.
	secret, ok := subpage.ExtractSecret(u.Links)
	if !ok {
		s.subIndex.TriggerRefresh(ctx)
		writeSubpageNotFound(w)
		return
	}
	valid, err := s.subSvc.Verify(username, secret, token)
	if err != nil {
		slog.Error("subpage: verify token", "username", username, "err", err)
		writeSubpageNotFound(w)
		return
	}
	if !valid {
		s.subIndex.TriggerRefresh(ctx)
		writeSubpageNotFound(w)
		return
	}

	// hasQuota degrades gracefully (older Telemt builds, or a hiccup
	// fetching the list) — same helper the users handlers use. entry is
	// nil unless u specifically has one, which RenderPage then falls back
	// on u.TotalOctets for.
	quota, hasQuota := s.quotaListOrDegrade(ctx)
	var entry *telemt.QuotaEntry
	if hasQuota {
		if q, ok := quota[username]; ok {
			entry = &q
		}
	}

	// Render into a buffer first so a render failure can still surface as
	// a real error status: writing 200 before rendering (the previous
	// behavior) means a failure partway through leaves the client with a
	// 200 and a truncated or empty body instead of a clear error.
	var buf bytes.Buffer
	if err := subpage.RenderPage(&buf, u, entry, r.Header.Get("Accept-Language"), time.Now()); err != nil {
		slog.Error("subpage: render", "username", username, "err", err)
		writeSubpageRenderError(w)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	w.Write(buf.Bytes())
}

// writeSubpageNotFound writes the uniform, detail-free 404 the spec
// requires for any invalid or unknown /sub/* token — no distinction
// between "malformed", "unknown" and "revoked", and never a redirect back
// to the panel (which would reveal the panel exists).
func writeSubpageNotFound(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	io.WriteString(w, "not found")
}

// writeSubpageRenderError writes a plain 500 for a page render failure —
// unlike writeSubpageNotFound, this is a real backend error rather than a
// deliberately uniform response, but it still carries no detail to an
// unauthenticated caller.
func writeSubpageRenderError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusInternalServerError)
	io.WriteString(w, "internal error")
}

// subpageRateLimited wraps next with the 30 req/min per-client-IP limit
// on /sub/*, reusing the same trusted-proxy IP resolution as the rest of
// the panel.
func (s *Server) subpageRateLimited(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := auth.ClientIP(r, s.cfg.TrustedProxyPrefixes)
		if !s.subLimiter.Allow(ip) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusTooManyRequests)
			io.WriteString(w, "too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sublinkResponse mirrors api/openapi.yaml schema Sublink.
type sublinkResponse struct {
	URL     string `json:"url"`
	Enabled bool   `json:"enabled"`
}

// handleGetSublink implements GET /api/users/{username}/sublink.
func (s *Server) handleGetSublink(w http.ResponseWriter, r *http.Request) {
	s.writeSublink(w, r, false)
}

// handlePostSublink implements POST /api/users/{username}/sublink:
// rotates the user's subpage nonce, immediately revoking the previous URL.
func (s *Server) handlePostSublink(w http.ResponseWriter, r *http.Request) {
	s.writeSublink(w, r, true)
}

// writeSublink is the shared body of both sublink endpoints; rotate
// selects the POST (regenerate) behavior.
func (s *Server) writeSublink(w http.ResponseWriter, r *http.Request, rotate bool) {
	username := r.PathValue("username")

	ctx, cancel := context.WithTimeout(r.Context(), subpageRequestTimeout)
	defer cancel()

	users, err := s.tc.Users(ctx)
	if err != nil {
		slog.Error("sublink: fetch users", "err", err)
		auth.WriteError(w, http.StatusBadGateway, "telemt_unreachable", "could not reach telemt")
		return
	}
	u, ok := findUser(users, username)
	if !ok {
		auth.WriteError(w, http.StatusNotFound, "not_found", "user not found")
		return
	}
	secret, ok := subpage.ExtractSecret(u.Links)
	if !ok {
		auth.WriteError(w, http.StatusConflict, "sublink_unavailable", "user has no classic or secure link to derive a subpage link from")
		return
	}

	if rotate {
		nonce, err := randomNonce()
		if err != nil {
			slog.Error("sublink: generate nonce", "err", err)
			auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not rotate link")
			return
		}
		if err := s.st.SetSubpageNonce(username, nonce); err != nil {
			slog.Error("sublink: set nonce", "username", username, "err", err)
			auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not rotate link")
			return
		}
		// Force an immediate index rebuild so the old token stops
		// resolving right away, rather than waiting out the lazy
		// refresh's throttle window. Best-effort: a failed refresh here
		// just means the old token keeps working until the next lazy
		// refresh catches up — not a reason to fail the rotation, since
		// the nonce itself is already durably rotated in the store.
		if err := s.subIndex.Refresh(ctx); err != nil {
			slog.Warn("sublink: index refresh after rotate", "username", username, "err", err)
		}
		s.appendAudit(r, "sublink.rotate", username, "")
	}

	path, err := s.subSvc.URL(username, secret)
	if err != nil {
		slog.Error("sublink: build url", "username", username, "err", err)
		auth.WriteError(w, http.StatusInternalServerError, "internal_error", "could not build link")
		return
	}

	writeJSON(w, http.StatusOK, sublinkResponse{
		URL:     absoluteURL(r, s.cfg, path),
		Enabled: s.cfg.Subpage.Enabled,
	})
}

// randomNonce generates the subpage nonce. The value only feeds the token
// HMAC as an opaque revocation salt, so its format is free: rand.Text's
// ~128-bit base32 token matches the old 16-byte hex nonce in entropy.
func randomNonce() (string, error) {
	return rand.Text(), nil
}

// findUser returns the user named username from users, if present.
func findUser(users []telemt.UserInfo, username string) (telemt.UserInfo, bool) {
	for _, u := range users {
		if u.Username == username {
			return u, true
		}
	}
	return telemt.UserInfo{}, false
}

// absoluteURL builds the externally visible absolute URL for a
// base-path-relative path, using the same trusted-proxy X-Forwarded-Host
// handling as auth.CSRF's Origin check.
func absoluteURL(r *http.Request, cfg *config.Config, path string) string {
	scheme := "http"
	if auth.RequestIsSecure(r, cfg.TrustedProxyPrefixes) {
		scheme = "https"
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" && auth.PeerTrusted(r, cfg.TrustedProxyPrefixes) {
		host = fwd
	}
	return scheme + "://" + host + path
}
