// Package config loads and validates the panel's own configuration.
// Settings changed from the UI are persisted to the store, never back into
// this file — the operator's config is read-only for the panel.
package config

import (
	"fmt"
	"net/netip"
	"os"
	"regexp"
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

	// DataDir holds the panel's on-disk state mirror (sessions, subpage
	// nonces, settings). Empty disables the mirror — state stays in RAM
	// only.
	DataDir string `toml:"data_dir"`

	Telemt     TelemtConfig     `toml:"telemt"`
	Auth       AuthConfig       `toml:"auth"`
	Store      StoreConfig      `toml:"store"`
	Subpage    SubpageConfig    `toml:"subpage"`
	Host       HostConfig       `toml:"host"`
	Updates    UpdatesConfig    `toml:"updates"`
	Privileges PrivilegesConfig `toml:"privileges"`
}

// TelemtConfig points the panel at the Telemt API.
type TelemtConfig struct {
	URL        string `toml:"url"`
	AuthHeader string `toml:"auth_header"`
	// ConfigEditMode selects how GET/PATCH /api/telemt/config will edit
	// Telemt's own config once that milestone lands: "api" (default, PATCH
	// through the Telemt API) or "file" (direct file rewrite). Wire-only
	// for now — GET /api/telemt/info reports it, but no config-editing
	// endpoint reads it yet.
	ConfigEditMode string `toml:"config_edit_mode"`
}

// AuthConfig holds the password login; passkeys/TOTP state lives in the store.
type AuthConfig struct {
	Username     string `toml:"username"`
	PasswordHash string `toml:"password_hash"`
	SessionTTL   string `toml:"session_ttl"`
}

// SessionTTLDuration returns the parsed sliding session TTL (default 720h).
// Load already rejects a non-empty session_ttl that fails to parse or is
// <=0, so the fallback below is unreachable through a Config that passed
// Load — kept as a safety net for callers that build a Config by hand
// (e.g. tests) without going through Load.
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

// HostConfig describes the host the panel runs on, for the runtime-control
// and log-streaming features to detect or be told which init system, log
// source and service/container names to use.
type HostConfig struct {
	// ServiceManager selects how the panel controls services: auto (probe
	// at startup) | systemd | openrc | procd | sysvinit | docker | none.
	ServiceManager string `toml:"service_manager"`
	// LogSource selects where live logs are read from: auto (probe at
	// startup) | journald | logread | syslog | docker | file.
	LogSource string `toml:"log_source"`
	// LogFile is the path tailed when log_source is "file".
	LogFile         string `toml:"log_file"`
	TelemtService   string `toml:"telemt_service"`
	PanelService    string `toml:"panel_service"`
	TelemtContainer string `toml:"telemt_container"`
	// PanelContainer is the container name used for the panel's own
	// restart/log operations when service_manager (or log_source) is
	// docker — mirrors TelemtContainer. Without this, a dockerized panel
	// would resolve to PanelService (a systemd-style unit name) even
	// under the docker manager, which doesn't mean anything to `docker
	// restart`/`docker logs`.
	PanelContainer string `toml:"panel_container"`
}

// UpdatesConfig points the panel's self-update and Telemt-update flows at
// their GitHub releases and installed binary locations.
type UpdatesConfig struct {
	TelemtRepo       string `toml:"telemt_repo"`
	PanelRepo        string `toml:"panel_repo"`
	GithubToken      string `toml:"github_token"`
	TelemtBinaryPath string `toml:"telemt_binary_path"`
	PanelBinaryPath  string `toml:"panel_binary_path"`
}

// PrivilegesConfig selects how the panel executes the five privileged
// host operations (installing/restoring a binary, restarting a service,
// tailing a journal, rewriting a config file): in-process (the panel
// already runs as root), narrow non-interactive sudo, or manually. See
// v2/specs/01-host-matrix.md §Привилегии.
type PrivilegesConfig struct {
	// Mode: "auto" (default) picks direct when the panel's effective
	// UID is 0, otherwise a complete sudo policy, otherwise manual mode.
	// "sudo", "direct" and "manual" force that path outright
	// (see host.SelectRunner's doc comment for exact fallback behavior).
	Mode string `toml:"mode"`
}

