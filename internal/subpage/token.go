// Package subpage implements the token-addressed, no-login subscription
// page at /sub/{token} — a user's self-serve connection page — plus the
// admin-side link builder it shares with the users API (spec
// v2/specs/04-subpage.md).
package subpage

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"net/url"
	"strings"

	"github.com/amirotin/telemt_panel/internal/telemt"
)

// tokenDigestLen is how many bytes of the HMAC-SHA256 digest become the
// token (160 bits — brute force is infeasible even without rate limiting).
const tokenDigestLen = 20

// deriveToken computes the subpage token for one (username, userSecret,
// nonce) tuple: lowercase, unpadded base32 of the first tokenDigestLen
// bytes of HMAC-SHA256(secret, username || 0x00 || userSecret || 0x00 || nonce).
// Rotating either userSecret (Telemt secret rotation) or nonce (an
// explicit "regenerate link") changes the token, revoking the old one —
// there is nothing to separately invalidate.
func deriveToken(secret []byte, username, userSecret, nonce string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(username))
	mac.Write([]byte{0})
	mac.Write([]byte(userSecret))
	mac.Write([]byte{0})
	mac.Write([]byte(nonce))
	digest := mac.Sum(nil)[:tokenDigestLen]
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(digest))
}

// NonceProvider is the subset of store.Store the subpage package needs to
// read the per-user rotation nonce. Kept narrow so this package doesn't
// depend on the full store.Store interface.
type NonceProvider interface {
	// GetSubpageNonce returns the current subpage nonce for username, or
	// "" if none has been set.
	GetSubpageNonce(username string) (string, error)
}

// Service derives token-addressed subpage URLs for users. It is exported
// so the users API (a later milestone) can embed sub_url in its responses
// using nothing more than a UserInfo's links and this package's store
// dependency — it does not itself talk to Telemt.
type Service struct {
	secret   []byte
	basePath string
	nonces   NonceProvider
}

// NewService creates a Service. secret is the panel's subpage.secret
// (HMAC key); basePath is cfg.BasePath, prefixed onto every returned URL.
func NewService(secret, basePath string, nonces NonceProvider) *Service {
	return &Service{secret: []byte(secret), basePath: basePath, nonces: nonces}
}

// URL returns the base-path-relative subpage URL path for username, e.g.
// "/sub/<token>". userSecret is the user's current Telemt secret, as
// extracted from UserInfo.Links by ExtractSecret; the nonce is read fresh
// from the store on every call, so a "regenerate link" rotation is
// reflected immediately without any cache to invalidate.
func (s *Service) URL(username, userSecret string) (string, error) {
	nonce, err := s.nonces.GetSubpageNonce(username)
	if err != nil {
		return "", err
	}
	return s.basePath + "/sub/" + deriveToken(s.secret, username, userSecret, nonce), nil
}

// ExtractSecret returns the user's canonical 32-hex Telemt secret from
// their links, preferring the classic link (whose secret param carries it
// unprefixed) and falling back to the secure link (whose secret param is
// prefixed "dd"). The fake-TLS links carry an additional SNI-derived
// prefix and are not used here — spec 07-telemt-sdk.md's prefix table.
// The bool is false when neither link is present or parseable, which can
// happen for a user with no classic/secure links configured.
func ExtractSecret(links telemt.UserLinks) (string, bool) {
	if len(links.Classic) > 0 {
		if secret, ok := secretParam(links.Classic[0]); ok && isHex32(secret) {
			return secret, true
		}
	}
	if len(links.Secure) > 0 {
		if secret, ok := secretParam(links.Secure[0]); ok {
			secret = strings.TrimPrefix(strings.ToLower(secret), "dd")
			if isHex32(secret) {
				return secret, true
			}
		}
	}
	return "", false
}

// secretParam parses a tg://proxy?... or https://t.me/proxy?... link and
// returns its "secret" query parameter.
func secretParam(link string) (string, bool) {
	u, err := url.Parse(link)
	if err != nil {
		return "", false
	}
	secret := u.Query().Get("secret")
	return secret, secret != ""
}

// isHex32 reports whether s is exactly 32 lowercase hex characters (the
// raw, unprefixed Telemt user secret).
func isHex32(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
