package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/amirotin/telemt_panel/internal/auth"
	"github.com/amirotin/telemt_panel/internal/config"
	"github.com/amirotin/telemt_panel/internal/host"
	"github.com/amirotin/telemt_panel/internal/hub"
	"github.com/amirotin/telemt_panel/internal/store"
	"github.com/amirotin/telemt_panel/internal/telemt"
)

// TestAPIOnlyDegradation is the executable form of the panel's binding
// owner invariant: the absence of file access, host privileges, an init
// system, or even a reachable Telemt must never prevent the panel from
// starting or break API-backed features. It boots the full httpapi.Server
// (via New, not a stripped-down test helper) in the worst-case environment
// this milestone can produce — unreachable Telemt, no init system, no log
// source, degraded privileges, no on-disk state mirror — and asserts every
// surface degrades cleanly instead of panicking or hanging.
//
// This test must stay green forever; do not delete or weaken it without an
// explicit owner ruling superseding the invariant it encodes.
func TestAPIOnlyDegradation(t *testing.T) {
	hash, err := auth.HashPassword(testPassword)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	cfg := &config.Config{
		// Unreachable Telemt: nothing listens on this port.
		Telemt: config.TelemtConfig{URL: "http://127.0.0.1:1", ConfigEditMode: "api"},
		Auth:   config.AuthConfig{Username: "admin", PasswordHash: hash},
		// Mirror path "": state stays in RAM only, no on-disk mirror.
		DataDir: "",
		Subpage: config.SubpageConfig{Enabled: true, Secret: "test-subpage-secret"},
		Host: config.HostConfig{
			ServiceManager: "none",
			TelemtService:  "telemt",
			PanelService:   "telemt-panel",
		},
		Privileges: config.PrivilegesConfig{Mode: "auto", AgentSocket: "/nonexistent/agent.sock"},
	}

	tc := telemt.New(cfg.Telemt.URL, cfg.Telemt.AuthHeader)
	st, err := store.NewMemory(cfg.DataDir)
	if err != nil {
		t.Fatalf("store.NewMemory: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	hb := hub.New(hub.Config{}, tc)
	t.Cleanup(hb.Close)

	// New() itself probes the real host for its ServiceManager/LogSource/
	// Runner — booting cleanly under that real probing is already part of
	// what this test proves. The fields are then pinned to the brief's
	// worst case explicitly below, the same way host_handler_test.go's
	// newHostTestServer swaps them for deterministic fakes: this package's
	// tests are allowed to reach into Server's unexported fields directly.
	srv := New(cfg, tc, st, hb, "test")
	t.Cleanup(srv.limiter.Stop)
	t.Cleanup(srv.subLimiter.Stop)
	srv.svcMgr = host.NewNone()
	srv.logSrc = host.NewNoneLog()
	srv.privilegesMode = host.PrivilegesModeDegraded

	h := srv.Handler()

	// GET /api/health: must be reachable with no session and no Telemt.
	r := httptest.NewRequest("GET", "/api/health", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/health = %d, want 200: %s", w.Code, w.Body)
	}

	// Login must succeed (it only checks the local password hash, never
	// Telemt) and the resulting session must actually authenticate a
	// subsequent request.
	_, cookie := login(t, h, "admin", testPassword)
	if cookie == nil {
		t.Fatal("login failed even though Telemt is irrelevant to authentication")
	}
	r = httptest.NewRequest("GET", "/api/auth/me", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/auth/me = %d, want 200 (session must work): %s", w.Code, w.Body)
	}

	// GET /api/host: every cap false, every hint present and non-empty —
	// the UI rule is "disabled with a manual command", never a dead
	// control with no explanation.
	r = httptest.NewRequest("GET", "/api/host", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/host = %d, want 200: %s", w.Code, w.Body)
	}
	var hostInfo hostInfo
	if err := json.Unmarshal(w.Body.Bytes(), &hostInfo); err != nil {
		t.Fatalf("decode /api/host: %v", err)
	}
	if hostInfo.Caps.RestartTelemt || hostInfo.Caps.RestartPanel || hostInfo.Caps.LogTail || hostInfo.Caps.LogStream || hostInfo.Caps.SelfUpdate {
		t.Errorf("/api/host caps = %+v, want all false", hostInfo.Caps)
	}
	for _, key := range []string{"restart_telemt", "restart_panel", "log_tail", "log_stream", "self_update"} {
		if hint := hostInfo.ManualCommands[key]; hint == "" {
			t.Errorf("/api/host manual_commands[%q] is empty, want a non-empty manual hint", key)
		}
	}

	// GET /api/telemt/info: reachable:false with a hint that names the
	// API, never files or config paths — the exact conflation the
	// invariant exists to prevent (the v0 failure mode).
	r = httptest.NewRequest("GET", "/api/telemt/info", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/telemt/info = %d, want 200: %s", w.Code, w.Body)
	}
	var info telemtInfoView
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
		t.Fatalf("decode /api/telemt/info: %v", err)
	}
	if info.Reachable {
		t.Error("/api/telemt/info reachable = true, want false")
	}
	lowerHint := strings.ToLower(info.Hint)
	if !strings.Contains(lowerHint, "api") && !strings.Contains(lowerHint, "telemt.url") {
		t.Errorf("/api/telemt/info hint = %q, want it to name the Telemt API", info.Hint)
	}
	for _, word := range []string{"file", "config path", "config_path"} {
		if strings.Contains(lowerHint, word) {
			t.Errorf("/api/telemt/info hint = %q, must not mention files/config paths", info.Hint)
		}
	}

	// GET /api/users: a clean 502 telemt_unreachable, not a panic and not
	// a silent empty list masquerading as success.
	r = httptest.NewRequest("GET", "/api/users", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("GET /api/users = %d, want 502: %s", w.Code, w.Body)
	}
	var usersErr struct{ Code string }
	if err := json.Unmarshal(w.Body.Bytes(), &usersErr); err != nil {
		t.Fatalf("decode /api/users error: %v", err)
	}
	if usersErr.Code != "telemt_unreachable" {
		t.Errorf("/api/users error code = %q, want telemt_unreachable", usersErr.Code)
	}

	// GET /api/logs/tail: 501, no LogSource capability at all.
	r = httptest.NewRequest("GET", "/api/logs/tail?service=telemt", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotImplemented {
		t.Fatalf("GET /api/logs/tail = %d, want 501: %s", w.Code, w.Body)
	}

	// /sub/{token}: the route is registered (subpage enabled with a
	// secret) and must serve the uniform 404 without crashing, even though
	// the token index can never refresh from an unreachable Telemt.
	r = httptest.NewRequest("GET", "/sub/does-not-exist", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET /sub/{token} = %d, want 404: %s", w.Code, w.Body)
	}

	// GET /api/updates: still lists (degraded — GitHub/Telemt both
	// unreachable in this environment), never panics.
	r = httptest.NewRequest("GET", "/api/updates", nil)
	r.AddCookie(cookie)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/updates = %d, want 200: %s", w.Code, w.Body)
	}
	var updates updatesStatusView
	if err := json.Unmarshal(w.Body.Bytes(), &updates); err != nil {
		t.Fatalf("decode /api/updates: %v", err)
	}
	if len(updates.Targets) != 2 {
		t.Errorf("/api/updates targets = %d, want 2 (telemt, panel) even when both are degraded", len(updates.Targets))
	}
}
