package config

import (
	"bytes"
	"errors"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	"golang.org/x/crypto/bcrypt"
)

// LegacyAutoUpdate preserves 0.6 scheduler inputs without choosing a new policy.
type LegacyAutoUpdate struct {
	Enabled       bool   `toml:"enabled"`
	CheckInterval string `toml:"check_interval"`
	AutoApply     bool   `toml:"auto_apply"`
}

// LegacyGeoIP preserves local paths; offline conversion never opens MMDB files.
type LegacyGeoIP struct {
	DBPath    string `toml:"db_path"`
	ASNDBPath string `toml:"asn_db_path"`
}

// LegacyUserDefaults are form defaults, never the Telemt accounts themselves.
type LegacyUserDefaults struct {
	AdTag          string `toml:"ad_tag"`
	MaxTCPConns    int    `toml:"max_tcp_conns"`
	DataQuotaBytes int64  `toml:"data_quota_bytes"`
	MaxUniqueIPs   int    `toml:"max_unique_ips"`
	Expiration     string `toml:"expiration"`
}

// LegacyCarry retains settings that cannot be represented by the current startup
// TOML alone. The state importer applies compatible values and reports the rest.
type LegacyCarry struct {
	TelemtAuto       LegacyAutoUpdate
	PanelAuto        LegacyAutoUpdate
	GeoIP            LegacyGeoIP
	Users            LegacyUserDefaults
	MaxNewerReleases int
	MaxOlderReleases int
	TelemtConfigPath string
	InactiveCacheDir string
}

type legacyConfig struct {
	Listen         string   `toml:"listen"`
	BasePath       string   `toml:"base_path"`
	DataDir        string   `toml:"data_dir"`
	TrustedProxies []string `toml:"trusted_proxies"`
	Auth           struct {
		Username     string `toml:"username"`
		PasswordHash string `toml:"password_hash"`
		JWTSecret    string `toml:"jwt_secret"`
		SessionTTL   string `toml:"session_ttl"`
	} `toml:"auth"`
	Telemt struct {
		URL            string           `toml:"url"`
		AuthHeader     string           `toml:"auth_header"`
		BinaryPath     string           `toml:"binary_path"`
		ServiceName    string           `toml:"service_name"`
		GithubRepo     string           `toml:"github_repo"`
		ConfigPath     string           `toml:"config_path"`
		ContainerName  string           `toml:"container_name"`
		ConfigEditMode string           `toml:"config_edit_mode"`
		AutoUpdate     LegacyAutoUpdate `toml:"auto_update"`
	} `toml:"telemt"`
	Panel struct {
		BinaryPath       string           `toml:"binary_path"`
		ServiceName      string           `toml:"service_name"`
		GithubRepo       string           `toml:"github_repo"`
		GithubToken      string           `toml:"github_token"`
		MaxNewerReleases int              `toml:"max_newer_releases"`
		MaxOlderReleases int              `toml:"max_older_releases"`
		AutoUpdate       LegacyAutoUpdate `toml:"auto_update"`
	} `toml:"panel"`
	TLS struct {
		CertFile     string `toml:"cert_file"`
		KeyFile      string `toml:"key_file"`
		AcmeDomain   string `toml:"acme_domain"`
		AcmeCacheDir string `toml:"acme_cache_dir"`
	} `toml:"tls"`
	GeoIP LegacyGeoIP        `toml:"geoip"`
	Users LegacyUserDefaults `toml:"users"`
}

