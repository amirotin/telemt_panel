package config

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func sourceFixture(t *testing.T, legacy bool) string {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte("test password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	s := fmt.Sprintf("[telemt]\nurl = 'http://127.0.0.1:9091'\nauth_header = 'PRIVATE_API_TOKEN'\n[auth]\nusername = 'operator'\npassword_hash = '%s'\n", hash)
	if legacy {
		s += "jwt_secret = 'PRIVATE_JWT_SECRET'\n"
	}
	return s
}

func TestLegacySourcePreservesTransportDefaultsAndCarryData(t *testing.T) {
	raw := `listen = '127.0.0.1:8443'
base_path = 'admin/'
data_dir = '/custom/state'
trusted_proxies = [
 '127.0.0.1/32',
 '::1',
]
` + sourceFixture(t, true) + `
[panel]
binary_path = '/opt/panel'
service_name = 'custom-panel'
github_repo = 'owner/panel'
github_token = 'PRIVATE_GITHUB_TOKEN'
max_newer_releases = 7
[tls]
acme_domain = 'panel.example.com'
[geoip]
db_path = '/not-opened/city.mmdb'
asn_db_path = '/not-opened/asn.mmdb'
[users]
max_tcp_conns = 12
[telemt.auto_update]
enabled = true
check_interval = '15m'
auto_apply = true
`
	doc, err := DecodeSource([]byte(raw), "source.toml", "auto")
	if err != nil {
		t.Fatal(err)
	}
	cfg := doc.Config
	if doc.Format != "0.6" || cfg.Listen != "127.0.0.1:8443" || cfg.BasePath != "/admin" || cfg.DataDir != "/custom/state" {
		t.Fatalf("wrong compatible mapping")
	}
	if cfg.Auth.Username != "operator" || cfg.Auth.SessionTTLDuration() != 24*time.Hour {
		t.Fatal("legacy credentials/TTL changed")
	}
	if cfg.TLS.AcmeCacheDir != "/var/lib/telemt-panel/certs" || cfg.TLS.Mode != "acme" {
		t.Fatal("legacy cache default changed")
	}
	if cfg.Host.PanelService != "custom-panel" || cfg.Updates.PanelBinaryPath != "/opt/panel" || cfg.Updates.PanelRepo != "owner/panel" {
		t.Fatal("custom target lost")
	}
	if len(cfg.TrustedProxyPrefixes) != 2 {
		t.Fatal("multiline proxy list lost")
	}
	if doc.Legacy == nil || doc.Legacy.GeoIP.DBPath != "/not-opened/city.mmdb" || doc.Legacy.Users.MaxTCPConns != 12 || doc.Legacy.TelemtAuto.CheckInterval != "15m" || !doc.Legacy.TelemtAuto.AutoApply || doc.Legacy.MaxNewerReleases != 7 {
		t.Fatal("state/manual-transfer fields lost")
	}
	encoded, err := json.Marshal(doc.Report())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"PRIVATE_API_TOKEN", "PRIVATE_JWT_SECRET", "PRIVATE_GITHUB_TOKEN", cfg.Auth.PasswordHash} {
		if strings.Contains(string(encoded), secret) {
			t.Fatal("inspect leaked a secret")
		}
	}
	if !doc.Report().RequiresMigration {
		t.Fatal("legacy presented as ready for ordinary startup")
	}
}

func TestSourceHandlesDottedLiteralEscapedAndMultilineValues(t *testing.T) {
	raw := `telemt.url = 'http://127.0.0.1:9091'
telemt.auth_header = """Bearer
PRIVATE_MULTILINE_TOKEN"""
telemt.binary_path = '/opt/bin/telemt'
telemt.service_name = 'custom-telemt'
telemt.container_name = 'custom-container'
telemt.config_edit_mode = 'file'
auth.username = "oper\u0061tor"
auth.password_hash = 'plain\literal'
auth.jwt_secret = 'PRIVATE_JWT'
`
	doc, err := DecodeSource([]byte(raw), "legacy.toml", "auto")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Config.Auth.Username != "operator" || bcrypt.CompareHashAndPassword([]byte(doc.Config.Auth.PasswordHash), []byte(`plain\literal`)) != nil {
		t.Fatal("literal password/escaped username changed")
	}
	if doc.Config.Telemt.AuthHeader != "Bearer\nPRIVATE_MULTILINE_TOKEN" || doc.Config.Updates.TelemtBinaryPath != "/opt/bin/telemt" || doc.Config.Host.TelemtContainer != "custom-container" || doc.Config.Host.TelemtService != "custom-telemt" || doc.Config.Telemt.ConfigEditMode != "file" {
		t.Fatal("typed mapping changed data")
	}
}

