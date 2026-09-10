package httpapi

import (
	"bytes"
	"encoding/json"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/host/hosttest"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPanelAccessRoutesRequireSessionAndCSRF(t *testing.T) {
	s := newTestServer(t)
	h := s.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/settings/tls/config"}, {"POST", "/api/settings/tls/prepare"},
		{"PUT", "/api/settings/tls/config"}, {"POST", "/api/settings/tls/restart"},
	} {
		t.Run(route.method+route.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, mutating(route.method, route.path, nil))
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("anonymous status=%d, want 401", w.Code)
			}
			if route.method != "GET" {
				r := mutating(route.method, route.path, cookie)
				r.Header.Set("Sec-Fetch-Site", "cross-site")
				w = httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != http.StatusForbidden {
					t.Fatalf("cross-site status=%d, want 403", w.Code)
				}
			}
		})
	}
}

func accessServer(t *testing.T) (*Server, *http.Cookie, string) {
	t.Helper()
	s := newTestServer(t)
	path := filepath.Join(t.TempDir(), "config.toml")
	fixture := `listen = "127.0.0.1:8080"
data_dir = ""
[telemt]
url = "http://127.0.0.1:1"
[auth]
username = "admin"
password_hash = "sensitive-fixture"
`
	if err := os.WriteFile(path, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	s.cfg.Listen = "127.0.0.1:8080"
	s.cfg.TLS = config.TLSConfig{Mode: "http"}
	s.cfg.Host.PanelService = "test-panel"
	s.svcMgr = &hosttest.ServiceManager{KindValue: host.KindSystemd, CapsValue: host.ServiceCaps{CanRestart: true}}
	s.privilegesMode = host.PrivilegesModeDirect
	s.SetTLSConfigPath(path)
	t.Cleanup(func() { s.access.close() })
	_, cookie := login(t, s.Handler(), "admin", testPassword)
	return s, cookie, path
}

func accessRequest(t *testing.T, s *Server, cookie *http.Cookie, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := mutating(method, path, cookie)
	r.Body = io.NopCloser(bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func TestPanelAccessRequiresRunningServiceWhenStatusIsSupported(t *testing.T) {
	for _, status := range []host.ServiceStatus{host.StatusRunning, host.StatusStopped, host.StatusUnknown} {
		t.Run(string(status), func(t *testing.T) {
			s, cookie, path := accessServer(t)
			s.svcMgr = &hosttest.ServiceManager{KindValue: host.KindSystemd,
				CapsValue: host.ServiceCaps{CanRestart: true, CanStatus: true}, StatusResult: status}
			w := accessRequest(t, s, cookie, "GET", "/api/settings/tls/config", nil)
			var settings tlsSettings
			if err := json.Unmarshal(w.Body.Bytes(), &settings); err != nil {
				t.Fatal(err)
			}
			want := status == host.StatusRunning
			if settings.Capabilities.Restart != want || !settings.Capabilities.Prepare {
				t.Fatalf("service=%s: capabilities=%+v", status, settings.Capabilities)
			}
			if !want {
				before, _ := os.ReadFile(path)
				w = accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", config.TLSCandidate{Listen: s.cfg.Listen, TLS: s.cfg.TLS})
				after, _ := os.ReadFile(path)
				if w.Code != http.StatusOK || !bytes.Equal(before, after) {
					t.Fatalf("manual preparation unavailable or wrote config: %d", w.Code)
				}
			}
		})
	}
}

func TestPanelAccessFailedPreparationNeverChangesConfiguration(t *testing.T) {
	s, cookie, path := accessServer(t)
	before, _ := os.ReadFile(path)
	for _, candidate := range []map[string]any{
		{"listen": "127.0.0.1:0", "tls": map[string]string{"mode": "http"}},
		{"listen": "127.0.0.1:http", "tls": map[string]string{"mode": "http"}},
		{"listen": "127.0.0.1:8443", "tls": map[string]string{"mode": "acme", "acme_domain": "127.0.0.1"}},
		{"listen": "127.0.0.1:8443", "tls": map[string]string{"mode": "http", "cert_file": "/missing"}},
		{"listen": "127.0.0.1:8443", "tls": map[string]string{"mode": "certificate", "cert_file": "/missing", "key_file": "/missing"}},
	} {
		w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", candidate)
		if w.Code < 400 {
			t.Fatalf("invalid candidate accepted: %s", w.Body.String())
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(before, after) {
			t.Fatal("failed preparation changed config")
		}
	}
}

func TestPanelAccessPreparedSaveAndDiskRuntimeDistinction(t *testing.T) {
	s, cookie, path := accessServer(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	candidate := config.TLSCandidate{Listen: ln.Addr().String(), TLS: config.TLSConfig{Mode: "http"}}
	ln.Close()
	w := accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", candidate)
	if w.Code != 200 {
		t.Fatalf("prepare: %d %s", w.Code, w.Body.String())
	}
	var prepared tlsPrepared
	if err := json.Unmarshal(w.Body.Bytes(), &prepared); err != nil {
		t.Fatal(err)
	}
	changed := candidate
	changed.Listen = "127.0.0.1:8888"
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": prepared.Receipt, "candidate": changed})
	if w.Code != 409 {
		t.Fatalf("changed candidate accepted: %d", w.Code)
	}
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": prepared.Receipt, "candidate": candidate})
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	after, err := config.Load(path)
	if err != nil || after.Listen != candidate.Listen {
		t.Fatal("invalid saved config", err)
	}
	w = accessRequest(t, s, cookie, "GET", "/api/settings/tls/config", nil)
	var state tlsSettings
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.State != "saved" || !state.RestartRequired || state.Active.Listen != "127.0.0.1:8080" || state.Configured.Listen != candidate.Listen || state.Prepared != nil {
		t.Fatalf("incorrect saved/runtime state: %+v", state)
	}
	w = accessRequest(t, s, cookie, "PUT", "/api/settings/tls/config", map[string]any{"receipt": prepared.Receipt, "candidate": candidate})
	if w.Code != 409 {
		t.Fatal("consumed receipt replay accepted")
	}
}

func TestPanelAccessManualOnlyAndUnconfigured(t *testing.T) {
	s := newTestServer(t)
	_, cookie := login(t, s.Handler(), "admin", testPassword)
	w := accessRequest(t, s, cookie, "GET", "/api/settings/tls/config", nil)
	if w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte("sensitive")) {
		t.Fatalf("unconfigured: %d %s", w.Code, w.Body.String())
	}
	w = accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", config.TLSCandidate{Listen: "127.0.0.1:8080", TLS: config.TLSConfig{Mode: "http"}})
	if w.Code != 503 {
		t.Fatalf("unconfigured preparation: %d", w.Code)
	}
	s, cookie, path := accessServer(t)
	s.privilegesMode = host.PrivilegesModeManual
	before, _ := os.ReadFile(path)
	w = accessRequest(t, s, cookie, "POST", "/api/settings/tls/prepare", config.TLSCandidate{Listen: "127.0.0.1:8080", TLS: config.TLSConfig{Mode: "http"}})
	if w.Code != 200 {
		t.Fatalf("manual preparation: %d", w.Code)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("manual-only partially saved")
	}
}
