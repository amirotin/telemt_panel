package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// newTelemtInfoTestServer builds a logged-in Server backed by tc, with
// cfg.Telemt.ConfigEditMode set so handleTelemtInfo has something
// non-default to echo back.
func newTelemtInfoTestServer(t *testing.T, tc *telemt.Client) (*Server, *http.Cookie) {
	t.Helper()
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{
		Auth:   config.AuthConfig{Username: "admin", PasswordHash: hash},
		Telemt: config.TelemtConfig{ConfigEditMode: "file"},
	}
	st, err := store.NewMemory("")
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	hb := hub.New(hub.Config{}, tc, st)
	t.Cleanup(hb.Close)
	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)

	h := srv.Handler()
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("expected a successful login")
	}
	return srv, cookie
}

// fullFakeTelemtHTTP serves every route GET /api/telemt/info's happy path
// touches: SystemInfo plus each capability probe.
func fullFakeTelemtHTTP(t *testing.T) *telemt.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/system/info":
			fmt.Fprint(w, `{"ok":true,"data":{"version":"3.5.2","target_arch":"x86_64","target_os":"linux",
				"build_profile":"release","process_started_at_epoch_secs":1000,"uptime_seconds":12.5,
				"config_path":"/etc/telemt/telemt.toml","config_hash":"abc","config_reload_count":1},"revision":"r"}`)
		case "/v1/stats/users/quota":
			fmt.Fprint(w, `{"ok":true,"data":{"users":[]},"revision":"r"}`)
		case "/v1/runtime/connections/summary":
			fmt.Fprint(w, `{"ok":true,"data":{"enabled":true},"revision":"r"}`)
		case "/v1/system/reload/0":
			fmt.Fprint(w, `{"ok":true,"data":{"state":"succeeded"},"revision":"r"}`)
		case "/v1/config":
			fmt.Fprint(w, `{"ok":true,"data":{},"revision":"r"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return telemt.New(srv.URL, "")
}

// TestHandleTelemtInfo_ReachableShapeMatchesOpenapi asserts the response
// against api/openapi.yaml schema TelemtInfo's required fields (reachable,
// capabilities) plus the optional ones this handler is supposed to fill in:
// version/arch/os/uptime_seconds from SystemInfo, config_edit_mode from
// config, and all six capability flags.
func TestHandleTelemtInfo_ReachableShapeMatchesOpenapi(t *testing.T) {
	tc := fullFakeTelemtHTTP(t)
	srv, cookie := newTelemtInfoTestServer(t, tc)

	r := httptest.NewRequest("GET", "/api/telemt/info", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var got telemtInfoView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.Reachable {
		t.Fatal("reachable = false, want true")
	}
	if got.Version != "3.5.2" || got.Arch != "x86_64" || got.OS != "linux" || got.UptimeSeconds != 12.5 {
		t.Errorf("system fields = %+v, want version/arch/os/uptime_seconds from SystemInfo", got)
	}
	if got.ConfigPath != "/etc/telemt/telemt.toml" {
		t.Errorf("config_path = %q", got.ConfigPath)
	}
	if got.ConfigEditMode != "file" {
		t.Errorf("config_edit_mode = %q, want file (from config)", got.ConfigEditMode)
	}
	want := telemtCapabilitiesView{Quota: true, RuntimeEdge: true, ReloadAPI: true, ConfigAPI: true, UserEnableDisable: true, RotateSecret: true}
	if got.Capabilities != want {
		t.Errorf("capabilities = %+v, want %+v", got.Capabilities, want)
	}
	if got.Hint != "" {
		t.Errorf("hint = %q, want empty on a reachable response", got.Hint)
	}

	// Re-decode as a generic map to prove the required openapi keys are
	// actually present on the wire (not just zero-valued and omitted by a
	// stray omitempty).
	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw: %v", err)
	}
	for _, key := range []string{"reachable", "capabilities"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("response missing required key %q", key)
		}
	}
}

// TestHandleTelemtInfo_ZeroUptimeIsSentNotOmitted covers fix 3: a
// fresh-restart uptime_seconds:0 is a real value, not "no data" — omitempty
// on that field would silently drop it, indistinguishable on the wire from
// an old Telemt build that never sent it at all.
func TestHandleTelemtInfo_ZeroUptimeIsSentNotOmitted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/system/info":
			fmt.Fprint(w, `{"ok":true,"data":{"version":"3.5.2","target_arch":"x86_64","target_os":"linux",
				"build_profile":"release","process_started_at_epoch_secs":1000,"uptime_seconds":0,
				"config_path":"/etc/telemt/telemt.toml","config_hash":"abc","config_reload_count":1},"revision":"r"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	tc := telemt.New(srv.URL, "")

	panelSrv, cookie := newTelemtInfoTestServer(t, tc)

	r := httptest.NewRequest("GET", "/api/telemt/info", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	panelSrv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body)
	}
	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw: %v", err)
	}
	v, ok := raw["uptime_seconds"]
	if !ok {
		t.Fatal("uptime_seconds key missing, want it present even when 0")
	}
	if v != float64(0) {
		t.Errorf("uptime_seconds = %v, want 0", v)
	}
}

// TestHandleTelemtInfo_UnreachableHintNamesAPI is the acceptance test's
// core assertion in isolation: an unreachable Telemt must report
// reachable:false with a hint naming the Telemt API (telemt.url), never
// files or config paths — conflating "no file access" with "Telemt API
// unreachable" is exactly the v0 failure the API-only degradation
// invariant exists to prevent. capabilities must still be present (all
// false, the Caps zero value) since openapi marks it required.
func TestHandleTelemtInfo_UnreachableHintNamesAPI(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "") // nothing listens here
	srv, cookie := newTelemtInfoTestServer(t, tc)

	r := httptest.NewRequest("GET", "/api/telemt/info", nil)
	r.AddCookie(cookie)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (unreachable is reported in the body, not an HTTP error): %s", w.Code, w.Body)
	}
	var got telemtInfoView
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Reachable {
		t.Fatal("reachable = true, want false")
	}
	if got.Hint == "" {
		t.Fatal("hint is empty, want an actionable diagnostic")
	}
	lower := strings.ToLower(got.Hint)
	if !strings.Contains(lower, "api") && !strings.Contains(lower, "telemt.url") {
		t.Errorf("hint = %q, want it to name the Telemt API", got.Hint)
	}
	for _, word := range []string{"file", "config path", "config_path"} {
		if strings.Contains(lower, word) {
			t.Errorf("hint = %q, must not mention files/config paths (that's GET /api/host's territory)", got.Hint)
		}
	}
	if got.Capabilities != (telemtCapabilitiesView{}) {
		t.Errorf("capabilities = %+v, want the zero value when unreachable", got.Capabilities)
	}
}

func TestHandleTelemtInfo_RequiresSession(t *testing.T) {
	tc := telemt.New("http://127.0.0.1:1", "")
	srv, _ := newTelemtInfoTestServer(t, tc)

	r := httptest.NewRequest("GET", "/api/telemt/info", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}
