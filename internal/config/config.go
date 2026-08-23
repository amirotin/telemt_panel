// Package config loads and validates the panel's own configuration.
// Settings changed from the UI are persisted to the store, never back into
// this file — the operator's config is read-only for the panel.
package config

import (
	"fmt"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the panel's own configuration (config.toml).
type Config struct {
	Path     string `toml:"-"` // file path, set after loading
	Listen   string `toml:"listen"`
	BasePath string `toml:"base_path"`
	// TrustedProxies lists CIDRs (or bare IPs) of reverse proxies whose
	// X-Forwarded-* headers are trusted. Empty means headers are ignored.
	TrustedProxies       []string       `toml:"trusted_proxies"`
	TrustedProxyPrefixes []netip.Prefix `toml:"-"`

	Telemt  TelemtConfig  `toml:"telemt"`
	Auth    AuthConfig    `toml:"auth"`
	Store   StoreConfig   `toml:"store"`
	Subpage SubpageConfig `toml:"subpage"`
}

// TelemtConfig points the panel at the Telemt API.
type TelemtConfig struct {
	URL        string `toml:"url"`
	AuthHeader string `toml:"auth_header"`
}

// AuthConfig holds the password login; passkeys/TOTP state lives in the store.
type AuthConfig struct {
	Username     string `toml:"username"`
	PasswordHash string `toml:"password_hash"`
	SessionTTL   string `toml:"session_ttl"`
}

// SessionTTLDuration returns the parsed sliding session TTL (default 720h).
func (a AuthConfig) SessionTTLDuration() time.Duration {
	if a.SessionTTL == "" {
		return 720 * time.Hour
	}
	d, err := time.ParseDuration(a.SessionTTL)
	if err != nil || d <= 0 {
		return 720 * time.Hour
	}
	return d
}

// StoreConfig selects the state backend: in-memory rings (router profile,
// zero flash writes) or SQLite (vps profile, metric history).
type StoreConfig struct {
	Driver string `toml:"driver"` // "memory" (default) | "sqlite"
	Path   string `toml:"path"`
}

// SubpageConfig controls the per-user subscription page.
type SubpageConfig struct {
	Enabled bool   `toml:"enabled"`
	Secret  string `toml:"secret"`
}

// Load reads, validates and normalizes the config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{
		Listen: "0.0.0.0:8080",
		Store:  StoreConfig{Driver: "memory"},
	}
	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if cfg.Telemt.URL == "" {
		return nil, fmt.Errorf("telemt.url is required")
	}
	if cfg.Auth.Username == "" {
		return nil, fmt.Errorf("auth.username is required")
	}
	if cfg.Auth.PasswordHash == "" {
		return nil, fmt.Errorf("auth.password_hash is required")
	}

	switch cfg.Store.Driver {
	case "", "memory":
		cfg.Store.Driver = "memory"
	case "sqlite":
		if cfg.Store.Path == "" {
			return nil, fmt.Errorf("store.path is required for the sqlite driver")
		}
	default:
		return nil, fmt.Errorf("store.driver: unknown driver %q (memory | sqlite)", cfg.Store.Driver)
	}

	if cfg.Subpage.Enabled && cfg.Subpage.Secret == "" {
		return nil, fmt.Errorf("subpage.secret is required when the subscription page is enabled")
	}

	for _, entry := range cfg.TrustedProxies {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(entry)
		if err != nil {
			addr, addrErr := netip.ParseAddr(entry)
			if addrErr != nil {
				return nil, fmt.Errorf("trusted_proxies: invalid CIDR or IP %q", entry)
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		cfg.TrustedProxyPrefixes = append(cfg.TrustedProxyPrefixes, prefix)
	}

	cfg.BasePath = strings.TrimRight(cfg.BasePath, "/")
	if cfg.BasePath != "" && !strings.HasPrefix(cfg.BasePath, "/") {
		cfg.BasePath = "/" + cfg.BasePath
	}

	cfg.Path = path
	return cfg, nil
}
