package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/amirotin/telemt_panel/internal/geography"
	"github.com/amirotin/telemt_panel/internal/store"
)

func geographyTestServer(t *testing.T) *Server {
	t.Helper()
	s, st := newStorageTestServer(t)
	if err := st.ApplyUserIPBatch(store.UserIPBatch{ID: "geography", Through: 1800000000, Records: []store.UserIPRecord{{Username: "alice", IP: "1.1.1.1", Family: 4, First: 1800000000, Last: 1800000000, Observations: 1, Source: 1}}}); err != nil {
		t.Fatal(err)
	}
	s.geography = geography.NewService(geography.Dependencies{History: st, State: st, Now: func() time.Time { return time.Unix(1800000000, 0) }})
	t.Cleanup(s.geography.Close)
	return s
}

func TestGeographyHTTPContract(t *testing.T) {
	s := geographyTestServer(t)
	w := httptest.NewRecorder()
	s.handleGetGeography(w, httptest.NewRequest("GET", "/api/geography?range=24h", nil))
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("overview %d %s", w.Code, w.Body.String())
	}
	var overview geography.Overview
	if err := json.Unmarshal(w.Body.Bytes(), &overview); err != nil {
		t.Fatal(err)
	}
	if overview.Totals == nil || overview.Totals.UniqueIPs != 1 || overview.Quality.Unavailable != 1 || strings.Contains(w.Body.String(), "1.1.1.1") {
		t.Fatal("incorrect totals or leaked raw address")
	}
	for _, query := range []string{"range=week", "family=5", "country=de", "range=now&range=24h", "unexpected=1", "location=" + strings.Repeat("x", 161)} {
		w = httptest.NewRecorder()
		s.handleGetGeography(w, httptest.NewRequest("GET", "/api/geography?"+query, nil))
		if w.Code != 400 {
			t.Errorf("%s returned %d", query, w.Code)
		}
	}
	w = httptest.NewRecorder()
	s.handleGetGeographyUsers(w, httptest.NewRequest("GET", "/api/geography/users?snapshot_id="+overview.SnapshotID+"&group_id=unknown:unavailable", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "alice") || strings.Contains(w.Body.String(), "1.1.1.1") {
		t.Fatalf("memberships %d %s", w.Code, w.Body.String())
	}
	if err := s.st.ResetUserIPHistory(""); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.handleGetGeographyUsers(w, httptest.NewRequest("GET", "/api/geography/users?snapshot_id="+overview.SnapshotID+"&group_id=unknown:unavailable", nil))
	if w.Code != 409 || !strings.Contains(w.Body.String(), "geography_snapshot_expired") {
		t.Fatalf("reset %d %s", w.Code, w.Body.String())
	}
	for _, tc := range []struct {
		err    error
		status int
	}{{geography.ErrBusy, 503}, {geography.ErrCapacity, 503}, {geography.ErrTimeout, 504}, {geography.ErrSourceChanged, 409}, {geography.ErrNotFound, 404}} {
		w = httptest.NewRecorder()
		writeGeographyError(w, tc.err)
		if w.Code != tc.status {
			t.Fatal("incorrect error status")
		}
		if tc.err == geography.ErrBusy && w.Header().Get("Retry-After") != "5" {
			t.Fatal("busy Retry-After missing")
		}
	}
	w = httptest.NewRecorder()
	writeGeographyJSON(w, strings.Repeat("x", 256<<10), 256<<10)
	if w.Code != 503 || strings.Contains(w.Body.String(), strings.Repeat("x", 100)) {
		t.Fatal("capacity emitted an oversized body")
	}
}

func TestGeographySettingsStrictRequests(t *testing.T) {
	s := geographyTestServer(t)
	for _, body := range []string{"{}", "null", "{} {}", strings.Repeat(" ", 4097), `{"server_location":{"mode":"hidden","label":"","public_ip":null,"latitude":null,"longitude":null,"unknown":1}}`, `{"server_location":{"mode":"hidden"}}`} {
		w := httptest.NewRecorder()
		s.handlePutGeographySettings(w, httptest.NewRequest("PUT", "/api/settings/geography", strings.NewReader(body)))
		if w.Code != 400 {
			t.Errorf("invalid body returned %d: %s", w.Code, body)
		}
	}
	body := `{"server_location":{"mode":"manual","label":"Telemt","public_ip":null,"latitude":0,"longitude":0}}`
	w := httptest.NewRecorder()
	s.handlePutGeographySettings(w, httptest.NewRequest("PUT", "/api/settings/geography", strings.NewReader(body)))
	if w.Code != 200 {
		t.Fatalf("manual save %d %s", w.Code, w.Body.String())
	}
	settings, err := s.geography.Settings(context.Background())
	if err != nil || settings.ServerLocation.Mode != "manual" {
		t.Fatal("configuration not saved")
	}
}

func TestGeographyAuthAndCSRF(t *testing.T) {
	s := newTestServer(t)
	t.Cleanup(s.geoip.Close)
	t.Cleanup(s.geography.Close)
	h := s.Handler()
	for _, route := range []struct{ method, path string }{{"GET", "/api/geography"}, {"GET", "/api/geography/locations"}, {"GET", "/api/geography/users"}, {"GET", "/api/settings/geography"}, {"PUT", "/api/settings/geography"}} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(route.method, route.path, nil)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Errorf("unprotected %s %s: %d", route.method, route.path, w.Code)
		}
	}
	_, cookie := login(t, h, "admin", testPassword)
	r := httptest.NewRequest("PUT", "/api/settings/geography", nil)
	r.AddCookie(cookie)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	r.Header.Set("Origin", "https://untrusted.example")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-site save = %d", w.Code)
	}
}
