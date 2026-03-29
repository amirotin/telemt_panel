package config

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	"golang.org/x/crypto/bcrypt"
)


// AutoUpdateConfig controls automatic update checking for a component.
type AutoUpdateConfig struct {
	Enabled       bool   `toml:"enabled"`
	CheckInterval string `toml:"check_interval"` // Go duration, e.g. "1h", "30m"
	AutoApply     bool   `toml:"auto_apply"`
}

// Interval returns the parsed check interval, defaulting to 1h on parse error.
func (c AutoUpdateConfig) Interval() time.Duration {
	if c.CheckInterval == "" {
		return 1 * time.Hour
	}
	d, err := time.ParseDuration(c.CheckInterval)
	if err != nil {
		log.Printf("auto_update: invalid check_interval %q, defaulting to 1h: %s", c.CheckInterval, err)
		return 1 * time.Hour
	}
	if d < 5*time.Minute {
		log.Printf("auto_update: check_interval %v too low, minimum is 5m", d)
		return 5 * time.Minute
	}
	return d
}

type Config struct {
	Path     string       `toml:"-"` // config file path, set after loading
	Listen   string       `toml:"listen"`
	BasePath string       `toml:"base_path"`
	Telemt   TelemtConfig `toml:"telemt"`
	Panel    PanelConfig  `toml:"panel"`
	Auth     AuthConfig   `toml:"auth"`
	TLS      TLSConfig    `toml:"tls"`
	GeoIP    GeoIPConfig  `toml:"geoip"`
}

type GeoIPConfig struct {
	DBPath    string `toml:"db_path"`
	ASNDBPath string `toml:"asn_db_path"`
}

type TLSConfig struct {
	CertFile     string `toml:"cert_file"`
	KeyFile      string `toml:"key_file"`
	AcmeDomain   string `toml:"acme_domain"`
	AcmeCacheDir string `toml:"acme_cache_dir"`
}

type TelemtConfig struct {
	URL           string `toml:"url"`
	AuthHeader    string `toml:"auth_header"`
	BinaryPath    string `toml:"binary_path"`
	ServiceName   string `toml:"service_name"`
	GithubRepo    string `toml:"github_repo"`
	ConfigPath    string `toml:"config_path"`
	ContainerName string `toml:"container_name"`
	AutoUpdate    AutoUpdateConfig `toml:"auto_update"`
}

type PanelConfig struct {
	BinaryPath       string `toml:"binary_path"`
	ServiceName      string `toml:"service_name"`
	GithubRepo       string `toml:"github_repo"`
	MaxNewerReleases int    `toml:"max_newer_releases"`
	MaxOlderReleases int    `toml:"max_older_releases"`
	AutoUpdate       AutoUpdateConfig `toml:"auto_update"`
}

type AuthConfig struct {
	Username     string `toml:"username"`
	PasswordHash string `toml:"password_hash"`
	JWTSecret    string `toml:"jwt_secret"`
	SessionTTL   string `toml:"session_ttl"`
}

// checkFileReadable verifies that a file exists and can be opened for reading.
func checkFileReadable(field, path string) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%s: file not found: %s", field, path)
		}
		if os.IsPermission(err) {
			return fmt.Errorf("%s: permission denied: %s", field, path)
		}
		return fmt.Errorf("%s: cannot open file: %w", field, err)
	}
	f.Close()
	return nil
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg := &Config{
		Listen: "0.0.0.0:8080",
		Auth: AuthConfig{
			SessionTTL: "24h",
		},
	}

	if err := toml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if cfg.Telemt.BinaryPath == "" {
		cfg.Telemt.BinaryPath = "/bin/telemt"
	}
	if cfg.Telemt.ServiceName == "" {
		cfg.Telemt.ServiceName = "telemt"
	}
	if cfg.Telemt.GithubRepo == "" {
		cfg.Telemt.GithubRepo = "telemt/telemt"
	}

	if cfg.Panel.BinaryPath == "" {
		cfg.Panel.BinaryPath = "/usr/local/bin/telemt-panel"
	}
	if cfg.Panel.ServiceName == "" {
		cfg.Panel.ServiceName = "telemt-panel"
	}
	if cfg.Panel.GithubRepo == "" {
		cfg.Panel.GithubRepo = "amirotin/telemt_panel"
	}

	// Validate auto-update intervals
	_ = cfg.Telemt.AutoUpdate.Interval()
	_ = cfg.Panel.AutoUpdate.Interval()

	// Normalize base_path: ensure leading slash, strip trailing slash
	cfg.BasePath = strings.TrimRight(cfg.BasePath, "/")
	if cfg.BasePath != "" && !strings.HasPrefix(cfg.BasePath, "/") {
		cfg.BasePath = "/" + cfg.BasePath
	}

	if cfg.TLS.AcmeCacheDir == "" {
		cfg.TLS.AcmeCacheDir = "/var/lib/telemt-panel/certs"
	}

	if cfg.TLS.CertFile != "" && cfg.TLS.AcmeDomain != "" {
		return nil, fmt.Errorf("tls: cert_file and acme_domain are mutually exclusive")
	}
	if (cfg.TLS.CertFile != "") != (cfg.TLS.KeyFile != "") {
		return nil, fmt.Errorf("tls: both cert_file and key_file must be set")
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

	// Auto-hash plain text passwords (not starting with $2a$, $2b$, or $2y$)
	if !strings.HasPrefix(cfg.Auth.PasswordHash, "$2a$") &&
		!strings.HasPrefix(cfg.Auth.PasswordHash, "$2b$") &&
		!strings.HasPrefix(cfg.Auth.PasswordHash, "$2y$") {
		hash, err := bcrypt.GenerateFromPassword([]byte(cfg.Auth.PasswordHash), 10)
		if err != nil {
			return nil, fmt.Errorf("hash password: %w", err)
		}
		log.Println("WARNING: password_hash contains plain text password. Replace it with the following bcrypt hash:")
		log.Printf("  password_hash = \"%s\"", string(hash))
		cfg.Auth.PasswordHash = string(hash)
	}
	if cfg.Auth.JWTSecret == "" {
		return nil, fmt.Errorf("auth.jwt_secret is required")
	}

	// Validate GeoIP database paths are accessible
	if cfg.GeoIP.DBPath != "" {
		if err := checkFileReadable("geoip.db_path", cfg.GeoIP.DBPath); err != nil {
			return nil, err
		}
	}
	if cfg.GeoIP.ASNDBPath != "" {
		if err := checkFileReadable("geoip.asn_db_path", cfg.GeoIP.ASNDBPath); err != nil {
			return nil, err
		}
	}

	cfg.Path = path
	return cfg, nil
}
