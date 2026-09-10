package config

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
	"golang.org/x/crypto/bcrypt"
)

// Source is a validated configuration and any legacy data requiring a later
// state import. Sensitive values are never included in its JSON representation.
type Source struct {
	Format         string       `json:"format"`
	Config         *Config      `json:"-"`
	Legacy         *LegacyCarry `json:"-"`
	Warnings       []string     `json:"warnings"`
	legacyPassword string
}

// HasLegacyPlaintextPassword reports whether compatibility startup needs a
// stable bcrypt hash. The original value never enters the serialized carry data.
func (s *Source) HasLegacyPlaintextPassword() bool { return s.legacyPassword != "" }

// ReuseLegacyPasswordHash keeps the persisted identity when the original legacy
// password is unchanged. Only our cost-10 compatibility hashes are accepted.
func (s *Source) ReuseLegacyPasswordHash(hash string) bool {
	cost, err := bcrypt.Cost([]byte(hash))
	if !s.HasLegacyPlaintextPassword() || err != nil || cost != 10 || bcrypt.CompareHashAndPassword([]byte(hash), []byte(s.legacyPassword)) != nil {
		return false
	}
	s.Config.Auth.PasswordHash = hash
	return true
}

// SourceReport is the allowlisted, non-secret output for offline inspection.
type SourceReport struct {
	Format            string   `json:"format"`
	RequiresMigration bool     `json:"requires_migration"`
	Listen            string   `json:"listen"`
	BasePath          string   `json:"base_path"`
	DataDir           string   `json:"data_dir"`
	TLSMode           string   `json:"tls_mode"`
	ACMEDomain        string   `json:"acme_domain,omitempty"`
	SessionTTL        string   `json:"session_ttl"`
	PanelService      string   `json:"panel_service"`
	TelemtService     string   `json:"telemt_service"`
	PanelBinaryPath   string   `json:"panel_binary_path"`
	TelemtBinaryPath  string   `json:"telemt_binary_path"`
	StoreDriver       string   `json:"store_driver"`
	HasTelemtAuth     bool     `json:"has_telemt_auth"`
	HasGithubToken    bool     `json:"has_github_token"`
	Warnings          []string `json:"warnings"`
}

// Report deliberately excludes API URLs, tokens, password hashes and JWT keys.
func (s *Source) Report() SourceReport {
	c := s.Config
	return SourceReport{Format: s.Format, RequiresMigration: s.Legacy != nil,
		Listen: c.Listen, BasePath: c.BasePath, DataDir: c.DataDir,
		TLSMode: c.TLS.Mode, ACMEDomain: c.TLS.AcmeDomain,
		SessionTTL: c.Auth.SessionTTLDuration().String(), PanelService: c.Host.PanelService,
		TelemtService: c.Host.TelemtService, PanelBinaryPath: c.Updates.PanelBinaryPath,
		TelemtBinaryPath: c.Updates.TelemtBinaryPath,
		StoreDriver:      c.Store.Driver, HasTelemtAuth: c.Telemt.AuthHeader != "",
		HasGithubToken: c.Updates.GithubToken != "", Warnings: s.Warnings}
}

// DecodeSource parses current or production 0.6 TOML without opening resources,
// starting collectors or writing configuration/state. Normal Load stays strict.
func DecodeSource(data []byte, path, format string) (*Source, error) {
	if format != "auto" && format != "current" && format != "0.6" {
		return nil, errors.New("config format must be auto, current or 0.6")
	}
	var document map[string]any
	md, err := toml.NewDecoder(bytes.NewReader(data)).Decode(&document)
	if err != nil {
		return nil, sourceParseError(err)
	}
	legacy := false
	for _, key := range [][]string{{"auth", "jwt_secret"}, {"panel"}, {"geoip"}, {"users"},
		{"telemt", "binary_path"}, {"telemt", "service_name"}, {"telemt", "github_repo"},
		{"telemt", "config_path"}, {"telemt", "container_name"}, {"telemt", "auto_update"}} {
		legacy = legacy || md.IsDefined(key...)
	}
	current := false
	for _, key := range [][]string{{"store"}, {"host"}, {"updates"}, {"privileges"}, {"subpage"}, {"tls", "mode"}} {
		current = current || md.IsDefined(key...)
	}
	if legacy && current {
		return nil, errors.New("mixed legacy and current configuration fields")
	}
	if format == "auto" {
		format = "current"
		if legacy {
			format = "0.6"
		}
	}
	if format == "0.6" {
		return decodeLegacySource(data, path)
	}
	cfg, err := decode(data, path)
	if err != nil {
		return nil, sourceValidationError(err)
	}
	if err := validateSourceRuntime(cfg); err != nil {
		return nil, err
	}
	return &Source{Format: "current", Config: cfg, Warnings: []string{}}, nil
}

func validateSourceRuntime(cfg *Config) error {
	_, port, err := net.SplitHostPort(cfg.Listen)
	n, portErr := strconv.ParseUint(port, 10, 16)
	if err != nil || portErr != nil || n == 0 || strings.TrimSpace(cfg.Listen) != cfg.Listen {
		return errors.New("invalid configuration field: listen (numeric port 1..65535 required)")
	}
	if _, err := bcrypt.Cost([]byte(cfg.Auth.PasswordHash)); err != nil {
		return errors.New("invalid configuration field: auth.password_hash (bcrypt required)")
	}
	return nil
}

func sourceParseError(err error) error {
	var parse toml.ParseError
	if errors.As(err, &parse) {
		return fmt.Errorf("invalid TOML at line %d", parse.Position.Line)
	}
	return errors.New("invalid TOML syntax or value type")
}

func sourceValidationError(err error) error {
	// Existing validator errors may quote values. Only trusted field labels are
	// exposed here; raw diagnostics must not leak credentials through inspect.
	message := err.Error()
	for _, field := range []string{"telemt.url", "telemt.config_edit_mode", "auth.username", "auth.password_hash",
		"auth.session_ttl", "base_path", "trusted_proxies", "store.driver", "store.path", "subpage.secret",
		"host.service_manager", "host.log_source", "privileges.mode", "tls.mode", "tls.acme_domain", "tls.acme_cache_dir", "tls", "listen"} {
		if strings.HasPrefix(message, field+":") || strings.HasPrefix(message, field+" ") {
			return fmt.Errorf("invalid configuration field: %s", field)
		}
	}
	if strings.HasPrefix(message, "unknown config keys:") {
		return errors.New("unknown configuration fields")
	}
	return errors.New("configuration validation failed")
}
