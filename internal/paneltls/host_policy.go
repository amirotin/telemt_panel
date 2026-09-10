package paneltls

import (
	"context"
	"net"
	"strings"

	"golang.org/x/crypto/acme/autocert"
)

// acmeHostPolicy accepts the configured DNS host, including an explicit HTTP-01
// port. autocert passes the raw HTTP Host header to HostPolicy, unlike SNI.
func acmeHostPolicy(domain string) autocert.HostPolicy {
	allowed := autocert.HostWhitelist(strings.ToLower(strings.TrimSuffix(domain, ".")))
	return func(ctx context.Context, host string) error {
		if name, port, err := net.SplitHostPort(host); err == nil && port == "80" && !strings.HasPrefix(host, "[") {
			host = name
		}
		return allowed(ctx, strings.ToLower(strings.TrimSuffix(host, ".")))
	}
}
