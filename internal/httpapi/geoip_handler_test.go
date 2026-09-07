package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/geoip"
)

func geoIPTestServer(t *testing.T) *Server {
	t.Helper()
	s, st := newStorageTestServer(t)
	s.geoip = geoip.NewManager(t.TempDir(), st)
	t.Cleanup(s.geoip.Close)
	return s
}

func TestGeoIPSettingsDefaultAndStrictRequests(t *testing.T) {
	s := geoIPTestServer(t)
	w := httptest.NewRecorder()
	s.handleGetGeoIPSettings(w, httptest.NewRequest(http.MethodGet, "/api/settings/geoip", nil))
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("GET %d %v", w.Code, w.Header())
	}
	var initial geoip.Settings
	if err := json.Unmarshal(w.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if initial.Config.Enabled || initial.Status.Available || initial.Config.Source != "community" {
		t.Fatalf("defaults %+v", initial)
	}
	before := s.geoip.Settings()
	for _, body := range []string{
		`{}`,
		`null`,
		`{"unknown":true}`,
		`{} {}`,
		strings.Repeat(" ", 65537),
		`{"source":"community","schedule":"weekly"}`,
		`{"enabled":null,"source":"community","schedule":"weekly","country":{"enabled":true,"location":""},"asn":{"enabled":true,"location":""},"city":{"enabled":false,"location":""}}`,
		`{"enabled":false,"source":"community","schedule":"weekly","country":null,"asn":{"enabled":true,"location":""},"city":{"enabled":false,"location":""}}`,
		`{"enabled":false,"source":"community","schedule":"weekly","country":{"enabled":null,"location":""},"asn":{"enabled":true,"location":""},"city":{"enabled":false,"location":""}}`,
		`{"enabled":false,"source":"community","schedule":"weekly","country":{"enabled":true},"asn":{"enabled":true,"location":""},"city":{"enabled":false,"location":""}}`,
		`{"enabled":false,"source":"community","schedule":"weekly","country":{"enabled":true,"location":null},"asn":{"enabled":true,"location":""},"city":{"enabled":false,"location":""}}`,
	} {
		w = httptest.NewRecorder()
		s.handlePutGeoIPSettings(w, httptest.NewRequest(http.MethodPut, "/api/settings/geoip", strings.NewReader(body)))
		if w.Code != http.StatusBadRequest {
			t.Errorf("malformed body %q returned %d", body, w.Code)
		}
		if after := s.geoip.Settings(); !reflect.DeepEqual(after, before) {
			t.Fatalf("malformed body changed settings: before=%+v after=%+v", before, after)
		}
	}
	w = httptest.NewRecorder()
	s.handleUpdateGeoIP(w, httptest.NewRequest(http.MethodPost, "/api/settings/geoip/update", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("disabled update: %d", w.Code)
	}
}

func TestGeoIPSettingsApplyFailureIsObservableWithoutLeakingPaths(t *testing.T) {
	s := geoIPTestServer(t)
	cfg := geoip.DefaultConfig()
	cfg.Enabled, cfg.Source = true, "files"
	cfg.ASN.Enabled = false
	cfg.Country.Location = "/does-not-exist/private-secret-country.mmdb"
	body, _ := json.Marshal(cfg)
	w := httptest.NewRecorder()
	s.handlePutGeoIPSettings(w, httptest.NewRequest(http.MethodPut, "/api/settings/geoip", bytes.NewReader(body)))
	if w.Code != http.StatusAccepted {
		t.Fatalf("apply: %d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(3 * time.Second)
	for s.geoip.Status().State == "updating" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	status := s.geoip.Status()
	if status.State != "error" || status.Available {
		t.Fatalf("status %+v", status)
	}
	encoded, _ := json.Marshal(status)
	if strings.Contains(string(encoded), "private-secret") || status.LastError == nil {
		t.Fatalf("unsafe/absent error %s", encoded)
	}
	cfg.Enabled = false
	body, _ = json.Marshal(cfg)
	w = httptest.NewRecorder()
	s.handlePutGeoIPSettings(w, httptest.NewRequest(http.MethodPut, "/api/settings/geoip", bytes.NewReader(body)))
	if w.Code != 202 || s.geoip.Status().State != "disabled" {
		t.Fatalf("disable: %d %+v", w.Code, s.geoip.Status())
	}
}

func TestGeoIPRoutesRequireSessionAndCSRF(t *testing.T) {
	s := newTestServer(t)
	t.Cleanup(s.geoip.Close)
	h := s.Handler()
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/settings/geoip"},
		{http.MethodPut, "/api/settings/geoip"},
		{http.MethodPost, "/api/settings/geoip/update"},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(route.method, route.path, nil)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("anonymous %s %s = %d", route.method, route.path, w.Code)
		}
	}
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("login failed")
	}
	for _, method := range []string{http.MethodPut, http.MethodPost} {
		path := "/api/settings/geoip"
		if method == http.MethodPost {
			path += "/update"
		}
		r := httptest.NewRequest(method, path, nil)
		r.AddCookie(cookie)
		r.Header.Set("Sec-Fetch-Site", "cross-site")
		r.Header.Set("Origin", "https://untrusted.example")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Errorf("cross-site %s = %d", method, w.Code)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/api/settings/geoip", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("authenticated GET %d", w.Code)
	}
}

func TestServerListenFailureStopsGeoIPWorker(t *testing.T) {
	s := newTestServer(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	s.cfg.Listen = listener.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("occupied listen address succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run waited for a scheduler despite failing to listen")
	}
}
