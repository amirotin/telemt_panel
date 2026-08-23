// Package auth implements password login, opaque browser sessions, the CSRF
// and session middleware, and the login rate limiter. Passkeys and TOTP
// (spec 05-auth.md) are later milestones; this package covers the password
// path only.
package auth

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// addrInPrefixes reports whether addr belongs to any of the prefixes.
func addrInPrefixes(addr netip.Addr, prefixes []netip.Prefix) bool {
	for _, p := range prefixes {
		if p.Contains(addr.Unmap()) {
			return true
		}
	}
	return false
}

// peerAddr parses the direct TCP peer address from r.RemoteAddr. The bool
// is false when RemoteAddr is missing or not a valid address (e.g. in unit
// tests that set it to a bare string).
func peerAddr(r *http.Request) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.Unmap(), true
}

// PeerTrusted reports whether the direct TCP peer of r is one of the
// configured trusted reverse proxies.
func PeerTrusted(r *http.Request, trusted []netip.Prefix) bool {
	if len(trusted) == 0 {
		return false
	}
	peer, ok := peerAddr(r)
	if !ok {
		return false
	}
	return addrInPrefixes(peer, trusted)
}

// ClientIP returns the client address for rate limiting and audit logging.
// X-Forwarded-For is honored only when the direct peer is a trusted proxy;
// the rightmost entry not belonging to a trusted proxy wins, so clients
// cannot spoof their way past per-IP limits by injecting the header.
func ClientIP(r *http.Request, trusted []netip.Prefix) string {
	peer, ok := peerAddr(r)
	if !ok {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		return host
	}

	if !PeerTrusted(r, trusted) {
		return peer.String()
	}

	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		parts := strings.Split(fwd, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			addr, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
			if err != nil {
				break
			}
			addr = addr.Unmap()
			if !addrInPrefixes(addr, trusted) {
				return addr.String()
			}
		}
	}
	return peer.String()
}

// RequestIsSecure reports whether the request arrived over HTTPS, either
// directly or via a trusted TLS-terminating reverse proxy.
func RequestIsSecure(r *http.Request, trusted []netip.Prefix) bool {
	if r.TLS != nil {
		return true
	}
	if !PeerTrusted(r, trusted) {
		return false
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
