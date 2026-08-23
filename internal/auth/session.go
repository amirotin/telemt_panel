package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"

	"github.com/amirotin/telemt_panel/internal/config"
)

// CookieName is the panel's session cookie.
const CookieName = "panel_session"

// tokenBytes is the amount of entropy in an opaque session token before
// base64url encoding.
const tokenBytes = 32

// NewToken generates a fresh opaque session token: 32 crypto/rand bytes,
// base64url-encoded without padding. This is the value stored in the
// cookie; the store only ever sees HashToken(token).
func NewToken() (string, error) {
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// HashToken returns the hex SHA-256 of a session token, the form persisted
// as store.Session.IDHash — reading the store never yields a usable token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// cookiePath returns the session cookie's Path: basePath+"/", or "/" when
// there is no base path.
func cookiePath(basePath string) string {
	if basePath == "" {
		return "/"
	}
	return basePath + "/"
}

// SetSessionCookie sets the panel_session cookie carrying token.
func SetSessionCookie(w http.ResponseWriter, r *http.Request, cfg *config.Config, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     cookiePath(cfg.BasePath),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   RequestIsSecure(r, cfg.TrustedProxyPrefixes),
		MaxAge:   int(cfg.Auth.SessionTTLDuration().Seconds()),
	})
}

// ClearSessionCookie expires the panel_session cookie client-side. Callers
// must also delete the session server-side (store.DeleteSession) — clearing
// the cookie alone does not revoke it.
func ClearSessionCookie(w http.ResponseWriter, r *http.Request, cfg *config.Config) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     cookiePath(cfg.BasePath),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   RequestIsSecure(r, cfg.TrustedProxyPrefixes),
		MaxAge:   -1,
	})
}