func decodeLegacySource(data []byte, path string) (*Source, error) {
	old := legacyConfig{Listen: "0.0.0.0:8080"}
	old.Auth.SessionTTL = "24h"
	md, err := toml.NewDecoder(bytes.NewReader(data)).Decode(&old)
	if err != nil {
		return nil, sourceParseError(err)
	}
	if len(md.Undecoded()) != 0 {
		return nil, errors.New("unknown legacy configuration fields")
	}
	if old.Auth.JWTSecret == "" {
		return nil, errors.New("invalid legacy configuration field: auth.jwt_secret")
	}
	if old.Auth.PasswordHash == "" {
		return nil, errors.New("invalid legacy configuration field: auth.password_hash")
	}
	warnings := []string{"legacy_sessions_require_login"}
	password := old.Auth.PasswordHash
	plaintext := ""
	if !strings.HasPrefix(password, "$2a$") && !strings.HasPrefix(password, "$2b$") && !strings.HasPrefix(password, "$2y$") {
		plaintext = password
		hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
		if err != nil {
			return nil, errors.New("cannot hash legacy password")
		}
		password = string(hash)
		warnings = append(warnings, "legacy_plaintext_password_hashed")
	}
	if _, err := time.ParseDuration(old.Auth.SessionTTL); err != nil {
		old.Auth.SessionTTL = "24h"
		warnings = append(warnings, "legacy_session_ttl_defaulted")
	}
	if old.Users.Expiration != "" {
		if _, err := time.Parse(time.RFC3339, old.Users.Expiration); err != nil {
			return nil, errors.New("invalid legacy configuration field: users.expiration")
		}
	}
	editMode := "api"
	if strings.EqualFold(strings.TrimSpace(old.Telemt.ConfigEditMode), "file") {
		editMode = "file"
		warnings = append(warnings, "telemt_config_api_required")
	}
	carry := &LegacyCarry{TelemtAuto: old.Telemt.AutoUpdate, PanelAuto: old.Panel.AutoUpdate,
		GeoIP: old.GeoIP, Users: old.Users, MaxNewerReleases: old.Panel.MaxNewerReleases,
		MaxOlderReleases: old.Panel.MaxOlderReleases, TelemtConfigPath: old.Telemt.ConfigPath}
	if old.Telemt.AutoUpdate != (LegacyAutoUpdate{}) || old.Panel.AutoUpdate != (LegacyAutoUpdate{}) {
		warnings = append(warnings, "auto_update_requires_state_import")
	}
	if old.GeoIP != (LegacyGeoIP{}) {
		warnings = append(warnings, "geoip_requires_state_import")
	}
	if old.Users != (LegacyUserDefaults{}) {
		warnings = append(warnings, "user_defaults_not_applied")
	}
	if old.Panel.MaxNewerReleases != 0 || old.Panel.MaxOlderReleases != 0 {
		warnings = append(warnings, "release_limits_not_applied")
	}
	if old.Telemt.ConfigPath != "" {
		warnings = append(warnings, "telemt_config_path_not_used")
	}
	tls := TLSConfig{CertFile: old.TLS.CertFile, KeyFile: old.TLS.KeyFile, AcmeDomain: old.TLS.AcmeDomain}
	if tls.AcmeDomain != "" {
		tls.AcmeCacheDir = legacyDefault(old.TLS.AcmeCacheDir, "/var/lib/telemt-panel/certs")
	} else if old.TLS.AcmeCacheDir != "" {
		carry.InactiveCacheDir = old.TLS.AcmeCacheDir
		warnings = append(warnings, "inactive_acme_cache_retained")
	}
	host := map[string]any{"panel_service": legacyDefault(old.Panel.ServiceName, "telemt-panel"), "telemt_service": legacyDefault(old.Telemt.ServiceName, "telemt")}
	if old.Telemt.ContainerName != "" {
		host["telemt_container"] = old.Telemt.ContainerName
	}
	current := map[string]any{
		"listen": old.Listen, "base_path": old.BasePath, "data_dir": legacyDefault(old.DataDir, "/var/lib/telemt-panel"), "trusted_proxies": old.TrustedProxies,
		"auth":   AuthConfig{Username: old.Auth.Username, PasswordHash: password, SessionTTL: old.Auth.SessionTTL},
		"telemt": TelemtConfig{URL: old.Telemt.URL, AuthHeader: old.Telemt.AuthHeader, ConfigEditMode: editMode},
		"host":   host, "tls": tls,
		"updates": UpdatesConfig{TelemtRepo: legacyDefault(old.Telemt.GithubRepo, "telemt/telemt"), PanelRepo: legacyDefault(old.Panel.GithubRepo, "amirotin/telemt_panel"),
			GithubToken: old.Panel.GithubToken, TelemtBinaryPath: legacyDefault(old.Telemt.BinaryPath, "/bin/telemt"), PanelBinaryPath: legacyDefault(old.Panel.BinaryPath, "/usr/local/bin/telemt-panel")},
	}
	var encoded bytes.Buffer
	if err := toml.NewEncoder(&encoded).Encode(current); err != nil {
		return nil, errors.New("cannot encode converted configuration")
	}
	cfg, err := decode(encoded.Bytes(), path)
	if err != nil {
		return nil, sourceValidationError(err)
	}
	if err := validateSourceRuntime(cfg); err != nil {
		return nil, err
	}
	return &Source{Format: "0.6", Config: cfg, Legacy: carry, Warnings: warnings, legacyPassword: plaintext}, nil
}

func legacyDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