func TestSourceRejectsMixedUnknownAndInvalidWithoutSecrets(t *testing.T) {
	legacy := sourceFixture(t, true)
	current := sourceFixture(t, false)
	for _, raw := range []string{
		legacy + "[host]\nservice_manager='none'\n",
		legacy + "[tls]\nmode='http'\n",
		"typo='PRIVATE_TOKEN'\n" + legacy,
		"typo='PRIVATE_TOKEN'\n" + current,
		strings.Replace(current, "[auth]", "[auth]\nsession_ttl='PRIVATE_TOKEN'", 1),
		strings.Replace(current, "url = 'http://127.0.0.1:9091'", "url = ['PRIVATE_TOKEN']", 1),
		"[auth]\npassword_hash='PRIVATE_TOKEN\n",
	} {
		_, err := DecodeSource([]byte(raw), "test.toml", "auto")
		if err == nil {
			t.Fatal("invalid or ambiguous source accepted")
		}
		if strings.Contains(err.Error(), "PRIVATE") {
			t.Fatal("error leaked config content")
		}
	}
	if _, err := DecodeSource([]byte(legacy), "test.toml", "current"); err == nil {
		t.Fatal("forced current accepted legacy")
	}
	if _, err := DecodeSource([]byte(current), "test.toml", "0.6"); err == nil {
		t.Fatal("legacy without JWT accepted")
	}
}

func TestCurrentInspectionDoesNotAdoptLegacyDefaults(t *testing.T) {
	doc, err := DecodeSource([]byte(sourceFixture(t, false)), "current.toml", "auto")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Format != "current" || doc.Legacy != nil || doc.Report().RequiresMigration || doc.Config.Auth.SessionTTLDuration() != 720*time.Hour {
		t.Fatal("current source semantics changed")
	}
}

func TestLegacySourceTTLAndInactiveTLSDefaults(t *testing.T) {
	fixture := sourceFixture(t, true)
	for _, ttl := range []string{"", "invalid", "12h"} {
		raw := "data_dir = ''\n" + fixture + "session_ttl = '" + ttl + "'\n[tls]\nacme_cache_dir = '/old/inactive/cache'\n"
		doc, err := DecodeSource([]byte(raw), "legacy.toml", "auto")
		if err != nil {
			t.Fatal(err)
		}
		wantTTL := 24 * time.Hour
		if ttl == "12h" {
			wantTTL = 12 * time.Hour
		}
		if doc.Config.Auth.SessionTTLDuration() != wantTTL || doc.Config.DataDir != "/var/lib/telemt-panel" || doc.Config.TLS.Mode != "http" || doc.Legacy.InactiveCacheDir != "/old/inactive/cache" {
			t.Fatal("legacy defaults or inactive settings changed")
		}
		if !strings.Contains(fixture, doc.Config.Auth.PasswordHash) {
			t.Fatal("existing bcrypt hash changed")
		}
	}
	for _, ttl := range []string{"0s", "-1h"} {
		if _, err := DecodeSource([]byte(fixture+"session_ttl = '"+ttl+"'\n"), "legacy.toml", "auto"); err == nil {
			t.Fatal("unusable session TTL accepted")
		}
	}
}

func TestSourceRejectsInvalidListenerAndHash(t *testing.T) {
	fixture := sourceFixture(t, false)
	for _, listen := range []string{"localhost:http", ":0", ":65536", ":+80", "::1:8080", " :8080 "} {
		if _, err := DecodeSource([]byte("listen = '"+listen+"'\n"+fixture), "config.toml", "auto"); err == nil {
			t.Errorf("invalid listener accepted: %s", listen)
		}
	}
	for _, hash := range []string{"PRIVATE_PLAIN", "$2a$PRIVATE_BROKEN"} {
		raw := "[telemt]\nurl='http://localhost:9091'\n[auth]\nusername='admin'\npassword_hash='" + hash + "'\n"
		if _, err := DecodeSource([]byte(raw), "config.toml", "auto"); err == nil || strings.Contains(err.Error(), "PRIVATE") {
			t.Fatal("invalid hash accepted or exposed")
		}
	}
}
