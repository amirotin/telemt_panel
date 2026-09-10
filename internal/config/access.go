package config

import (
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

// NormalizeAccess validates independent panel and subscription endpoints.
func (c *Config) NormalizeAccess() error {
	if err := normalizePublicURL(&c.PublicURL, &c.BasePath, c.TLS); err != nil {
		return fmt.Errorf("panel address: %w", err)
	}
	if c.Subpage.Listen == "" {
		c.Subpage.Listen = "127.0.0.1:8081"
	}
	if c.Subpage.BasePath == "" {
		c.Subpage.BasePath = "/sub"
	}
	if c.Subpage.TLS.Mode == "" {
		c.Subpage.TLS.Mode = "http"
	}
	if !c.Subpage.Enabled {
		return nil
	}
	cache := ""
	if c.DataDir != "" {
		cache = filepath.Join(c.DataDir, "certs", "subscription")
	}
	if c.TLS.Mode == "acme" && c.Subpage.TLS.Mode == "acme" && strings.EqualFold(c.TLS.AcmeDomain, c.Subpage.TLS.AcmeDomain) {
		cache = c.TLS.AcmeCacheDir
	}
	candidate := TLSCandidate{Listen: c.Subpage.Listen, TLS: c.Subpage.TLS, BasePath: c.Subpage.BasePath, PublicURL: c.Subpage.PublicURL}
	if err := candidate.Normalize(cache); err != nil {
		return fmt.Errorf("subscription: %w", err)
	}
	if candidate.BasePath == "" {
		return fmt.Errorf("subscription base_path must be nonempty")
	}
	c.Subpage.TLS, c.Subpage.BasePath, c.Subpage.PublicURL = candidate.TLS, candidate.BasePath, candidate.PublicURL
	_, panelPort, _ := net.SplitHostPort(c.Listen)
	_, subPort, _ := net.SplitHostPort(c.Subpage.Listen)
	if panelPort == subPort {
		return fmt.Errorf("panel and subscription require different ports")
	}
	if (c.TLS.Mode == "acme" || c.Subpage.TLS.Mode == "acme") && (panelPort == "80" || subPort == "80") {
		return fmt.Errorf("ACME reserves port 80 for HTTP-01; choose different application ports")
	}
	if c.TLS.Mode == "acme" && c.Subpage.TLS.Mode == "acme" && c.TLS.AcmeDomain == c.Subpage.TLS.AcmeDomain && c.TLS.AcmeCacheDir != c.Subpage.TLS.AcmeCacheDir {
		return fmt.Errorf("ACME for the same domain must use the same certificate cache")
	}
	return nil
}

// normalizePublicURL accepts a complete base URL, storing its origin and path
// separately. Prefixes are matched by the application, never stripped by a proxy.
func normalizePublicURL(raw, base *string, transport TLSConfig) error {
	*base = strings.TrimRight(*base, "/")
	if *base != "" && !strings.HasPrefix(*base, "/") {
		*base = "/" + *base
	}
	if *raw != "" {
		u, err := url.Parse(*raw)
		if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" {
			return fmt.Errorf("public_url must be an HTTP(S) URL without credentials, query or fragment")
		}
		if strings.TrimRight(u.Path, "/") != "" {
			p := strings.TrimRight(u.Path, "/")
			if *base != "" && *base != p {
				return fmt.Errorf("public_url path must match base_path")
			}
			*base = p
		}
		if port := u.Port(); port != "" {
			n, err := strconv.Atoi(port)
			if err != nil || n < 1 || n > 65535 {
				return fmt.Errorf("public_url port must be between 1 and 65535")
			}
		}
		if transport.Mode != "" && transport.Mode != "http" && u.Scheme != "https" {
			return fmt.Errorf("public_url must use HTTPS for a TLS listener")
		}
		if transport.Mode == "acme" && !strings.EqualFold(u.Hostname(), transport.AcmeDomain) {
			return fmt.Errorf("public_url host must match acme_domain")
		}
		u.Path = ""
		*raw = u.String()
	}
	if *base != "" {
		for _, segment := range strings.Split(strings.TrimPrefix(*base, "/"), "/") {
			if segment == "" || segment == "." || segment == ".." {
				return fmt.Errorf("base_path must not contain empty or dot segments")
			}
		}
	}
	return validateBasePath(*base)
}
