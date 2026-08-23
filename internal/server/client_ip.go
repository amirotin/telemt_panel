package server

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

// clientIP returns the client address for rate limiting.
// X-Forwarded-For is honored only when the direct peer is a trusted proxy;
// the rightmost entry not belonging to a trusted proxy wins, so clients
// cannot spoof their way past per-IP limits by injecting the header.
func clientIP(r *http.Request, trusted []netip.Prefix) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	peer = peer.Unmap()

	if len(trusted) == 0 || !addrInPrefixes(peer, trusted) {
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

// requestIsSecure reports whether the request arrived over HTTPS, either
// directly or via a trusted TLS-terminating reverse proxy.
func requestIsSecure(r *http.Request, trusted []netip.Prefix) bool {
	if r.TLS != nil {
		return true
	}
	if len(trusted) == 0 {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	if !addrInPrefixes(peer.Unmap(), trusted) {
		return false
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}
