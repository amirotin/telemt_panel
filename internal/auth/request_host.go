package auth

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// RequestHost resolves one validated authority, honoring forwarded host only
// from a trusted peer. It never selects a listener's scheme or port.
func RequestHost(r *http.Request, trusted []netip.Prefix) (string, error) {
	host := r.Host
	if PeerTrusted(r, trusted) {
		values := r.Header.Values("X-Forwarded-Host")
		if len(values) > 0 {
			if len(values) != 1 {
				return "", errors.New("ambiguous forwarded host")
			}
			host = values[0]
		}
	}
	return validatedHost(host)
}

func validatedHost(host string) (string, error) {
	invalid := errors.New("invalid request host")
	if host == "" || strings.ContainsAny(host, " \t\r\n,@/\\?#") {
		return "", invalid
	}
	u, err := url.Parse("http://" + host)
	if err != nil || u.Host != host || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", invalid
	}
	name := strings.ToLower(u.Hostname())
	if name == "" {
		return "", invalid
	}
	ip, ipErr := netip.ParseAddr(name)
	if strings.HasPrefix(host, "[") {
		if ipErr != nil || !ip.Is6() || ip.Zone() != "" {
			return "", invalid
		}
		name = ip.String()
	} else if strings.Contains(name, ":") {
		return "", invalid
	} else if ipErr == nil {
		name = ip.String()
	} else {
		if len(name) > 254 {
			return "", invalid
		}
		for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return "", invalid
			}
			for _, c := range label {
				if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
					return "", invalid
				}
			}
		}
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 0 || n > 65535 {
			return "", invalid
		}
		return net.JoinHostPort(name, strconv.Itoa(n)), nil
	}
	if strings.HasSuffix(host, ":") {
		return "", invalid
	}
	if ipErr == nil && ip.Is6() {
		return "[" + name + "]", nil
	}
	return name, nil
}
