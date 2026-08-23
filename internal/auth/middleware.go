package auth

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/store"
)

// RequireSession returns middleware that rejects requests without a valid,
// unexpired session. On success it slides the session's TTL (Touch) and
// makes the admin's username and the session's store key available via
// UsernameFromContext / SessionIDHashFromContext.
func RequireSession(st store.Store, cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(CookieName)
			if err != nil || cookie.Value == "" {
				writeSessionExpired(w)
				return
			}

			idHash := HashToken(cookie.Value)
			sess, ok, err := st.GetSession(idHash)
			if err != nil || !ok {
				writeSessionExpired(w)
				return
			}

			now := time.Now()
			if now.Sub(sess.LastSeen) > cfg.Auth.SessionTTLDuration() {
				_ = st.DeleteSession(idHash)
				writeSessionExpired(w)
				return
			}
			_ = st.TouchSession(idHash, now)

			ctx := context.WithValue(r.Context(), ctxUsername, cfg.Auth.Username)
			ctx = context.WithValue(ctx, ctxSessionIDHash, idHash)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeSessionExpired(w http.ResponseWriter) {
	WriteError(w, http.StatusUnauthorized, "session_expired", "no valid session")
}

// mutatingMethods are the HTTP methods CSRF checks apply to; GET/HEAD/
// OPTIONS never mutate state so they pass through untouched.
var mutatingMethods = map[string]bool{
	http.MethodPost:   true,
	http.MethodPut:    true,
	http.MethodPatch:  true,
	http.MethodDelete: true,
}

// CSRF returns middleware that rejects cross-site mutating requests. A
// request is same-site (and allowed) when Sec-Fetch-Site is "same-origin"
// or "none" (the latter covers direct navigation/non-browser clients that
// send no Origin at all, e.g. curl); otherwise the Origin header's host
// must match the request host. Never apply this to /sub/* (no cookie, no
// mutations there) or to /api/auth/login (protected by its own checks).
func CSRF(cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if mutatingMethods[r.Method] && !csrfAllowed(r, cfg) {
				WriteError(w, http.StatusForbidden, "csrf_rejected", "cross-site request rejected")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func csrfAllowed(r *http.Request, cfg *config.Config) bool {
	switch strings.ToLower(r.Header.Get("Sec-Fetch-Site")) {
	case "same-origin", "none":
		return true
	}

	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}

	reqHost := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" && PeerTrusted(r, cfg.TrustedProxyPrefixes) {
		reqHost = fwd
	}
	return strings.EqualFold(u.Host, reqHost)
}
