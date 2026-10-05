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

// SessionExpired reports whether a session last seen age ago has exceeded
// ttl — the one expiry rule RequireSession and the sessions list
// (httpapi's handleListSessions) both apply, factored here so the two
// can't drift out of sync.
func SessionExpired(age, ttl time.Duration) bool {
	return age > ttl
}

// RequireSession returns middleware that rejects requests without a valid,
// unexpired session. On success it slides the session's TTL (Touch),
// re-issues the session cookie with a fresh MaxAge on each request — without
// this, the browser would stop sending the cookie after the MaxAge set at
// login regardless of how active the admin was — and makes the admin's
// username and the session's store key available via UsernameFromContext /
// SessionIDHashFromContext.
func RequireSession(st store.StateStore, cfg *config.Config, guards ...*SessionGuard) func(http.Handler) http.Handler {
	guard := NewSessionGuard(st, func() time.Duration { return cfg.Auth.SessionTTLDuration() }, time.Now)
	if len(guards) > 0 {
		guard = guards[0]
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if cfg.Auth.Disabled {
				if !anonymousHostAllowed(r, cfg) {
					WriteError(w, http.StatusForbidden, "forbidden", "authentication is disabled; use an IP address or the domain configured in public_url")
					return
				}
				ctx := context.WithValue(r.Context(), ctxUsername, "anonymous")
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			cookie, err := r.Cookie(CookieName)
			if err != nil || cookie.Value == "" {
				writeSessionExpired(w)
				return
			}

			idHash := HashToken(cookie.Value)
			if err := guard.Check(idHash); err != nil {
				writeSessionExpired(w)
				return
			}

			now := time.Now()
			_ = st.TouchSession(idHash, now)
			SetSessionCookie(w, r, cfg, cookie.Value)

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
// or "none" (the latter is a browser sending a top-level, user-initiated
// navigation with no initiating origin, e.g. typing the URL directly —
// still same-site by definition, just not cross-site); otherwise the
// Origin header's host must match the request host. A non-browser client
// like curl sends neither Sec-Fetch-Site nor Origin, so it falls through
// to the Origin check and is rejected there (origin == "") — fail-closed
// by design, not something "none" was meant to cover. Never apply this to
// /sub/* (no cookie, no mutations there) or to /api/auth/login (protected
// by its own checks).
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
	case "same-site", "cross-site":
		if cfg.Auth.Disabled {
			return false
		}
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
	if cfg.Auth.Disabled {
		scheme := "http"
		if RequestIsSecure(r, cfg.TrustedProxyPrefixes) {
			scheme = "https"
		}
		if u.Scheme != scheme || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return false
		}
	}
	return strings.EqualFold(u.Host, reqHost)
}
