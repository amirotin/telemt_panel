package auth

import (
	"net/http"
	"net/netip"
	"net/url"
	"strings"

	"github.com/amirotin/telemt_panel/internal/config"
)

// anonymousHostAllowed prevents a foreign DNS name rebound to the panel's
// private address from exposing its unauthenticated API. Custom domains must
// be explicitly configured; direct IP access needs no extra configuration.
func anonymousHostAllowed(r *http.Request, cfg *config.Config) bool {
	host, err := RequestHost(r, cfg.TrustedProxyPrefixes)
	if err != nil {
		return false
	}
	u, err := url.Parse("http://" + host)
	if err != nil || u.Host != host || u.User != nil || u.Hostname() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if cfg.PublicURL != "" {
		public, err := url.Parse(cfg.PublicURL)
		if err != nil {
			return false
		}
		public.Host, err = validatedHost(public.Host)
		if err != nil || !strings.EqualFold(u.Hostname(), public.Hostname()) {
			return false
		}
		port := func(v *url.URL) string {
			if v.Port() != "" {
				return v.Port()
			}
			if public.Scheme == "https" {
				return "443"
			}
			return "80"
		}
		return port(u) == port(public)
	}
	if strings.EqualFold(u.Hostname(), "localhost") {
		return true
	}
	_, err = netip.ParseAddr(u.Hostname())
	return err == nil
}
