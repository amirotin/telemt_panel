package config

import (
	"fmt"
	"net"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"
)

// TLSConfig controls the panel's own listener, not Telemt's TLS masking.
type TLSConfig struct {
	Mode         string `toml:"mode" json:"mode"`
	CertFile     string `toml:"cert_file" json:"cert_file,omitempty"`
	KeyFile      string `toml:"key_file" json:"key_file,omitempty"`
	AcmeDomain   string `toml:"acme_domain" json:"acme_domain,omitempty"`
	AcmeCacheDir string `toml:"acme_cache_dir" json:"acme_cache_dir,omitempty"`
}

// Normalize validates transport without opening files, listeners or CA connections.
// An omitted mode accepts the TLS keys used by 0.6.2; no keys means plain HTTP.
func (c *TLSConfig) Normalize(listen, dataDir string) error {
	if c.Mode == "" {
		switch {
		case c.AcmeDomain != "":
			c.Mode = "acme"
		case c.CertFile != "" || c.KeyFile != "":
			c.Mode = "certificate"
		default:
			c.Mode = "http"
		}
	}
	switch c.Mode {
	case "http":
		if c.CertFile != "" || c.KeyFile != "" || c.AcmeDomain != "" || c.AcmeCacheDir != "" {
			return fmt.Errorf("tls.mode=http: remove TLS certificate/ACME settings to explicitly disable HTTPS")
		}
		return nil
	case "certificate":
		if c.CertFile == "" || c.KeyFile == "" {
			return fmt.Errorf("tls: cert_file and key_file must both be set")
		}
		if c.AcmeDomain != "" || c.AcmeCacheDir != "" {
			return fmt.Errorf("tls: certificate files and ACME settings are mutually exclusive")
		}
	case "acme":
		if c.CertFile != "" || c.KeyFile != "" {
			return fmt.Errorf("tls: certificate files and ACME settings are mutually exclusive")
		}
		c.AcmeDomain = strings.ToLower(strings.TrimSuffix(c.AcmeDomain, "."))
		if !validACMEDomain(c.AcmeDomain) {
			return fmt.Errorf("tls.acme_domain: use one DNS domain (ASCII or punycode), without a scheme, port or wildcard")
		}
		if c.AcmeCacheDir == "" {
			if dataDir == "" {
				return fmt.Errorf("tls.acme_cache_dir is required when data_dir is empty; ACME credentials must persist")
			}
			c.AcmeCacheDir = filepath.Join(dataDir, "certs")
		}
	default:
		return fmt.Errorf("tls.mode: unknown value (http | certificate | acme)")
	}
	_, port, err := net.SplitHostPort(listen)
	n, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || n < 1 || n > 65535 {
		return fmt.Errorf("listen: HTTPS requires host:port with a port between 1 and 65535")
	}
	if c.Mode == "acme" && n == 80 {
		return fmt.Errorf("listen: ACME reserves port 80 for HTTP-01; use a different HTTPS port, such as 8443")
	}
	return nil
}

func validACMEDomain(domain string) bool {
	if len(domain) > 253 || !strings.Contains(domain, ".") {
		return false
	}
	if _, err := netip.ParseAddr(domain); err == nil {
		return false
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
				return false
			}
		}
	}
	return true
}
