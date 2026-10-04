package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

type geographyDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadline    time.Time
	deadlineErr error
}

func (w *geographyDeadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return w.deadlineErr
}

func geographyRouteTestServer(t *testing.T) (*Server, http.Handler, *http.Cookie) {
	t.Helper()
	s := newTestServer(t)
	t.Cleanup(s.geoip.Close)
	s.geography.Close()
	fixture := geographyTestServer(t)
	s.geography = fixture.geography
	h := s.Handler()
	w, cookie := login(t, h, "admin", testPassword)
	if w.Code != http.StatusNoContent || cookie == nil {
		t.Fatalf("login %d %s", w.Code, w.Body.String())
	}
	return s, h, cookie
}

func TestGeographyRouteWriteDeadline(t *testing.T) {
	for _, tc := range []struct {
		build, want int64
	}{{0, 60}, {1, 60}, {10, 60}, {55, 60}, {56, 61}, {120, 125}} {
		t.Run(fmt.Sprint(tc.build), func(t *testing.T) {
			s, h, cookie := geographyRouteTestServer(t)
			s.cfg.Geography.BuildTimeoutSecs = tc.build
			w := &geographyDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
			r := httptest.NewRequest("GET", "/api/geography?range=24h", nil)
			r.AddCookie(cookie)
			before := time.Now()
			h.ServeHTTP(w, r)
			after := time.Now()
			want := time.Duration(tc.want) * time.Second
			if w.deadline.Before(before.Add(want)) || w.deadline.After(after.Add(want)) {
				t.Fatalf("deadline %v outside [%v, %v]", w.deadline, before.Add(want), after.Add(want))
			}
			if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("overview %d %s", w.Code, w.Body.String())
			}
			var overview geography.Overview
			if err := json.Unmarshal(w.Body.Bytes(), &overview); err != nil || overview.Totals == nil || overview.Totals.UniqueIPs != 1 {
				t.Fatalf("overview contract changed: %v %s", err, w.Body.String())
			}
			other := &geographyDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
			r = httptest.NewRequest("GET", "/api/settings/geography", nil)
			r.AddCookie(cookie)
			h.ServeHTTP(other, r)
			if other.Code != http.StatusOK || !other.deadline.IsZero() {
				t.Fatalf("settings route changed its ordinary deadline: %d %v", other.Code, other.deadline)
			}
		})
	}
}

func TestGeographyWriteDeadlineErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"unsupported", http.ErrNotSupported, http.StatusOK},
		{"wrapped unsupported", fmt.Errorf("wrapper: %w", http.ErrNotSupported), http.StatusOK},
		{"transport failure", errors.New("connection closed"), http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := geographyTestServer(t)
			w := &geographyDeadlineRecorder{ResponseRecorder: httptest.NewRecorder(), deadlineErr: tc.err}
			s.handleGetGeography(w, httptest.NewRequest("GET", "/api/geography?range=24h", nil))
			if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("overview %d %s", w.Code, w.Body.String())
			}
			if tc.status == http.StatusInternalServerError && !strings.Contains(w.Body.String(), `"code":"internal_error"`) {
				t.Fatalf("transport failure envelope: %s", w.Body.String())
			}
		})
	}
}

type delayedGeographyHistory struct {
	geography.HistorySource
	delay time.Duration
}

func (h delayedGeographyHistory) ReadUserIPSnapshot(ctx context.Context, since, now int64) (store.UserIPReadSnapshot, error) {
	timer := time.NewTimer(h.delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return store.UserIPReadSnapshot{}, ctx.Err()
	case <-timer.C:
		return h.HistorySource.ReadUserIPSnapshot(ctx, since, now)
	}
}

func TestGeographyOverviewOutlivesServerWriteTimeout(t *testing.T) {
	s, _, cookie := geographyRouteTestServer(t)
	s.cfg.Geography.BuildTimeoutSecs = 120
	s.geography.Close()
	s.geography = geography.NewService(geography.Dependencies{
		History: delayedGeographyHistory{HistorySource: s.st, delay: 100 * time.Millisecond},
		State:   s.st, BuildTimeout: 120 * time.Second, RequestTimeout: 122 * time.Second,
	})
	t.Cleanup(s.geography.Close)
	httpServer := httptest.NewUnstartedServer(s.Handler())
	httpServer.Config.WriteTimeout = 20 * time.Millisecond
	httpServer.Start()
	t.Cleanup(httpServer.Close)
	r, err := http.NewRequest("GET", httpServer.URL+"/api/geography?range=24h", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(cookie)
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Do(r)
	if err != nil {
		t.Fatalf("delayed overview did not survive ordinary write deadline: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"snapshot_id":`) {
		t.Fatalf("delayed overview %d %s: %v", response.StatusCode, body, err)
	}
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
		w := &geographyDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
		r := httptest.NewRequest(route.method, route.path, nil)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		h.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Errorf("unprotected %s %s: %d", route.method, route.path, w.Code)
		}
		if !w.deadline.IsZero() {
			t.Errorf("unauthenticated request changed deadline for %s %s", route.method, route.path)
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