// Load reads, validates and normalizes the config file.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{
		Listen:  "0.0.0.0:8080",
		Store:   StoreConfig{Driver: "memory"},
		DataDir: "/var/lib/telemt-panel",
		Telemt:  TelemtConfig{ConfigEditMode: "api"},
		Host: HostConfig{
			ServiceManager:  "auto",
			LogSource:       "auto",
			TelemtService:   "telemt",
			PanelService:    "telemt-panel",
			TelemtContainer: "telemt",
			PanelContainer:  "telemt-panel",
		},
		Updates: UpdatesConfig{
			TelemtRepo:       "telemt/telemt",
			PanelRepo:        "amirotin/telemt_panel",
			TelemtBinaryPath: "/bin/telemt",
			PanelBinaryPath:  "/usr/local/bin/telemt-panel",
		},
		Privileges: PrivilegesConfig{Mode: "auto"},
	}
	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if cfg.Telemt.URL == "" {
		return nil, fmt.Errorf("telemt.url is required")
	}
	switch cfg.Telemt.ConfigEditMode {
	case "":
		cfg.Telemt.ConfigEditMode = "api"
	case "api", "file":
	default:
		return nil, fmt.Errorf("telemt.config_edit_mode: unknown value %q (api | file)", cfg.Telemt.ConfigEditMode)
	}
	if cfg.Auth.Username == "" {
		return nil, fmt.Errorf("auth.username is required")
	}
	if cfg.Auth.PasswordHash == "" {
		return nil, fmt.Errorf("auth.password_hash is required")
	}
	if cfg.Auth.SessionTTL != "" {
		d, err := time.ParseDuration(cfg.Auth.SessionTTL)
		if err != nil {
			return nil, fmt.Errorf("auth.session_ttl: invalid duration %q: %w", cfg.Auth.SessionTTL, err)
		}
		if d <= 0 {
			return nil, fmt.Errorf("auth.session_ttl: must be positive, got %q", cfg.Auth.SessionTTL)
		}
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

	switch cfg.Host.ServiceManager {
	case "":
		cfg.Host.ServiceManager = "auto"
	case "auto", "systemd", "openrc", "procd", "sysvinit", "docker", "none":
	default:
		return nil, fmt.Errorf("host.service_manager: unknown value %q (auto | systemd | openrc | procd | sysvinit | docker | none)", cfg.Host.ServiceManager)
	}

	switch cfg.Host.LogSource {
	case "":
		cfg.Host.LogSource = "auto"
	case "auto", "journald", "logread", "syslog", "docker", "file":
	default:
		return nil, fmt.Errorf("host.log_source: unknown value %q (auto | journald | logread | syslog | docker | file)", cfg.Host.LogSource)
	}

	switch cfg.Privileges.Mode {
	case "":
		cfg.Privileges.Mode = "auto"
	case "auto", "sudo", "direct", "manual":
	default:
		return nil, fmt.Errorf("privileges.mode: unknown value %q (auto | sudo | direct | manual)", cfg.Privileges.Mode)
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
	if err := validateBasePath(cfg.BasePath); err != nil {
		return nil, err
	}

	cfg.Path = path
	return cfg, nil
}

// basePathAllowedRE is the character whitelist validateBasePath enforces:
// letters, digits, and the small set of characters RFC 3986 allows
// unencoded in a URL path segment without requiring percent-encoding
// (".", "_", "~", "-"), plus "/" as the segment separator.
var basePathAllowedRE = regexp.MustCompile(`^[A-Za-z0-9._~/-]*$`)

// validateBasePath enforces base_path's shape after Load's own
// normalization above (trailing slash trimmed, leading slash added):
// empty, or a leading-slash / no-trailing-slash path built only from
// basePathAllowedRE's character set.
//
// This is the real defense behind internal/webui's <base href> and
// window.__BASE_PATH__ injection into every served page: base_path is
// operator-controlled config, not user input, but a misconfigured or
// compromised value (e.g. containing '"', '<', '>') must never be able to
// break out of that HTML/JS context. Rejecting it here, at load, is
// simpler to reason about than any amount of escaping downstream — though
// internal/webui.patchIndex also escapes defensively, belt-and-braces.
func validateBasePath(p string) error {
	if p == "" {
		return nil
	}
	if !strings.HasPrefix(p, "/") {
		return fmt.Errorf("base_path: %q must start with \"/\"", p)
	}
	if !basePathAllowedRE.MatchString(p) {
		return fmt.Errorf("base_path: %q contains characters outside [A-Za-z0-9._~/-]", p)
	}
	return nil
}
