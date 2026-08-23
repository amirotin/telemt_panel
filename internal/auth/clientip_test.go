package auth

import (
	"net/http"
	"net/netip"
	"testing"
)

func mustPrefixes(t *testing.T, cidrs ...string) []netip.Prefix {
	t.Helper()
	var out []netip.Prefix
	for _, c := range cidrs {
		out = append(out, netip.MustParsePrefix(c))
	}
	return out
}

func newReq(remoteAddr, xff string) *http.Request {
	r := &http.Request{RemoteAddr: remoteAddr, Header: http.Header{}}
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	return r
}

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}

	tests := []struct {
		name    string
		remote  string
		xff     string
		trusted []netip.Prefix
		want    string
	}{
		{"direct ipv4", "1.2.3.4:5555", "", nil, "1.2.3.4"},
		{"direct ipv6", "[2001:db8::1]:5555", "", nil, "2001:db8::1"},
		{"xff ignored without trusted proxies", "1.2.3.4:5555", "9.9.9.9", nil, "1.2.3.4"},
		{"xff ignored from untrusted peer", "1.2.3.4:5555", "9.9.9.9", trusted, "1.2.3.4"},
		{"xff honored from trusted proxy", "10.0.0.1:5555", "9.9.9.9", trusted, "9.9.9.9"},
		{"rightmost untrusted wins", "10.0.0.1:5555", "6.6.6.6, 9.9.9.9, 10.0.0.2", trusted, "9.9.9.9"},
		{"garbage xff falls back to peer", "10.0.0.1:5555", "not-an-ip", trusted, "10.0.0.1"},
		{"all-trusted xff falls back to peer", "10.0.0.1:5555", "10.0.0.3", trusted, "10.0.0.1"},
		{"ipv6 trusted proxy honors xff", "10.0.0.1:5555", "2001:db8::42", trusted, "2001:db8::42"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ClientIP(newReq(tt.remote, tt.xff), tt.trusted)
			if got != tt.want {
				t.Errorf("ClientIP() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRequestIsSecure(t *testing.T) {
	trusted := mustPrefixes(t, "127.0.0.1/32")

	r := newReq("127.0.0.1:9000", "")
	r.Header.Set("X-Forwarded-Proto", "https")
	if !RequestIsSecure(r, trusted) {
		t.Error("expected secure for https forwarded from trusted proxy")
	}

	r2 := newReq("8.8.8.8:9000", "")
	r2.Header.Set("X-Forwarded-Proto", "https")
	if RequestIsSecure(r2, trusted) {
		t.Error("untrusted peer must not mark request secure via header")
	}

	r3 := newReq("127.0.0.1:9000", "")
	if RequestIsSecure(r3, trusted) {
		t.Error("no forwarded proto -> not secure")
	}
}

func TestPeerTrusted(t *testing.T) {
	trusted := mustPrefixes(t, "10.0.0.0/8")

	if PeerTrusted(newReq("1.2.3.4:1", ""), trusted) {
		t.Error("untrusted peer reported trusted")
	}
	if !PeerTrusted(newReq("10.0.0.1:1", ""), trusted) {
		t.Error("trusted peer reported untrusted")
	}
	if PeerTrusted(newReq("10.0.0.1:1", ""), nil) {
		t.Error("empty trust list must never trust")
	}
}
