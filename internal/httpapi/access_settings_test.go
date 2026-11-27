package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
)

func TestSubscriptionSettingsPrepareSaveAndManualRestart(t *testing.T) {
	s, cookie, path := accessServer(t)
	s.privilegesMode = host.PrivilegesModeManual
	candidate := config.TLSCandidate{Listen: "127.0.0.1:8081", TLS: config.TLSConfig{Mode: "http"}, BasePath: "/clients", PublicURL: "https://links.example", Enabled: true}
	w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare?target=subscription", candidate)
	if w.Code != 200 {
		t.Fatalf("prepare: %d %s", w.Code, w.Body)
	}
	var prepared tlsPrepared
	if err := json.Unmarshal(w.Body.Bytes(), &prepared); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"receipt": prepared.Receipt, "candidate": prepared.Candidate}
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", body)
	if w.Code != 409 {
		t.Fatal("subscription receipt accepted by panel endpoint")
	}
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config?target=subscription", body)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Subpage.Enabled || cfg.Subpage.Secret == "" || cfg.Subpage.BasePath != "/clients" || cfg.Listen != "127.0.0.1:8080" {
		t.Fatal("incorrect persisted endpoints")
	}
	if s.cfg.Subpage.Enabled {
		t.Fatal("save unexpectedly enabled live listener")
	}
	w = accessRequest(t, s, cookie, "GET", "/api/settings/tls/config?target=subscription", nil)
	if w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte(cfg.Subpage.Secret)) {
		t.Fatal("status failed or exposed signing secret")
	}
	w = accessRequest(t, s, cookie, "POST", "/api/settings/tls/restart", nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("manual restart=%d", w.Code)
	}
}

func TestSubscriptionSettingsRejectPortConflictAndUnconfirmedHTTP(t *testing.T) {
	s, cookie, _ := accessServer(t)
	for _, listen := range []string{"127.0.0.1:8080", "0.0.0.0:8081"} {
		candidate := config.TLSCandidate{Listen: listen, TLS: config.TLSConfig{Mode: "http"}, BasePath: "/clients", Enabled: true}
		w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare?target=subscription", candidate)
		if w.Code != 400 {
			t.Fatalf("unsafe prepare %s returned %d", listen, w.Code)
		}
	}
	candidate := config.TLSCandidate{Listen: "127.0.0.1:8081", TLS: config.TLSConfig{Mode: "http"}, BasePath: "/clients", Enabled: true, PublicURL: "http://links.example"}
	w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare?target=subscription", candidate)
	if w.Code != 400 {
		t.Fatalf("external HTTP without confirmation returned %d", w.Code)
	}
}

func TestDisableSubscriptionPreservesSavedEndpoint(t *testing.T) {
	s, cookie, path := accessServer(t)
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	original = append(original, []byte(`
[subpage]
enabled = true
listen = "127.0.0.1:8083"
base_path = "/clients"
secret = "fixture-secret"
`)...)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/settings/tls/"
	request := map[string]any{"enabled": false, "listen": "", "tls": map[string]string{"mode": "certificate"}}
	response := accessRequest(t, s, cookie, "POST", endpoint+"prepare?target=subscription", request)
	var prepared tlsPrepared
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &prepared) != nil || prepared.Receipt == "" ||
		prepared.Candidate.Enabled || prepared.Candidate.Listen != "127.0.0.1:8083" || prepared.Candidate.BasePath != "/clients" {
		t.Fatalf("disable preparation %d: %s", response.Code, response.Body)
	}
	response = accessRequest(t, s, cookie, "PUT", endpoint+"config?target=subscription", map[string]any{"receipt": prepared.Receipt, "candidate": prepared.Candidate})
	if response.Code != 200 {
		t.Fatalf("disable: %d %s", response.Code, response.Body)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Subpage.Enabled || cfg.Subpage.Listen != "127.0.0.1:8083" || cfg.Subpage.Secret != "fixture-secret" {
		t.Fatal("disable discarded the existing settings")
	}
}
